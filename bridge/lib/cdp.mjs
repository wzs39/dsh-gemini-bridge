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
  ]
  if (headless) args.push('--headless=new')
  if (userDataDir) args.push(`--user-data-dir=${userDataDir}`)
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
  #buf = ''

  constructor(ws) {
    super()
    this.#ws = ws
    ws.on('data', chunk => this.#onData(chunk.toString()))
    ws.on('close', () => this.emit('close'))
    ws.on('error', e => this.emit('error', e))
  }

  #onData(raw) {
    this.#buf += raw
    // WebSocket frames are length-prefixed in our simple implementation;
    // we rely on the fact that Node's http module + CDP uses chunked HTTP upgrade.
    // A robust parser is not needed here: the CDP server sends complete JSON frames.
    // We look for complete JSON objects by counting braces.
    let start = 0
    while (true) {
      const i = this.#buf.indexOf('{', start)
      if (i < 0) { this.#buf = ''; break }
      let depth = 0, j = i
      for (; j < this.#buf.length; j++) {
        if (this.#buf[j] === '{') depth++
        else if (this.#buf[j] === '}') { depth--; if (depth === 0) break }
      }
      if (depth !== 0) { this.#buf = this.#buf.slice(i); break }
      const text = this.#buf.slice(i, j + 1)
      start = j + 1
      try {
        const msg = JSON.parse(text)
        if (msg.id != null) {
          const entry = this.#pending.get(msg.id)
          if (entry) {
            this.#pending.delete(msg.id)
            if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
            else entry.resolve(msg.result)
          }
        } else {
          this.emit('event', msg.method, msg.params)
        }
      } catch { /* malformed frame, skip */ }
      if (start >= this.#buf.length) { this.#buf = ''; break }
    }
  }

  send(method, params = {}) {
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      const frame = JSON.stringify({ id, method, params })
      // Minimal WS framing for a text frame ≤ 64KB
      const payload = Buffer.from(frame)
      const len = payload.length
      let header
      if (len < 126) {
        header = Buffer.from([0x81, 0x80 | len, 0, 0, 0, 0])
      } else {
        header = Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff, 0, 0, 0, 0])
      }
      // XOR with 0x00 mask (key = [0,0,0,0]) = no-op
      this.#ws.write(Buffer.concat([header, payload]))
    })
  }

  close() { this.#ws.destroy() }
}

/**
 * Attach to the first available page in a running DevTools instance.
 *
 * Returns an object with a `.send(method, params)` method and a `.close()`.
 */
export async function attachFirstPage(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())
  const target = list.find(t => t.type === 'page')
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
