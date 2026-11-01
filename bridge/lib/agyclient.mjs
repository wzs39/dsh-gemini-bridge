/**
 * Antigravity upstream client: v1internal protocol over OAuth, the agy models.
 *
 * Verified live on this machine (tools/probe-agy-upstream.ps1 -> 200 + exact
 * echo): the region gate is client-side, so this path talks to
 * daily-cloudcode-pa.googleapis.com with the account's agy OAuth token and
 * never asks the CLI for permission.
 *
 * Differences from the web channel that matter for protection:
 *   - This is the OFFICIAL machine protocol (same shape the CLI uses), so
 *     there is no fingerprint game to play: Node TLS is exactly what agy itself
 *     presents. What still applies is pacing/budget -- quota is per account and
 *     429/503 come back in-band with HTTP 200.
 *   - Errors arrive as `{"error":{...}}` inside a 200 SSE payload. classify +
 *     park semantics reuse detect.mjs, with the in-band code mapped onto the
 *     HTTP-equivalent.
 *   - The channel is stateless; conversation history rides in `contents[]`.
 *     `sessionId` (derived from the first user message) preserves upstream
 *     prompt-cache affinity.
 *
 * @module gemini-web-bridge/lib/agyclient
 */

import { buildRequest, mapChunk, mapFinishReason } from './agyconvert.mjs'
import { AgyAllParkedError } from './agytoken.mjs'
import { pauseFor } from './detect.mjs'

const BASE = 'https://daily-cloudcode-pa.googleapis.com'
const UA = 'antigravity/4.3.0 windows/amd64'

/**
 * Models this build advertises on /v1/models when the agy channel is enabled.
 *
 * These ids are the AUTHORITATIVE ones taken from dsh-agy-link's own quota
 * table in pool.json (quotas.*.models[].modelId) and verified live against a
 * serving account. Do not hand-write them from memory: "gemini-3.8-flash" is
 * NOT a valid id (upstream returns 404 NOT_FOUND) -- the real flash variants
 * are -high / -medium / -low / -tiered.
 *
 * gemini-2.5-pro is intentionally absent: it is account-gated (403 "Verify
 * your account to continue") on this plan while every other gemini id serves.
 */
export const AGY_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-tiered',
  'gemini-3-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-thinking',
  'gemini-3.1-flash-image',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]

export class AgyUpstreamError extends Error {
  constructor(message, { status = 0, code = '', retryAfterMs } = {}) {
    super(message)
    this.name = 'AgyUpstreamError'
    this.status = status
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export class AgyClient {
  #config
  #tokens        // single-account AgyTokenStore (legacy) OR null when pool is on
  #pool          // AgyPool (multi-account) OR null
  #project

  constructor({ config, tokens, pool }) {
    this.#config = config
    this.#tokens = tokens ?? null
    this.#pool = pool ?? null
    this.#project = config.agy?.project ?? 'aicode-consumers'
  }

  describe() {
    if (this.#pool) {
      return {
        enabled: true,
        models: AGY_MODELS,
        pool: {
          count: this.#pool.count,
          accounts: this.#pool.describeAll(),
        },
      }
    }
    return { enabled: true, models: AGY_MODELS, token: this.#tokens.describe() }
  }

  /** Resume one parked pool account (proxied for the HTTP route). */
  poolResume(id) {
    return this.#pool?.resume?.(id) ?? false
  }

  /**
   * One completion. Yields OpenAI-shaped events:
   *   { delta, finishReason?, usage?, done }
   *
   * Account handling:
   *   - pool mode: pick() a live account; 401 -> that account's forceRefresh
   *     + replay (same identity, token was stale); 429 quota -> park that
   *     account (pauseFor('throttled')) and sticky-rotate to the next; all
   *     parked -> AgyAllParkedError with the soonest release.
   *   - legacy single-token mode: exactly the old 401-retry behavior.
   *   - region gate: never involved -- this channel talks to the upstream
   *     directly; the lock lives only in the CLI (verified live).
   */
  async *complete(payload) {
    const { envelope } = buildRequest({
      ...payload,
      project: this.#project,
      defaultModel: this.#config.agy?.defaultModel ?? 'gemini-3.8-flash',
    })
    const body = JSON.stringify(envelope)

    if (!this.#pool) {
      yield* this.#completeSingle(body)
      return
    }

    // Pool mode: sticky rotation with per-account parks.
    for (;;) {
      const account = this.#pool.pick()
      if (!account) {
        const ms = this.#pool.nextUnpauseInMs() || 60_000
        throw new AgyAllParkedError(ms)
      }
      try {
        yield* this.#attemptWithAccount(account, body)
        return
      } catch (err) {
        const isQuota = err instanceof AgyUpstreamError
          && (err.status === 429 || err.code === 'RESOURCE_EXHAUSTED')
        const isDead = err instanceof AgyUpstreamError && err.status === 401 && err.code === 'DEAD_REFRESH'
        // Account-level gate: "PERMISSION_DENIED / Verify your account to
        // continue". Verified live: this is PER IDENTITY, not per token and not
        // per model -- one account returns 403 for every model while a sibling
        // account serves the same model fine. So it must rotate, not abort.
        const isGated = err instanceof AgyUpstreamError
          && (err.status === 403 || err.code === 'PERMISSION_DENIED')
        // Model id errors are NOT account problems: rotating cannot fix a 404
        // and would just burn every account in the pool on one bad request.
        const isModelError = err instanceof AgyUpstreamError
          && (err.status === 404 || err.code === 'NOT_FOUND')

        if (isModelError) throw err

        if (isQuota || isDead || isGated) {
          if (isGated) {
            // Park on the auth window: only a human verifying the account (or
            // the plan upgrading) clears it. A 1h "throttled" park would make
            // us retry a permanently gated identity every hour forever.
            this.#pool.pause(account, pauseFor('auth_expired'), err.message)
          } else {
            this.#pool.pause(account, pauseFor(isDead ? 'auth_expired' : 'throttled'), err.message)
          }
          continue
        }
        throw err
      }
    }
  }

  async *#attemptWithAccount(account, body) {
    let attempt = 0
    for (;;) {
      attempt += 1
      const access = await account.tokens.accessToken()
      const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
          requesttype: 'agent',
          'user-agent': UA,
        },
        body,
        signal: AbortSignal.timeout(this.#config.behaviour?.completionTimeoutMs ?? 120000),
      })

      if (res.status === 401 && attempt < 2) {
        try {
          await account.tokens.forceRefresh()
          continue
        } catch (refreshErr) {
          // Refresh genuinely failed (invalid_grant etc.) -- this identity is
          // dead until a human re-logs in via the agy CLI / dsh-agy-link.
          throw new AgyUpstreamError(`agy account ${account.id}: refresh dead: ${refreshErr.message}`, {
            status: 401,
            code: 'DEAD_REFRESH',
          })
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new AgyUpstreamError(`agy account ${account.id} HTTP ${res.status}: ${text.slice(0, 200)}`, {
          status: res.status,
          code: res.status === 429 ? 'RESOURCE_EXHAUSTED' : `HTTP_${res.status}`,
        })
      }

      yield* this.#consumeStream(res)
      return
    }
  }

  async *#completeSingle(body) {
    let attempt = 0
    // 401 retry loop: at most 2 tries (fresh token, then give up).
    for (;;) {
      attempt += 1
      const access = await this.#tokens.accessToken()
      const res = await fetch(`${BASE}/v1internal:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${access}`,
          'content-type': 'application/json',
          requesttype: 'agent',
          'user-agent': UA,
        },
        body,
        signal: AbortSignal.timeout(this.#config.behaviour?.completionTimeoutMs ?? 120000),
      })

      if (res.status === 401 && attempt < 2) {
        await this.#tokens.forceRefresh()
        continue
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new AgyUpstreamError(`agy upstream HTTP ${res.status}: ${text.slice(0, 200)}`, {
          status: res.status,
          code: res.status === 429 ? 'RESOURCE_EXHAUSTED' : `HTTP_${res.status}`,
        })
      }

      yield* this.#consumeStream(res)
      return
    }
  }

  async *#consumeStream(res) {
    const decoder = new TextDecoder()
    // ONE reader for the whole body: getReader() locks the stream, and a
    // second call inside the loop would throw (or silently re-read nothing).
    const reader = res.body.getReader()
    let buf = ''
    let emittedToolCalls = false
    let finishReason = null
    let usage = null
    let anyText = false

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      // SSE frames end at a blank line. The upstream emits CRLF blank lines
      // ("\r\n\r\n") while older proxies emit "\n\n" -- verified live on
      // daily-cloudcode-pa (CRLF only), so a bare '\n\n' search finds nothing
      // and a full 200 response gets misread as an empty stream. Normalise
      // CRLF to LF as data arrives, then one separator check is enough.
      buf = buf.replace(/\r\n/g, '\n')
      let sep
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const jsonText = line.slice(5).trim()
          if (!jsonText || jsonText === '[DONE]') continue
          let obj
          try { obj = JSON.parse(jsonText) } catch { continue }

          // In-band error: HTTP was 200, the payload says otherwise.
          if (obj.error) {
            const code = obj.error.code ?? 500
            const status = obj.error.status ?? 'UPSTREAM_ERROR'
            throw new AgyUpstreamError(`agy in-band ${status}: ${obj.error.message}`, {
              status: code,
              code: status,
            })
          }

          const mapped = mapChunk(obj)
          if (mapped.usage) usage = mapped.usage
          if (mapped.finishReason) finishReason = mapped.finishReason
          if (mapped.delta.content) anyText = true
          if (mapped.delta.tool_calls?.length) emittedToolCalls = true
          if (Object.keys(mapped.delta).length) yield { delta: mapped.delta, done: false }
        }
      }
    }

    if (!anyText && !emittedToolCalls && !finishReason) {
      // A 200 stream that produced nothing at all -- treat as degraded upstream
      // rather than an empty answer, so the caller can decide.
      throw new AgyUpstreamError('agy stream produced no events', { code: 'EMPTY_STREAM' })
    }

    yield {
      delta: {},
      finishReason: mapFinishReason(finishReason, emittedToolCalls),
      usage,
      done: true,
    }
  }
}
