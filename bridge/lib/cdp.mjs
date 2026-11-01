/**
 * CDP helpers shared across the bridge.
 *
 * Thin wrappers over the raw DevTools Protocol so callers never touch
 * WebSocket frames or the CDP session lifecycle directly.
 *
 * @module gemini-web-bridge/lib/cdp
 */

import { createConnection } from 'node:net'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------

/**
 * Spawn a Chromium-family browser with remote debugging enabled.
 *
 * Returns the ChildProcess. The caller is responsible for killing it.
 */
export function launchBrowser({ executable, userDataDir, port, headless, extraArgs = [] }) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    // 这三个不是优化项，是**必需项**。
    //
    // 老配置用 `--window-position=-32000,-32000` 把窗口挪出屏幕，Chromium 于是
    // 认为标签页被遮挡/不可见（实测 document.visibilityState === 'hidden'），
    // 后台节流随即生效：页内 fetch 连同源请求都发不出去，同步 XHR 直接
    // NetworkError，而 evaluate 依然正常。
    //
    // 现象是最难查的那一类：cookie 抓得到、SNlM0e 抓得到、bl 正常、页面
    // readyState 是 complete，只有真正的 StreamGenerate 一直挂到超时。
    //
    // 强制写在基础参数里而不是交给 browser.args，因为漏配一次就是全线卡死。
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ]
  if (headless) args.push('--headless=new')
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)
  // 调用方显式给的参数优先（同名的会覆盖前面的）。
  for (const a of extraArgs) args.push(a)

  return spawn(executable ?? 'chrome', args, {
    detached: false,
    stdio: 'ignore',
  })
}

/**
 * Poll until the DevTools HTTP endpoint responds, or timeout.
 */
export async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      })
      if (r.ok) return
    } catch { /* keep polling */ }
    await sleep(400)
  }
  throw new Error(`DevTools did not become ready on port ${port} within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// CDP session
// ---------------------------------------------------------------------------

class CDPSession extends EventEmitter {
  #ws
  #seq = 0
  #pending = new Map()
  /**
   * Raw byte buffer. WebSocket frames are length-prefixed, so we must keep bytes
   * (not decoded text) — a multi-byte UTF-8 character or a split payload would
   * be corrupted by per-chunk toString().
   */
  #buf = Buffer.alloc(0)
  /** Reassembles fragmented messages (opcode 0 continuation frames). */
  #fragments = []

  constructor(ws) {
    super()
    this.#ws = ws
    ws.on('data', chunk => this.#onData(chunk))
    ws.on('close', () => {
      for (const { reject } of this.#pending.values()) {
        reject(new Error('CDP socket closed'))
      }
      this.#pending.clear()
      this.emit('close')
    })
    ws.on('error', e => this.emit('error', e))
  }

  /**
   * Parse the WebSocket wire format.
   *
   * The previous implementation scanned the raw stream for '{' … '}' and counted
   * brace depth. That cannot work for this protocol: a single CDP reply carries
   * a JSON string whose VALUE contains braces (Gemini's f.req payloads are
   * nested escaped JSON), so the depth counter desynchronises, no message is
   * ever cut, the pending promise never settles and Runtime.evaluate hangs
   * forever. Small replies (token scrapes) happened to contain no braces inside
   * strings and therefore worked — which is exactly why generation looked like
   * a hang while token reads looked fine.
   */
  #onData(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk

    for (;;) {
      if (this.#buf.length < 2) return
      const b0 = this.#buf[0]
      const b1 = this.#buf[1]
      const fin = (b0 & 0x80) !== 0
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (len === 126) {
        if (this.#buf.length < 4) return
        len = this.#buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.#buf.length < 10) return
        const hi = this.#buf.readUInt32BE(2)
        const lo = this.#buf.readUInt32BE(6)
        len = hi * 0x100000000 + lo
        offset = 10
      }

      let maskKey = null
      if (masked) {
        if (this.#buf.length < offset + 4) return
        maskKey = this.#buf.subarray(offset, offset + 4)
        offset += 4
      }

      if (this.#buf.length < offset + len) return  // wait for the rest
      let payload = this.#buf.subarray(offset, offset + len)
      this.#buf = this.#buf.subarray(offset + len)

      if (maskKey) {
        // Server->client frames are never masked per RFC 6455, but unmask
        // defensively so a misbehaving peer cannot corrupt the payload.
        const out = Buffer.allocUnsafe(payload.length)
        for (let i = 0; i < payload.length; i++) {
          out[i] = payload[i] ^ maskKey[i % 4]
        }
        payload = out
      }

      if (opcode === 0x8) {          // close
        this.#ws.destroy()
        return
      }
      if (opcode === 0x9) {          // ping -> pong
        this.#writeFrame(0xA, payload)
        continue
      }
      if (opcode === 0xA) continue   // pong, ignore

      if (opcode === 0x0) {          // continuation
        this.#fragments.push(payload)
        if (!fin) continue
        payload = Buffer.concat(this.#fragments)
        this.#fragments = []
      } else {
        this.#fragments = fin ? [] : [payload]
        if (!fin) continue
      }

      this.#dispatch(payload.toString('utf8'))
    }
  }

  #dispatch(text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }  // non-JSON control frame
    if (msg.id != null) {
      const entry = this.#pending.get(msg.id)
      if (!entry) return
      this.#pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
      return
    }
    this.emit('event', msg.method, msg.params)
  }

  /**
   * Write one masked client frame.
   *
   * RFC 6455 requires client frames to be masked, and the mask key must be
   * applied per byte. The old code wrote "mask = 0x00" which is technically a
   * valid no-op mask, but it also only handled two length classes and produced
   * a malformed header for payloads >= 64KB (the 64-bit length form was never
   * written), silently breaking large Runtime.evaluate calls.
   */
  #writeFrame(opcode, payload) {
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.allocUnsafe(6)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | len
      header.writeUInt32BE(0, 2)
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(8)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
      header.writeUInt32BE(0, 4)
    } else {
      header = Buffer.allocUnsafe(14)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2)
      header.writeUInt32BE(len >>> 0, 6)
      header.writeUInt32BE(0, 10)
    }
    this.#ws.write(Buffer.concat([header, payload]))
  }

  send(method, params = {}) {
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#writeFrame(0x1, Buffer.from(JSON.stringify({ id, method, params })))
    })
  }

  close() { this.#ws.destroy() }
}

/**
 * Attach to a page in a running DevTools instance.
 *
 * Target selection matters more than it looks. `list.find(t => t.type === 'page')`
 * picks whichever page Chromium happens to list first, and in a real browser
 * profile that is usually NOT the site you want: measured on a live profile the
 * first page target was `chrome-extension://…/install.html`. Attaching there
 * made every token scrape and every generateRaw silently run against an
 * extension page — cookies and `SNlM0e` scraped fine (the extension page still
 * shares the profile) while the actual StreamGenerate request went nowhere and
 * the call hung until timeout.
 *
 * So: prefer a page whose URL starts with `preferOrigin`; fall back to the first
 * page only when nothing matches, so a fresh profile that has not navigated yet
 * still works.
 *
 * @param {number} port
 * @param {{preferOrigin?: string}} [opts]
 */
export async function attachFirstPage(port, opts = {}) {
  const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())
  const pages = list.filter(t => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
  const want = typeof opts.preferOrigin === 'string' ? opts.preferOrigin.replace(/\/$/, '') : ''
  const target = (want ? pages.find(t => String(t.url ?? '').startsWith(want)) : undefined)
    ?? pages[0]
  if (!target) throw new Error('no page target found in DevTools')
  const wsUrl = target.webSocketDebuggerUrl
  const url = new URL(wsUrl)

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: url.hostname, port: Number(url.port) || 80 })
    const key = Buffer.from(Math.random().toString(36)).toString('base64')
    sock.on('connect', () => {
      sock.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `\r\n`
      )
    })

    let upgraded = false
    let headerBuf = ''
    sock.on('data', chunk => {
      if (!upgraded) {
        headerBuf += chunk.toString('binary')
        if (headerBuf.includes('\r\n\r\n')) {
          upgraded = true
          const headerEnd = headerBuf.indexOf('\r\n\r\n') + 4
          const rest = Buffer.from(headerBuf.slice(headerEnd), 'binary')
          const session = new CDPSession(sock)
          if (rest.length) sock.emit('data', rest)
          resolve(session)
        }
      }
    })
    sock.on('error', reject)
  })
}

/**
 * Run JavaScript in the page and return the result.
 */
export async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate threw')
  }
  return result?.result?.value
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
