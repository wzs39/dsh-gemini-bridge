/**
 * Session custody: the browser holds the credentials, Node spends awareness of them.
 *
 * Gemini web authenticates with Google session cookies (__Secure-1PSID, __Secure-1PSIDTS)
 * plus a short-lived CSRF token (SNlM0e) and a build label (bl) scraped from the app HTML.
 *
 * The session-level secrets must come from an authenticated browser.  The CSRF token and
 * build label are short-lived but public -- they live in the page HTML and rotate on each
 * deployment, so they must be re-read before every generation to avoid 403s from a stale
 * token.  The cookies are long-lived.
 *
 * Transport note: ALL upstream calls (scrape + generation) are issued from inside the
 * browser page via CDP Runtime.evaluate.  This ensures the TLS ClientHello, HTTP/2 settings
 * and Sec-CH-UA headers match a real Chromium session.  Google correlates the TLS
 * fingerprint to the WAF/bot-detection layer; a Node fetch with the right cookies but the
 * wrong TLS stack reliably produces 403s on the first automated-looking request.
 *
 * @module gemini-web-bridge/lib/session
 */

import fs from 'node:fs'
import path from 'node:path'
import { attachFirstPage, launchBrowser, waitForDevTools, evaluate, sleep } from './cdp.mjs'
import { READ_PILL_JS, setModeExpression, labelMatches, labelForHash } from './modes.mjs'

/** Gemini endpoints */
const APP_PATH = '/app'
const STREAM_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'

export class Session {
  #config
  #credentials = null        // { cookies, snlm0e, bl, userAgent, harvestedAt }
  #pageTokens = null         // { snlm0e, bl, scrapedAt } – short-lived, refreshed per call
  #harvesting = null
  /** Mode (16-hex id) we last successfully pushed to the account, if any. */
  #appliedModeHash = null
  /** Last pill label read from the page; exposed for /health. */
  #pillLabel = null
  /** Attached CDP page session, kept alive so completions run inside it. */
  #page = null
  #browserChild = null

  constructor(config) {
    this.#config = config
  }

  get ready() {
    return this.#credentials !== null
  }

  describe() {
    if (!this.#credentials) return { ready: false }
    const { cookieNames, userAgent, harvestedAt } = this.#credentials
    const tokenAge = this.#pageTokens
      ? Math.round((Date.now() - this.#pageTokens.scrapedAt) / 1000)
      : null
    return {
      ready: true,
      cookies: cookieNames,
      userAgent,
      harvestedAt,
      ageSeconds: Math.round((Date.now() - harvestedAt) / 1000),
      pageTokenAge: tokenAge,
      blSample: this.#pageTokens?.bl?.slice(0, 30) ?? null,
      // `mode` is what we actually PUSHED (authoritative for behaviour), while
      // `pillLabel` is what the composer button still renders. They disagree
      // after a switch until the page reloads, because the SPA does not repaint
      // the button on an out-of-band RPC. Reporting only the pill would show a
      // stale "Flash-Lite" for an account that is genuinely serving Pro.
      mode: this.#appliedModeHash === null ? this.#pillLabel : (labelForHash(this.#appliedModeHash) ?? this.#pillLabel),
      pillLabel: this.#pillLabel,
      appliedModeHash: this.#appliedModeHash,
    }
  }

  /** Read the composer pill ("Pro" / "Flash-Lite" / …) from the live page. */
  async readMode() {
    await this.#ensurePage()
    const label = await evaluate(this.#page, READ_PILL_JS).catch(() => null)
    if (typeof label === 'string' && label !== '') this.#pillLabel = label
    return this.#pillLabel
  }

  /**
   * Put the account into a composer mode.
   *
   * The mode is ACCOUNT STATE, not a per-request parameter — that is the whole
   * finding behind "网页端没办法切换模型".
   *
   * The pill CANNOT be the completion signal within one page session: after a
   * successful L5adhe the server state changes but the SPA does not repaint the
   * composer button until a reload (measured: ACK `[1]`, pill still "Flash-Lite",
   * and after Page.navigate the pill reads "Pro"). So "pill does not match" is
   * NOT proof the switch failed. Treating it as failure re-sent the RPC on every
   * request, which is both wasteful and the exact burst shape we avoid.
   *
   * The completion signal is therefore: this session already pushed this hash
   * (`#appliedModeHash`), or the RPC acknowledged it with `[1]`. The pill is
   * reported for /health and only used to SKIP an unnecessary RPC when it agrees.
   *
   * @returns {Promise<{ok: boolean, wanted: string|null, pill: string|null,
   *                    ack: string|null, changed: boolean}>}
   */
  async applyMode(mode, { thinkingLevel = null } = {}) {
    const result = { ok: true, wanted: null, pill: null, ack: null, changed: false }
    if (!mode || typeof mode.hash !== 'string' || mode.hash === '') return result  // "leave as-is"
    result.wanted = mode.label

    // Already pushed in this process and nothing external could have moved it.
    if (this.#appliedModeHash === mode.hash) {
      result.pill = this.#pillLabel
      return result
    }

    await this.#ensurePage()
    const pill = await this.readMode()
    result.pill = pill
    if (labelMatches(pill, mode.label)) {
      // Read-back agrees: no RPC needed (first request after a restart usually
      // lands here when the account was already on the wanted mode).
      this.#appliedModeHash = mode.hash
      return result
    }

    let raw
    try {
      raw = await evaluate(this.#page, setModeExpression(mode.hash, thinkingLevel))
    } catch (error) {
      result.ok = false
      result.error = String(error?.message ?? error)
      return result
    }

    let reply = null
    try {
      reply = typeof raw === 'string' ? JSON.parse(raw) : raw
    } catch { /* non-JSON reply: treated as "no ack" below */ }

    if (reply?.error) {
      result.ok = false
      result.error = reply.error
      return result
    }
    result.ack = reply?.ack ?? null

    // "[[]]" is the documented "rejected" ACK shape (unknown hash / not allowed);
    // "[1]" is success. A 200 alone proves nothing either way.
    if (typeof result.ack === 'string' && result.ack.replace(/\s/g, '') === '[[]]') {
      result.ok = false
      result.error = 'mode rejected by upstream'
      return result
    }

    this.#appliedModeHash = mode.hash
    result.changed = true
    return result
  }

  /** True when the CSRF token is old enough that the next call should scrape fresh. */
  tokensStale() {
    if (!this.#pageTokens) return true
    // SNlM0e is tied to a page load; pages are refreshed by the browser periodically.
    // Treat tokens older than 20 min as stale -- re-scrape is cheap (one GET).
    return Date.now() - this.#pageTokens.scrapedAt > 20 * 60 * 1000
  }

  /** True when credentials need a full re-harvest (cookie expiry). */
  needsRefresh() {
    if (!this.#credentials) return true
    return Date.now() - this.#credentials.harvestedAt > this.#config.behaviour.tokenTtlMs
  }

  loadPersisted() {
    const file = this.#config.paths.state
    if (!fs.existsSync(file)) return false
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      const creds = saved.credentials
      if (!creds?.cookieHeader) return false
      if (Date.now() - creds.harvestedAt > this.#config.behaviour.tokenTtlMs) return false
      this.#credentials = creds
      return true
    } catch {
      return false
    }
  }

  #persist() {
    const file = this.#config.paths.state
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ credentials: this.#credentials }, null, 2))
  }

  invalidate() {
    this.#credentials = null
    this.#pageTokens = null
  }

  /**
   * Ensure a browser is running and we have a live CDP page attached.
   *
   * Called once at startup (from serve.mjs) and again if the page session closes.
   */
  async ensureBrowser() {
    const { port, executable, headless, args, userDataDir } = this.#config.browser
    const live = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    }).then(r => r.ok).catch(() => false)

    if (!live) {
      if (!executable) {
        throw new Error(
          `no browser on port ${port} and browser.executable is not configured. ` +
          `Run \`node bin/login.mjs\` first.`,
        )
      }
      this.#browserChild = launchBrowser({ executable, userDataDir, port, headless, extraArgs: args })
      await waitForDevTools(port, 30000)
    }

    // 同 #doHarvest：优先连 gemini 页面，别被排在前面的扩展页抢走。
    this.#page = await attachFirstPage(port, { preferOrigin: this.#config.upstream.origin })
    this.#page.on('close', () => { this.#page = null })
  }

  /**
   * Re-attach if the page was closed or navigated away.
   */
  async #ensurePage() {
    if (this.#page) return
    await this.ensureBrowser()
  }

  /**
   * Harvest cookies from the live browser via CDP.
   *
   * Concurrent callers share one harvest so we don't open multiple browsers.
   */
  async harvest({ force = false } = {}) {
    if (this.#credentials && !force) return this.#credentials
    if (this.#harvesting) return this.#harvesting
    this.#harvesting = this.#doHarvest().finally(() => { this.#harvesting = null })
    return this.#harvesting
  }

  async #doHarvest() {
    const { port, executable, headless, args, userDataDir } = this.#config.browser
    const { origin } = this.#config.upstream

    let page = null
    let ownChild = null
    try {
      const live = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1000),
      }).then(r => r.ok).catch(() => false)

      if (!live) {
        if (!executable) throw new Error('no browser running and browser.executable not set')
        ownChild = launchBrowser({ executable, userDataDir, port, headless, extraArgs: args })
        await waitForDevTools(port, 30000)
      }

      // 目标页必须优先选 gemini 域名下的那个：真实 profile 里 Chromium 列在
      // 前面的往往是扩展页（实测第一个 page 是 chrome-extension://…/install.html）。
      // 连到扩展页时 cookie 与 SNlM0e 照样抓得到（同 profile 共享），但真正的
      // StreamGenerate 请求发不出去，表现为一直挂到超时。
      page = await attachFirstPage(port, { preferOrigin: origin })

      // Navigate to app if not already there.
      const here = await evaluate(page, 'location.origin')
      if (here !== origin) {
        await page.send('Page.navigate', { url: `${origin}${APP_PATH}` })
        await this.#waitForOrigin(page, origin)
      }

      const credentials = await this.#readCredentials(page, origin)
      if (!credentials) {
        throw new Error(
          'not signed in. Run `node bin/login.mjs` once and complete the Google sign-in.',
        )
      }

      this.#credentials = credentials
      this.#persist()
      // Keep the page alive for completions (it is already attached).
      this.#page = page
      page = null  // do not close in finally
      return credentials
    } finally {
      if (page) page.close()
      // Only kill a browser we launched; if it was already running, leave it.
      if (ownChild) {
        ownChild.kill()
        await sleep(1000)
      }
    }
  }

  async #waitForOrigin(page, origin) {
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const at = await evaluate(page, 'location.origin').catch(() => null)
      if (at === origin) { await sleep(1200); return }
      await sleep(300)
    }
    throw new Error(`page did not reach ${origin}`)
  }

  async #readCredentials(page, origin) {
    const hostname = new URL(origin).hostname
    const { cookies } = await page.send('Network.getAllCookies')
    const relevant = cookies.filter(c => {
      const h = c.domain.replace(/^\./, '')
      return hostname.endsWith(h) || h.endsWith(hostname)
    })
    if (relevant.length === 0) return null

    // Check for the primary session cookie.
    const hasPSID = relevant.some(c => c.name === '__Secure-1PSID')
    if (!hasPSID) return null

    const cookieHeader = relevant.map(c => `${c.name}=${c.value}`).join('; ')
    const cookieNames = relevant.map(c => c.name)
    const userAgent = await evaluate(page, 'navigator.userAgent')

    return {
      cookieHeader,
      cookieNames,
      userAgent,
      harvestedAt: Date.now(),
    }
  }

  /**
   * Scrape the current CSRF token (SNlM0e) and build label (bl) from the Gemini page.
   *
   * This is issued from inside the browser (CDP Runtime.evaluate + fetch) so the request
   * carries the real browser TLS fingerprint and all cookies automatically.
   */
  async scrapePageTokens() {
    await this.#ensurePage()
    const origin = this.#config.upstream.origin

    // Make sure the page is on gemini.
    const here = await evaluate(this.#page, 'location.origin').catch(() => null)
    if (here !== origin) {
      await this.#page.send('Page.navigate', { url: `${origin}${APP_PATH}` })
      await this.#waitForOrigin(this.#page, origin)
    }

    // PRIMARY: WIZ_global_data on the live page.
    //
    // This is the authoritative source. Scraping the fetched HTML instead is
    // fragile in two measured ways:
    //   - "FdrFJe" appears multiple times in the document; taking the first hit
    //     yields a bare number like "-7730566936813324387" instead of the real
    //     build label "boq_gemini-web-uiserver_20261029.22_p0", and the request
    //     then hangs instead of failing loudly.
    //   - the tokens are refreshed in-place by the SPA, so the live globals are
    //     strictly fresher than any HTML we could re-fetch.
    const wiz = await evaluate(this.#page, `
      (() => {
        const w = window.WIZ_global_data || null;
        if (!w) return null;
        return JSON.stringify({
          sn: w.SNlM0e || null,
          bl: w.cfb2h || w.FdrFJe || null,
        });
      })()
    `).catch(() => null)

    if (wiz) {
      try {
        const parsed = JSON.parse(wiz)
        if (parsed.sn) {
          this.#pageTokens = {
            snlm0e: parsed.sn,
            bl: parsed.bl ?? '',
            scrapedAt: Date.now(),
          }
          return this.#pageTokens
        }
      } catch { /* fall through to HTML scrape */ }
    }

    // FALLBACK: re-fetch the app page and parse it. Kept for the case where the
    // globals are not populated yet (very early after navigation).
    const result = await evaluate(this.#page, `
      (async () => {
        const r = await fetch('${origin}${APP_PATH}', {
          headers: { accept: 'text/html' },
          credentials: 'include',
        });
        return r.ok ? r.text() : null;
      })()
    `)

    if (!result) throw new Error('scrape returned null -- cookies may be expired')

    // SNlM0e is "<22-char id>:<epoch millis>" — the colon is part of the token.
    // A [\w\-_]+ class silently fails on it, and the failure message then claims
    // "session expired" even though the session is perfectly fine (measured:
    // value "AIaPT3O53kHzJApYsqufSVbxr7aP:1793564141603", 42 chars).
    // Match the quoted string as a whole instead of guessing its alphabet.
    const snlm0eMatch = result.match(/"SNlM0e":"([^"]+)"/)
    // Build label must be the "boq_gemini-web-..." form; a bare digit run is the
    // wrong field. (?:...) keeps the capture on the right group.
    const blMatch = result.match(/"FdrFJe":"((?:boq_|prod-)[^"]+)"/)
      ?? result.match(/"cfb2h":"([^"]+)"/)
      ?? result.match(/[?&]bl=(boq_[^"&]+)/)

    if (!snlm0eMatch) {
      // The page was probably a login redirect.
      throw new Error('SNlM0e not found -- session expired; run `node bin/login.mjs`')
    }

    this.#pageTokens = {
      snlm0e: snlm0eMatch[1],
      bl: blMatch?.[1] ?? '',
      scrapedAt: Date.now(),
    }
    return this.#pageTokens
  }

  /**
   * Issue a streaming generation request from inside the browser page.
   *
   * Returns the raw response text (with the )]}' prefix still on it).
   * The entire round trip happens over the browser's fetch(), so the TLS
   * fingerprint, HTTP/2 settings and automatic cookie injection all come
   * from Chromium for free.
   */
  async generateRaw({ prompt, conversationId = '', responseId = '', choiceId = '', timeoutMs = 120000 }) {
    await this.#ensurePage()
    if (this.tokensStale()) await this.scrapePageTokens()

    // 兜底：页面若处于 hidden（窗口被移出屏幕 / 最小化 / 被别的窗口完全遮挡），
    // Chromium 的后台节流会把页内 fetch 一起冻住——连请求都发不出去，
    // 表现就是一路挂到超时，而 cookie 和 token 全都是好的。
    // launchBrowser 已经强制加了防节流开关；这里是给「浏览器不是我们启动的」
    // 那一类情况（用户自己开着、或老配置起的）留的自愈路径。
    const vis = await evaluate(this.#page, 'document.visibilityState + "|" + (document.hasFocus() ? 1 : 0)').catch(() => '')
    if (typeof vis === 'string' && vis.startsWith('hidden|0')) {
      // Page.bringToFront 能让标签页重新可见，通常足以解除节流。
      await this.#page.send('Page.bringToFront', {}).catch(() => {})
      await new Promise(r => setTimeout(r, 300))
      const after = await evaluate(this.#page, 'document.visibilityState + "|" + (document.hasFocus() ? 1 : 0)').catch(() => '')
      if (typeof after === 'string' && after.startsWith('hidden|0')) {
        throw Object.assign(
          new Error(
            'page is hidden and Chromium is throttling its network; the generation request cannot be sent. '
            + 'Restart the browser profile (or make its window visible) so it launches with '
            + '--disable-backgrounding-occluded-windows --disable-renderer-backgrounding '
            + '--disable-background-timer-throttling',
          ),
          { status: 0 },
        )
      }
    }

    const { origin, batchExecutePath } = this.#config.upstream
    const { snlm0e, bl } = this.#pageTokens

    // Build the f.req nested-array payload.
    // Format established by reverse-engineering the BardFrontendService/StreamGenerate endpoint.
    const innerRequest = [
      [prompt, 0, null, null, null, null, 0],
      ['en'],
      [conversationId, responseId, choiceId, null, null, null, null, null, null, ''],
    ]
    const outerRequest = [null, JSON.stringify(innerRequest)]
    const fReq = JSON.stringify(outerRequest)

    const reqid = Math.floor(Math.random() * 900000) + 100000
    const streamPath = `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
    const params = new URLSearchParams({
      bl,
      rt: 'c',
      _reqid: String(reqid),
      at: snlm0e,
    })
    const url = `${origin}${streamPath}?${params}`
    const body = new URLSearchParams({ 'f.req': fReq }).toString()

    // Execute inside the browser so everything is fingerprint-matched.
    const raw = await evaluate(this.#page, `
      (async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), ${timeoutMs});
        try {
          const r = await fetch(${JSON.stringify(url)}, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'x-same-domain': '1',
            },
            body: ${JSON.stringify(body)},
            credentials: 'include',
            signal: ctrl.signal,
          });
          if (!r.ok) return { error: r.status };
          const text = await r.text();
          return { text };
        } catch (e) {
          return { error: e.message };
        } finally {
          clearTimeout(timer);
        }
      })()
    `)

    if (raw?.error) {
      const status = typeof raw.error === 'number' ? raw.error : 0
      throw Object.assign(new Error(`upstream error: ${raw.error}`), { status })
    }
    return raw?.text ?? ''
  }
}
