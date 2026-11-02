/**
 * The upstream Gemini client: account rotation, guard integration, completion.
 *
 * Three hard rules carried in from deepseek-web-bridge (see docs/ban-risk.md):
 *
 * 1. ONE caller's queue, not one per account. A single mutex keeps the whole
 *    bridge at one in-flight upstream call; the human shape we are imitating is
 *    "one person typing one thing at a time", not "one person per account".
 *
 * 2. Hard-stop signals end the call; they are never retried in-path.
 *    The DeepSeek ban came from retrying every 5.5 s into an INVALID_TOKEN.
 *    `manager.report()` parks the account; the caller gets an error with a
 *    retry-after attached and NOTHING else happens.
 *
 * 3. The first event of the completion stream is pre-fetched before yielding.
 *    server.mjs needs to know whether this call was refused BEFORE it has
 *    written HTTP 200 + SSE headers. A refusal dressed as an empty 200 stream
 *    makes clients retry, and a client-driven retry storm is indistinguishable
 *    from what got the last account killed.
 *
 * @module gemini-web-bridge/lib/client
 */

import { parseGenerateResponse } from './parser.mjs'

/** An upstream error worth telling the guard about. */
export class UpstreamError extends Error {
  constructor(message, { status = 0, retryAfterMs } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

/** No account may take traffic (parked, quota-blocked, or pacing). Back off. */
export class AllParkedError extends Error {
  constructor(msRemaining, detail = '') {
    super(`no account can serve this call; soonest release in ${Math.ceil(msRemaining / 60000)} min${detail}`)
    this.name = 'AllParkedError'
    this.retryAfterMs = msRemaining
  }
}

export class GeminiWebClient {
  #config
  #manager
  #queue = Promise.resolve()
  // conversationId threads keyed by caller thread hash.
  #threads = new Map()

  constructor({ config, manager }) {
    this.#config = config
    this.#manager = manager
  }

  get manager() { return this.#manager }

  async #acquire() {
    let release
    const wait = new Promise(resolve => { release = resolve })
    const prev = this.#queue
    this.#queue = prev.then(() => wait)
    await prev
    return release
  }

  /**
   * Complete a message list. Returns { account, iterator } after the FIRST
   * event has been produced -- meaning guard admission, account pick and the
   * upstream round-trip all happened before the caller may emit anything.
   *
   * Throws GuardError/UpstreamError/AllParkedError on refusal, before any
   * response bytes exist.
   */
  async openCompletion(payload) {
    const messages = Array.isArray(payload) ? payload : (payload?.messages ?? [])
    const mode = Array.isArray(payload) ? null : (payload?.mode ?? null)
    const release = await this.#acquire()
    try {
      const startedAt = Date.now()
      const account = this.#manager.pick()
      if (!account) {
        // Distinguish two cases: everything parked, versus everything merely
        // out of quota. The retry-after has the same shape, but the reason must
        // not lie about what is actually happening.
        const reasons = this.#manager.parkReasonFor?.() ?? []
        const ms = this.#manager.nextUnpauseInMs() || 60000
        const detail = reasons.length ? ` [${reasons.join('; ')}]` : ''
        throw new AllParkedError(ms, detail)
      }

      const { session, guard } = account
      // Serialise per-account too: guard queue accounting.
      guard.enterQueue()
      try {
        await guard.admit()
      } finally {
        guard.leaveQueue()
      }

      if (session.needsRefresh()) {
        // Re-read cookies from the live browser: Google rotates __Secure-1PSIDTS
        // continuously and a stale copy misleads /health about the session age.
        await session.harvest({ force: true })
      }

      // Model selection lives in the composer pill, not in the payload — see
      // modes.mjs. Applying it is account state, so a failed switch must NOT
      // park the account: the request still runs, on whatever mode it was in.
      let modeResult = null
      if (mode) {
        modeResult = await session.applyMode(mode).catch((error) => ({
          ok: false, wanted: mode.label, error: String(error?.message ?? error),
        }))
      }

      const prompt = renderMessages(messages)
      // Thread continuity is per (account, mode, prompt). Keying on the prompt
      // alone is WRONG in a rotating pool: a conversationId belongs to the
      // Google account that created it, so handing pro1's `c_…` to pro2 makes
      // the upstream answer 200 with an empty body — indistinguishable from a
      // degraded account, and measured as "upstream returned empty answer" on
      // the first request after a mode switch (the pool had rotated).
      // The mode is part of the key for the same reason: a thread started in
      // Flash-Lite is not the same conversation as one in Pro.
      const threadKey = `${account.name}::${mode?.hash ?? ''}::${threadId(messages)}`
      const thread = this.#threads.get(threadKey) ?? { conversationId: '', responseId: '', choiceId: '' }

      let raw
      try {
        raw = await session.generateRaw({
          prompt,
          conversationId: thread.conversationId,
          responseId: thread.responseId,
          choiceId: thread.choiceId,
          timeoutMs: this.#config.behaviour.completionTimeoutMs,
        })
      } catch (err) {
        const status = err.status ?? 0
        // Classify the thrown error too -- detect.mjs reads the message text.
        this.#manager.report(account, { status, error: String(err?.message ?? err) })
        throw new UpstreamError(err.message, { status })
      }

      const verdict = this.#manager.report(account, { status: 200, raw })
      if (verdict.class === 'captcha' || verdict.class === 'auth_expired' || verdict.class === 'throttled') {
        // Hard stop: the account is now parked by the manager. Do not parse,
        // do not retry, hand the refusal to the caller with a retry-after.
        const retry = account.pausedUntil - Date.now()
        throw new UpstreamError(`upstream refused: ${verdict.reason}`, {
          status: verdict.class === 'throttled' ? 429 : 403,
          retryAfterMs: retry > 0 ? retry : 60000,
        })
      }

      let parsed = parseGenerateResponse(raw)
      if (!parsed?.text && verdict.class === 'ok') {
        // 200 with nothing to say. One empty answer is NOT proof the account is
        // degraded -- it is also what a transient upstream hiccup looks like,
        // and a single burst measured three accounts parked for 65 minutes on
        // the strength of one empty reply each. So: retry once, and only score
        // the account when the retry ALSO comes back empty. That makes
        // "two 200-with-nothing in a row" the real signal, which is what the
        // threshold of 4 was always meant to describe.
        //
        // The retry drops the conversationId when there was one: an empty answer
        // on a continued thread means the thread itself is unusable (mode
        // switched underneath it, or the id belongs to another identity), and
        // resending the same dead id reproduces the same empty answer. A fresh
        // thread costs nothing and isolates the real cause.
        const retries = this.#config.behaviour.emptyRetries ?? 1
        if (retries > 0) {
          await session.scrapePageTokens()
          const fallbackThread = thread.conversationId ? { conversationId: '', responseId: '', choiceId: '' } : thread
          const raw2 = await session.generateRaw({
            prompt,
            conversationId: fallbackThread.conversationId,
            responseId: fallbackThread.responseId,
            choiceId: fallbackThread.choiceId,
            timeoutMs: this.#config.behaviour.completionTimeoutMs,
          }).catch(() => null)
          if (raw2) {
            const v2 = this.#manager.report(account, { status: 200, raw: raw2 })
            if (v2.class === 'ok') parsed = parseGenerateResponse(raw2) ?? parsed
          }
        }
        // Score only a confirmed failure (retry absent or also empty). Weight 2
        // = one of the two signals the threshold expects; a later empty request
        // supplies the second.
        if (!parsed?.text) guard.anomaly('empty-answer-confirmed', 2)
      }

      if (!parsed?.text) {
        throw new UpstreamError('upstream returned empty answer')
      }

      guard.succeeded({ startedAt })
      this.#updateThread(threadKey, parsed)

      // The whole answer exists at this point (Gemini web delivers it complete).
      // Emit as one delta + done, mirroring the old generator interface.
      const events = [{ delta: parsed.text, done: false }, { delta: '', done: true }]
      return { account, iterator: events[Symbol.iterator](), mode: modeResult }
    } finally {
      release()
    }
  }

  #updateThread(key, parsed) {
    if (parsed.conversationId) {
      this.#threads.set(key, {
        conversationId: parsed.conversationId,
        responseId: parsed.responseId,
        choiceId: parsed.choiceId,
      })
    }
    // Keys now carry account+mode, so a pool of 3 accounts across 4 modes fills
    // this faster than the old prompt-only scheme. Evict oldest first, but keep
    // the map bounded regardless of how many identities are in play.
    while (this.#threads.size > 200) {
      const oldest = this.#threads.keys().next().value
      this.#threads.delete(oldest)
    }
  }
}

/** Convert OpenAI messages to one Gemini prompt string (system + last window). */
function renderMessages(messages) {
  const parts = []
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
  if (system) parts.push(`[System]\n${system}\n`)

  const relevant = messages.filter(m => m.role !== 'system')
  const lastUserIdx = relevant.map(m => m.role).lastIndexOf('user')
  const window = relevant.slice(Math.max(0, lastUserIdx - 4))

  for (const m of window) {
    const tag = m.role === 'assistant' ? 'Assistant' : 'User'
    parts.push(`[${tag}]\n${m.content}`)
  }
  return parts.join('\n\n')
}

function threadId(messages) {
  const firstUser = messages.find(m => m.role === 'user')?.content ?? ''
  let h = 5381
  for (let i = 0; i < Math.min(firstUser.length, 256); i++) {
    h = (((h << 5) + h) + firstUser.charCodeAt(i)) | 0
  }
  return String(h >>> 0)
}
