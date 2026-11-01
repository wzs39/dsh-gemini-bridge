/**
 * test/server.test.mjs — HTTP layer smoke tests (no real browser/upstream).
 *
 * Run: node --test "test/server.test.mjs"
 *
 * Each scenario that needs a different stub binds its OWN port: closing a
 * server and rebinding the same port races undici's keep-alive socket pool
 * (the client reuses the dead socket and fetch dies with ECONNRESET before
 * any status line arrives). Separate ports make that race unrepresentable.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from '../lib/server.mjs'
import { UpstreamError, AllParkedError } from '../lib/client.mjs'

// Minimal stub: manager returns one fake account; client.openCompletion either
// resolves with an iterator of events or rejects with a refusal.
function makeClient({ text = null, error = null } = {}) {
  const fakeAccount = { name: 'stub', guard: null, session: null, pausedUntil: 0, pauseReason: null }
  return {
    models: () => ['gemini-web'],
    agyResume: () => false,
    describeAll: () => ({
      accounts: [{ name: 'stub', session: { ready: true }, guard: null, pausedUntil: null, pauseReason: null }],
      agy: { enabled: true, models: [], token: { loaded: true } },
    }),
    manager: {
      describeAll: () => [{ name: 'stub', session: { ready: true }, guard: null, pausedUntil: null, pauseReason: null }],
      pickAccountByName: () => fakeAccount,
      recovered: () => true,
      nextUnpauseInMs: () => 60000,
    },
    async openCompletion(_payload) {
      if (error) throw error
      // Shared event contract (router-normalized shape):
      //   { delta: { content } } ... { delta: {}, finishReason, usage, done }
      const events = [
        { delta: { content: text }, done: false },
        { delta: {}, finishReason: 'stop', usage: null, done: true },
      ]
      return { channel: 'web', account: fakeAccount, iterator: events[Symbol.iterator]() }
    },
  }
}

const servers = []
function makeConfig(port) {
  return {
    server: { host: '127.0.0.1', port, apiKey: 'test-key', model: 'gemini-web' },
    paths: { logs: process.env.TEMP ?? '/tmp' },
    debug: { capture: false },
  }
}

async function start(client, port) {
  const server = createServer(makeConfig(port), client)
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve))
  servers.push(server)
  return { server, base: `http://127.0.0.1:${port}` }
}

after(() => {
  for (const s of servers) s.close()
  servers.length = 0
})

function postChat(base, extra = {}) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gemini-web', messages: [{ role: 'user', content: 'hi' }], ...extra }),
  })
}

describe('server happy path', () => {
  let ctx
  it('boots', async () => { ctx = await start(makeClient({ text: 'Hello from Gemini!' }), 18999) })

  it('GET /v1/models returns the model', async () => {
    const r = await fetch(`${ctx.base}/v1/models`, { headers: { authorization: 'Bearer test-key' } })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).data[0].id, 'gemini-web')
  })

  it('GET /health reports per-account status', async () => {
    const data = await (await fetch(`${ctx.base}/health`)).json()
    assert.equal(data.status, 'ready')
    assert.equal(data.totalAccounts, 1)
  })

  it('GET /api/agy/pool reflects single-account mode as 404', async () => {
    const r = await fetch(`${ctx.base}/api/agy/pool`)
    assert.equal(r.status, 404)
  })

  it('POST /api/agy/resume without pool is 404', async () => {
    const r = await fetch(`${ctx.base}/api/agy/resume?id=x`, { method: 'POST' })
    assert.equal(r.status, 404)
  })

  it('POST /v1/chat/completions non-streaming', async () => {
    const r = await postChat(ctx.base)
    assert.equal(r.status, 200)
    const data = await r.json()
    assert.equal(data.choices[0].message.content, 'Hello from Gemini!')
  })

  it('POST /v1/chat/completions streaming', async () => {
    const r = await postChat(ctx.base, { stream: true })
    assert.equal(r.status, 200)
    const text = await r.text()
    assert.ok(text.includes('Hello from Gemini!'))
    assert.ok(text.includes('[DONE]'))
  })

  it('rejects wrong API key', async () => {
    const r = await fetch(`${ctx.base}/v1/models`, { headers: { authorization: 'Bearer wrong-key' } })
    assert.equal(r.status, 401)
  })
})

describe('server refusal semantics', () => {
  it('a parked account is a 503 + retry-after, never a fake-empty 200', async () => {
    const { base } = await start(makeClient({
      error: new UpstreamError('upstream refused: captcha interstitial', { status: 403, retryAfterMs: 3600000 }),
    }), 18998)

    const r = await postChat(base)
    assert.equal(r.status, 503)
    assert.equal(r.headers.get('retry-after'), '3600')
    const data = await r.json()
    assert.match(data.error.message, /captcha/)
    assert.equal(data.error.code, 'account_parked')
  })

  it('AllParkedError becomes a 429 with retry-after', async () => {
    const { base } = await start(makeClient({ error: new AllParkedError(120000) }), 18997)

    const r = await postChat(base)
    assert.equal(r.status, 429)
    assert.equal(r.headers.get('retry-after'), '120')
  })
})

describe('health contract', () => {
  // These guard the dashboard's honesty. Every one of them corresponds to a
  // real way /health used to report "ready" while the channel was dead.

  it('agy pool accounts count toward usableAccounts', async () => {
    // Regression: usable used to only count web accounts, so a working 3-account
    // agy pool reported usableAccounts: 0 with no web account signed in.
    const client = makeClient()
    client.describeAll = () => ({
      accounts: [],
      agy: {
        enabled: true,
        models: ['gemini-3.8-flash-medium'],
        pool: {
          count: 3,
          accounts: [
            { id: 'a', token: { loaded: true }, usable: true, pausedUntil: null, quota: { groups: [] } },
            { id: 'b', token: { loaded: true }, usable: true, pausedUntil: null, quota: { groups: [] } },
            { id: 'c', token: { loaded: true }, usable: false, pausedUntil: null, quota: { groups: [] } },
          ],
        },
      },
    })
    const { base } = await start(client, 18996)
    const data = await (await fetch(`${base}/health`)).json()
    assert.equal(data.usableAccounts, 2, 'only accounts marked usable may be counted')
    assert.equal(data.totalAccounts, 3)
    assert.equal(data.channels.agy.usable, 2)
    assert.equal(data.channels.agy.total, 3)
    assert.equal(data.channels.agy.state, 'ready')
    assert.equal(data.channels.web.state, 'signed-out')
  })

  it('a readable token is not enough: pool accounts marked unusable stay unusable', async () => {
    // The validation-gate incident: all three accounts had loaded tokens and all
    // three were 403 VALIDATION_REQUIRED. Token-only health showed green.
    const client = makeClient()
    client.describeAll = () => ({
      accounts: [],
      agy: {
        enabled: true,
        models: [],
        pool: {
          count: 2,
          accounts: [
            { id: 'a', token: { loaded: true }, usable: false, pausedUntil: null, quota: { groups: [] } },
            { id: 'b', token: { loaded: true }, usable: false, pausedUntil: null, quota: { groups: [] } },
          ],
        },
      },
    })
    const { base } = await start(client, 18995)
    const data = await (await fetch(`${base}/health`)).json()
    assert.equal(data.usableAccounts, 0)
    assert.notEqual(data.channels.agy.state, 'ready', 'tokens readable but nothing serving must not read as ready')
  })

  it('all-parked pool reports parked, not signed-out and not ready', async () => {
    const client = makeClient()
    client.describeAll = () => ({
      accounts: [],
      agy: {
        enabled: true,
        models: [],
        pool: {
          count: 1,
          accounts: [{
            id: 'a', token: { loaded: true }, usable: false,
            pausedUntil: Date.now() + 3600_000, pauseReason: 'auth',
            quota: { groups: [] },
          }],
        },
      },
    })
    const { base } = await start(client, 18994)
    const data = await (await fetch(`${base}/health`)).json()
    assert.equal(data.status, 'parked')
    assert.equal(data.channels.agy.state, 'parked')
    assert.equal(data.usableAccounts, 0)
  })

  it('single-account agy mode still reports its credential state', async () => {
    const client = makeClient()
    client.describeAll = () => ({
      accounts: [],
      agy: { enabled: true, models: ['m'], token: { loaded: true } },
    })
    const { base } = await start(client, 18993)
    const data = await (await fetch(`${base}/health`)).json()
    assert.equal(data.channels.agy.usable, 1)
    assert.equal(data.channels.agy.total, 1)
    assert.equal(data.status, 'ready')
  })

  it('a disabled agy channel reports disabled rather than a credential problem', async () => {
    const client = makeClient()
    client.describeAll = () => ({
      accounts: [],
      agy: { enabled: false, models: [] },
    })
    const { base } = await start(client, 18992)
    const data = await (await fetch(`${base}/health`)).json()
    assert.equal(data.channels.agy.state, 'disabled')
    assert.equal(data.channels.agy.usable, 0)
  })
})
