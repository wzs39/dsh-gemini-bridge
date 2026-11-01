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
