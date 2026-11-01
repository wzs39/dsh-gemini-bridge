/**
 * test/agyclient.test.mjs — agy pool client behaviour, driven by a fake
 * upstream fetch. Covers the three production bugs found by live traffic:
 *
 *   1. CRLF SSE framing: the real upstream terminates frames with
 *      "\r\n\r\n"; a bare '\n\n' search parsed nothing and a valid 200 was
 *      reported as "stream produced no events".
 *   2. Account-level 403 gate ("Verify your account to continue") must park
 *      that identity and rotate, not abort the whole request.
 *   3. 404 model-id errors must NOT rotate: a bad id is not an account
 *      problem, and burning every account on it is worse than failing fast.
 *
 * Run: node --test test/agyclient.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { AgyClient, AGY_MODELS, AgyUpstreamError } from '../lib/agyclient.mjs'

// ── helpers ────────────────────────────────────────────────────────────────

function sseFrame(payload, eol = '\r\n') {
  return `data: ${JSON.stringify(payload)}${eol}${eol}`
}

function textFrame(text, eol = '\r\n') {
  return sseFrame({
    response: {
      candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    },
  }, eol)
}

/** A pool stub: accounts we control, records which one was picked. */
function makePool(ids) {
  const accounts = ids.map(id => ({
    id,
    pausedUntil: 0,
    pauseReason: null,
    tokens: { accessToken: async () => `token-${id}`, forceRefresh: async () => `token-${id}` },
  }))
  let cursor = 0
  return {
    accounts,
    get count() { return accounts.length },
    describeAll: () => accounts.map(a => ({ id: a.id, pausedUntil: a.pausedUntil || null })),
    pick() {
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[(cursor + i) % accounts.length]
        if (a.pausedUntil > Date.now()) continue
        cursor = (accounts.indexOf(a) + 1) % accounts.length
        return a
      }
      return null
    },
    nextUnpauseInMs: () => 1000,
    pause(a, ms, reason) { a.pausedUntil = Date.now() + ms; a.pauseReason = reason },
    resume(id) {
      const a = accounts.find(x => x.id === id)
      if (!a) return false
      a.pausedUntil = 0
      return true
    },
  }
}

function makeConfig() {
  return { agy: { project: 'aicode-consumers', defaultModel: 'gemini-3.8-flash-medium' }, behaviour: {} }
}

async function collect(gen) {
  const events = []
  for await (const e of gen) events.push(e)
  return events
}

/** Install a fetch stub for one test; returns a restore function. */
function stubFetch(impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => { globalThis.fetch = original }
}

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } })
}

function sseBody(frames) {
  // A real ReadableStream so the client's getReader() path is exercised.
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('agy client — SSE framing', () => {
  it('parses CRLF-terminated frames (real upstream framing)', async () => {
    const restore = stubFetch(async () => response(sseBody([textFrame('ALPHA')])))
    try {
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool: makePool(['a']) })
      const events = await collect(client.complete({ model: 'gemini-3.8-flash-medium', messages: [{ role: 'user', content: 'hi' }] }))
      const text = events.map(e => e.delta?.content ?? '').join('')
      assert.equal(text, 'ALPHA', 'CRLF frames must be parsed, not reported as an empty stream')
      assert.equal(events.at(-1).done, true)
    } finally { restore() }
  })

  it('parses LF-terminated frames too (proxy-normalised)', async () => {
    const restore = stubFetch(async () => response(sseBody([textFrame('BRAVO', '\n')])))
    try {
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool: makePool(['a']) })
      const events = await collect(client.complete({ model: 'gemini-3.8-flash-medium', messages: [{ role: 'user', content: 'hi' }] }))
      assert.equal(events.map(e => e.delta?.content ?? '').join(''), 'BRAVO')
    } finally { restore() }
  })

  it('frames split across chunk boundaries still assemble', async () => {
    const full = textFrame('CHARLIE')
    const cut = Math.floor(full.length / 2)
    const restore = stubFetch(async () => response(sseBody([full.slice(0, cut), full.slice(cut)])))
    try {
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool: makePool(['a']) })
      const events = await collect(client.complete({ model: 'gemini-3.8-flash-medium', messages: [{ role: 'user', content: 'hi' }] }))
      assert.equal(events.map(e => e.delta?.content ?? '').join(''), 'CHARLIE')
    } finally { restore() }
  })

  it('a genuinely empty 200 stream is still reported as degraded', async () => {
    const restore = stubFetch(async () => response(sseBody([])))
    try {
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool: makePool(['a']) })
      await assert.rejects(
        () => collect(client.complete({ model: 'gemini-3.8-flash-medium', messages: [{ role: 'user', content: 'hi' }] })),
        (e) => e instanceof AgyUpstreamError && e.code === 'EMPTY_STREAM',
      )
    } finally { restore() }
  })
})

describe('agy client — account error classification', () => {
  const gate403 = JSON.stringify({
    error: { code: 403, message: 'Verify your account to continue.', status: 'PERMISSION_DENIED' },
  })

  it('403 account gate parks that identity and rotates to a serving one', async () => {
    const pool = makePool(['gated', 'good'])
    let call = 0
    const restore = stubFetch(async (url, opts) => {
      call += 1
      const auth = opts?.headers?.authorization ?? ''
      if (auth === 'Bearer token-gated') return response(gate403, { status: 403 })
      return response(sseBody([textFrame('OK')]))
    })
    try {
      // Force the first pick to be the gated account.
      pool.pick = (() => {
        const orig = pool.pick
        let first = true
        return () => {
          if (first) { first = false; return pool.accounts[0] }
          return orig()
        }
      })()
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool })
      const events = await collect(client.complete({ model: 'gemini-3.8-flash-medium', messages: [{ role: 'user', content: 'hi' }] }))
      assert.equal(events.map(e => e.delta?.content ?? '').join(''), 'OK')
      assert.ok(pool.accounts[0].pausedUntil > Date.now(), 'the gated identity must be parked')
      assert.match(String(pool.accounts[0].pauseReason ?? gate403), /Verify your account|PERMISSION_DENIED/)
      assert.ok(call >= 2, 'the client must retry on another account')
      // Gate parks use the AUTH window (12h), not the 1h throttle window.
      const parkedFor = pool.accounts[0].pausedUntil - Date.now()
      assert.ok(parkedFor > 6 * 3600_000, `account gate should park for the long auth window, got ${parkedFor}ms`)
    } finally { restore() }
  })

  it('404 model error aborts immediately without parking any account', async () => {
    const pool = makePool(['a', 'b', 'c'])
    let calls = 0
    const restore = stubFetch(async () => {
      calls += 1
      return response(JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }), { status: 404 })
    })
    try {
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool })
      await assert.rejects(
        () => collect(client.complete({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] })),
        (e) => e instanceof AgyUpstreamError && e.status === 404,
      )
      assert.equal(calls, 1, 'a bad model id must not be retried across accounts')
      for (const a of pool.accounts) {
        assert.equal(a.pausedUntil, 0, `${a.id} must not be parked for a model-id error`)
      }
    } finally { restore() }
  })

  it('429 quota parks that account and rotates', async () => {
    const pool = makePool(['hot', 'cold'])
    const restore = stubFetch(async (url, opts) => {
      if (opts?.headers?.authorization === 'Bearer token-hot') {
        return response(JSON.stringify({ error: { code: 429, message: 'Individual quota reached.', status: 'RESOURCE_EXHAUSTED' } }), { status: 429 })
      }
      return response(sseBody([textFrame('COLD')]))
    })
    try {
      pool.pick = (() => {
        const orig = pool.pick
        let first = true
        return () => { if (first) { first = false; return pool.accounts[0] } return orig() }
      })()
      const client = new AgyClient({ config: makeConfig(), tokens: null, pool })
      const events = await collect(client.complete({ model: 'gemini-3.8-flash-medium', messages: [{ role: 'user', content: 'hi' }] }))
      assert.equal(events.map(e => e.delta?.content ?? '').join(''), 'COLD')
      assert.ok(pool.accounts[0].pausedUntil > Date.now())
    } finally { restore() }
  })
})

describe('agy advertised model catalog', () => {
  it('every advertised id is one the upstream actually serves', () => {
    // Verified live: "gemini-3.8-flash" is NOT valid (404 NOT_FOUND); the real
    // variants are -high/-medium/-low/-tiered.
    assert.ok(!AGY_MODELS.includes('gemini-3.8-flash'), 'the bare gemini-3.8-flash id 404s upstream')
    for (const id of ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low']) {
      assert.ok(AGY_MODELS.includes(id), `${id} serves and must be advertised`)
    }
    assert.ok(AGY_MODELS.includes('claude-sonnet-4-6'))
    assert.ok(AGY_MODELS.includes('claude-opus-4-6-thinking'))
    assert.ok(AGY_MODELS.includes('gpt-oss-120b-medium'))
  })

  it('has no duplicates', () => {
    assert.equal(new Set(AGY_MODELS).size, AGY_MODELS.length)
  })
})

describe('agy client — long output is not killed by a fixed deadline', () => {
  /**
   * Regression: the request used to carry AbortSignal.timeout(completionTimeoutMs)
   * (120s). A healthy 1500-line generation was aborted mid-stream at ~40k chars
   * with finishReason never arriving, which the user experienced as "always
   * truncated". Liveness must be judged by silence, not by total duration.
   */
  it('a stream that keeps producing outlives the idle window', async () => {
    // Emit frames with gaps SHORTER than the idle timeout, but for a total
    // duration well beyond it. With a total-deadline design this fails.
    const frames = 40
    const body = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder()
        for (let i = 0; i < frames; i++) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify({
            response: { candidates: [{ content: { role: 'model', parts: [{ text: `L${i}\n` }] } }] },
          })}\r\n\r\n`))
          await new Promise(r => setTimeout(r, 25))
        }
        controller.close()
      },
    })

    const restore = stubFetch(async () => new Response(body, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }))
    try {
      const client = new AgyClient({
        config: { agy: { project: 'p', defaultModel: 'gemini-3.8-flash-medium' }, behaviour: { streamIdleTimeoutMs: 120, completionTimeoutMs: 60000 } },
        tokens: null,
        pool: makePool(['a']),
      })
      const events = await collect(client.complete({
        model: 'gemini-3.8-flash-medium',
        messages: [{ role: 'user', content: 'go' }],
      }))
      const text = events.map(e => e.delta?.content ?? '').join('')
      // 40 frames * 25ms = ~1000ms total, far beyond the 120ms IDLE window but
      // every gap is under it -- so the whole answer must arrive.
      assert.equal(text, Array.from({ length: frames }, (_, i) => `L${i}\n`).join(''))
      assert.equal(events.at(-1).done, true)
      assert.equal(events.at(-1).finishReason, 'stop')
    } finally { restore() }
  })

  it('a truly stalled stream still aborts on the idle timeout', async () => {
    // One frame, then silence. The stream is never closed, so the ONLY way out
    // is the idle timer aborting the fetch signal.
    //
    // Note: the response body must react to the abort signal, otherwise the
    // reader just hangs on a ReadableStream whose start() already returned --
    // that hung this test suite the first time. We wire the abort through.
    let aborted = false
    const restore = stubFetch(async (url, opts) => {
      const signal = opts?.signal
      const body = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(`data: ${JSON.stringify({
            response: { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] },
          })}\r\n\r\n`))
          signal?.addEventListener('abort', () => {
            aborted = true
            try { controller.error(new Error('aborted')) } catch { /* already closed */ }
          }, { once: true })
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    try {
      const client = new AgyClient({
        config: { agy: { project: 'p', defaultModel: 'gemini-3.8-flash-medium' }, behaviour: { streamIdleTimeoutMs: 150, completionTimeoutMs: 60000 } },
        tokens: null,
        pool: makePool(['a']),
      })
      const started = Date.now()
      await assert.rejects(
        () => collect(client.complete({
          model: 'gemini-3.8-flash-medium',
          messages: [{ role: 'user', content: 'go' }],
        })),
        'a stalled stream must abort rather than hang',
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 5000, `stall must abort promptly, took ${elapsed}ms`)
      assert.equal(aborted, true, 'the idle timer must abort the underlying request')
    } finally { restore() }
  })
})
