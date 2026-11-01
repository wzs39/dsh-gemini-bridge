/**
 * OpenAI-compatible HTTP surface for the Gemini web bridge.
 *
 * Endpoints:
 *   GET  /v1/models                  → single model entry
 *   POST /v1/chat/completions        → streaming or non-streaming completion
 *   GET  /health                     → honest per-account status (see below)
 *   POST /api/guard/reset            → human-triggered cooldown clear (per account)
 *   POST /api/account/recovered      → a human re-logged an account; unpark it
 *
 * The refusal contract (learned the expensive way):
 *   Every rejection path must be reached BEFORE writeHead. client.openCompletion()
 *   exists precisely so the guard verdict, the account pick and the upstream
 *   round-trip are all known before a single response byte goes out. A refusal
 *   dressed as "200 + empty stream" makes clients retry, and retry storms into
 *   a refusing upstream are how accounts die.
 *
 * The health contract:
 *   If /health is all-green while users report failures, /health has the bug.
 *   So it reports, per account: session age, guard level/cooldown/reason,
 *   parked status, window cap alongside the hourly cap, and the anomaly score.
 *
 * @module gemini-web-bridge/lib/server
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { UpstreamError, AllParkedError } from './client.mjs'
import { AgyUpstreamError } from './agyclient.mjs'

function captureTurn(config, turn) {
  if (!config?.debug?.capture) return
  try {
    const dir = config.paths.logs ?? path.join(process.cwd(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `turn-${Date.now()}-${randomUUID().slice(0, 8)}.json`)
    fs.writeFileSync(file, JSON.stringify(turn, null, 2))
  } catch (error) {
    console.error('[bridge] capture failed:', error?.message ?? error)
  }
}

const BASE_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...extraHeaders, 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Map our error types to OpenAI-shaped refusals.
 *
 * GuardError/UpstreamError/AllParkedError carry retryAfterMs when the wait is
 * computable; the wait that is not computable (queue depth) gets no number
 * rather than an invented one.
 */
function classify(err) {
  // agy channel first: quota exhaustion is the meaningful refusal there, and
  // the transport status is literally 200 for in-band errors -- classification
  // has to come from err.status/err.code, not from a transport code.
  if (err instanceof AgyUpstreamError) {
    if (err.status === 429 || err.code === 'RESOURCE_EXHAUSTED') {
      return { status: 429, type: 'rate_limit_error', code: 'agy_quota' }
    }
    if (err.status === 401 || err.status === 403) {
      return { status: 503, type: 'session_unavailable', code: 'agy_credential' }
    }
    if (err.status === 404) return { status: 404, type: 'invalid_request_error', code: 'unknown_model' }
    if (err.status === 503 || err.code === 'UNAVAILABLE') {
      return { status: 503, type: 'upstream_error', code: 'agy_capacity' }
    }
    return { status: 502, type: 'upstream_error', code: err.code || 'agy_failed' }
  }
  // UpstreamError next: it ALSO carries retryAfterMs, and the generic
  // rate-limit branch below would otherwise swallow a parked-account 403 as
  // a plain 429 -- losing the distinction between "you are too fast" and
  // "this identity is dead and a human must re-login".
  if (err instanceof UpstreamError) {
    if (err.status === 401 || err.status === 403) {
      return { status: 503, type: 'session_unavailable', code: 'account_parked' }
    }
    if (err.status === 429) return { status: 429, type: 'rate_limit_error', code: 'upstream_throttled' }
    return { status: 502, type: 'upstream_error', code: 'upstream_failed' }
  }
  if (err?.name === 'GuardError' || err?.name === 'AllParkedError' || typeof err?.retryAfterMs === 'number') {
    return { status: 429, type: 'rate_limit_error', code: err?.code ?? 'rate_limited' }
  }
  return { status: 500, type: 'internal_error', code: 'bridge_internal' }
}

function refusalBody(err) {
  const { status, type, code } = classify(err)
  const headers = {}
  if (typeof err?.retryAfterMs === 'number') {
    headers['retry-after'] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)))
  }
  return {
    status,
    headers,
    body: { error: { message: err?.message ?? 'error', type, code } },
  }
}

function checkAuth(req, config) {
  const auth = req.headers['authorization'] ?? ''
  if (!auth) return true
  const key = config.server?.apiKey
  if (!key) return true
  return auth === `Bearer ${key}` || auth === key
}

export function createServer(config, client) {
  const model = config.server?.model ?? 'gemini-web'

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, BASE_HEADERS)
      res.end()
      return
    }

    if (!checkAuth(req, config)) {
      json(res, 401, { error: { message: 'Unauthorized', type: 'invalid_request_error' } })
      return
    }

    const url = new URL(req.url, `http://localhost`)

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const names = client.models?.() ?? [model]
      json(res, 200, {
        object: 'list',
        data: names.map(id => ({
          id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'gemini-web-bridge',
        })),
      })
      return
    }

    // Honest multi-account health.
    if (req.method === 'GET' && url.pathname === '/health') {
      const described = client.describeAll?.() ?? { accounts: client.manager?.describeAll?.() ?? [], agy: null }
      const accounts = described.accounts
      const usable = accounts.filter(a => !a.pausedUntil && a.session?.ready).length
      const agyReady = Boolean(described.agy?.token?.loaded ?? described.agy)
      let status
      if (usable > 0 || agyReady) status = 'ready'
      else if (accounts.some(a => a.pausedUntil)) status = 'parked'
      else status = 'signed-out'
      json(res, 200, {
        status,
        usableAccounts: usable,
        totalAccounts: accounts.length,
        agy: described.agy,
        accounts,
      })
      return
    }

    // Optional: ?account=<name> resets only that account.
    if (req.method === 'POST' && url.pathname === '/api/guard/reset') {
      const name = url.searchParams.get('account')
      let done = false
      for (const a of client.manager?.describeAll?.() ?? []) {
        if (!name || a.name === name) {
          const acct = client.manager?.pickAccountByName?.(a.name)
          if (acct) { acct.guard.reset(); acct.pausedUntil = 0; acct.pauseReason = null; done = true }
        }
      }
      json(res, done ? 200 : 404, done ? { ok: true } : { error: { message: 'account not found' } })
      return
    }

    // A human completed the re-login for this account.
    if (req.method === 'POST' && url.pathname === '/api/account/recovered') {
      const name = url.searchParams.get('account') ?? (client.manager?.describeAll?.()[0]?.name ?? 'default')
      const ok = client.manager?.recovered?.(name) ?? false
      json(res, ok ? 200 : 404, ok ? { ok: true, account: name } : { error: { message: 'account not found' } })
      return
    }

    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/responses')) {
      let body = ''
      for await (const chunk of req) body += chunk
      let payload
      try { payload = JSON.parse(body) } catch {
        json(res, 400, { error: { message: 'invalid JSON', type: 'invalid_request_error' } })
        return
      }

      const messages = payload.messages ?? []
      const stream = payload.stream === true
      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)
      const startedAt = Date.now()
      const usedModel = payload.model ?? model

      // ── The refusal gate: everything below this line only runs when the
      //    upstream has actually answered. No bytes have been sent yet. ──
      let opened
      try {
        opened = await client.openCompletion(payload)
      } catch (err) {
        const refusal = refusalBody(err)
        captureTurn(config, { messages, error: err?.message, durationMs: Date.now() - startedAt })
        json(res, refusal.status, refusal.body, refusal.headers)
        return
      }

      // Drain the channel into an OpenAI message. Both channels share the event
      // contract: { delta: {content?, reasoning_content?, tool_calls?},
      // finishReason?, usage?, done }. Streaming and non-streaming buffer the
      // same way -- the web channel has one whole-text delta, agy can emit
      // several (thoughts/calls interleave); incremental SSE can come later
      // without changing this path's semantics.
      const content = []
      const reasoning = []
      const toolCalls = []   // accumulator by tool_call index
      let finishReason = null
      let usage = null
      let drainErr = null
      try {
        for await (const ev of opened.iterator) {
          if (ev.delta?.content) content.push(ev.delta.content)
          if (ev.delta?.reasoning_content) reasoning.push(ev.delta.reasoning_content)
          for (const tc of ev.delta?.tool_calls ?? []) {
            const slot = toolCalls[tc.index ?? toolCalls.length] ??= {
              id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' },
            }
            if (tc.id) slot.id = tc.id
            if (tc.function?.name) slot.function.name += tc.function.name
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
          }
          if (ev.finishReason) finishReason = ev.finishReason
          if (ev.usage) usage = ev.usage
        }
      } catch (err) {
        // Mid-stream in-band upstream failure (agy delivers these with HTTP 200).
        // Nothing has been written to the socket yet at this point -- both
        // channels fully buffer before writeHead -- so this still lands as a
        // clean refusal, honoring the no-fake-200 rule.
        drainErr = err
      }
      if (drainErr) {
        const refusal = refusalBody(drainErr)
        captureTurn(config, { messages, error: drainErr?.message, durationMs: Date.now() - startedAt })
        json(res, refusal.status, refusal.body, refusal.headers)
        return
      }
      const fullText = content.join('')
      const emittedCalls = toolCalls.filter(Boolean)
      const finalFinish = finishReason ?? (emittedCalls.length ? 'tool_calls' : 'stop')

      const message = { role: 'assistant' }
      if (fullText) message.content = fullText
      if (reasoning.length) message.reasoning_content = reasoning.join('')
      if (emittedCalls.length) { message.tool_calls = emittedCalls; if (!fullText) message.content = null }

      if (stream) {
        res.writeHead(200, {
          ...BASE_HEADERS,
          'content-type': 'text/event-stream',
          'transfer-encoding': 'chunked',
        })
        sse(res, {
          id, object: 'chat.completion.chunk', created, model: usedModel,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })
        if (fullText) {
          sse(res, {
            id, object: 'chat.completion.chunk', created, model: usedModel,
            choices: [{ index: 0, delta: { content: fullText }, finish_reason: null }],
          })
        }
        emittedCalls.forEach((tc, index) => {
          sse(res, {
            id, object: 'chat.completion.chunk', created, model: usedModel,
            choices: [{ index: 0, delta: { tool_calls: [{ ...tc, index }] }, finish_reason: null }],
          })
        })
        sse(res, {
          id, object: 'chat.completion.chunk', created, model: usedModel,
          choices: [{ index: 0, delta: {}, finish_reason: finalFinish }],
        })
        if (usage) sse(res, { id, object: 'chat.completion.chunk', created, model: usedModel, choices: [], usage })
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        json(res, 200, {
          id, object: 'chat.completion', created, model: usedModel,
          choices: [{ index: 0, message, finish_reason: finalFinish }],
          usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      }

      captureTurn(config, {
        channel: opened.channel,
        account: opened.account?.name ?? null,
        messages,
        response: fullText,
        toolCalls: emittedCalls.length,
        durationMs: Date.now() - startedAt,
      })
      return
    }

    json(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } })
  })

  return server
}
