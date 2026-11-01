/**
 * test/router.test.mjs — dual-channel routing tests with stub clients.
 *
 * Run: node --test test/router.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Router } from '../lib/router.mjs'

const CONFIG = { server: { model: 'gemini-web' } }

function stubWeb({ text = 'WEB', error = null } = {}) {
  const fakeAccount = { name: 'acct', guard: null, session: null, pausedUntil: 0 }
  return {
    manager: {
      describeAll: () => [{ name: 'acct', session: { ready: true }, pausedUntil: null }],
      pickAccountByName: () => fakeAccount,
      recovered: () => true,
      nextUnpauseInMs: () => 60000,
    },
    async openCompletion(_messages) {
      if (error) throw error
      // Web client shape: sync iterator of { delta: string, done: boolean }
      const events = [{ delta: text, done: false }, { delta: '', done: true }]
      return { account: fakeAccount, iterator: events[Symbol.iterator]() }
    },
  }
}

function stubAgy({ events = null, error = null } = {}) {
  return {
    describe: () => ({ enabled: true, models: ['claude-sonnet-4-6'], token: { loaded: true } }),
    poolResume: () => false,
    async *complete(_payload) {
      if (error) throw error
      for (const e of events ?? [{ delta: { content: 'AGY' }, done: false }, { delta: {}, finishReason: 'stop', usage: { prompt_tokens: 1 }, done: true }]) {
        yield e
      }
    },
  }
}

async function drain(iterator) {
  const out = []
  let finish = null
  let usage = null
  for await (const ev of iterator) {
    if (ev.delta?.content) out.push(ev.delta.content)
    if (ev.finishReason) finish = ev.finishReason
    if (ev.usage) usage = ev.usage
  }
  return { text: out.join(''), finish, usage }
}

describe('Router channel selection', () => {
  it('default / gemini-web -> web channel', async () => {
    const r = new Router({ config: CONFIG, webClient: stubWeb({ text: 'W' }), agyClient: stubAgy() })
    const opened = await r.openCompletion({ model: 'gemini-web', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(opened.channel, 'web')
    const { text, finish } = await drain(opened.iterator)
    assert.equal(text, 'W')
    assert.equal(finish, 'stop')
  })

  it('agy catalog model -> agy channel', async () => {
    const r = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: stubAgy() })
    const opened = await r.openCompletion({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'x' }] })
    assert.equal(opened.channel, 'agy')
    const { text, usage } = await drain(opened.iterator)
    assert.equal(text, 'AGY')
    assert.deepEqual(usage, { prompt_tokens: 1 })
  })

  it('unknown model goes to agy when available (404 honest), else web', async () => {
    const both = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: stubAgy() })
    assert.equal(both.channelFor('mystery-model'), 'agy')
    const webOnly = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: null })
    assert.equal(webOnly.channelFor('mystery-model'), 'web')
  })

  it('no web account but agy live -> agy models only on /v1/models', async () => {
    const r = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: stubAgy() })
    const names = r.models()
    assert.equal(names[0], 'gemini-web')
    assert.ok(names.includes('claude-sonnet-4-6'))
    const webOnly = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: null })
    assert.deepEqual(webOnly.models(), ['gemini-web'])
  })

  it('first-event pre-fetch means refusals throw before iteration', async () => {
    const r = new Router({ config: CONFIG, webClient: stubWeb({ error: new Error('boom') }), agyClient: stubAgy() })
    await assert.rejects(() => r.openCompletion({ model: 'gemini-web', messages: [] }), /boom/)
  })

  it('agy mid-stream error surfaces at first iterator pull', async () => {
    const r = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: stubAgy({ error: Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }) }) })
    // The throw happens inside complete() before the first event, and the
    // router pre-fetches -> openCompletion itself rejects.
    await assert.rejects(() => r.openCompletion({ model: 'claude-sonnet-4-6', messages: [] }), /RESOURCE_EXHAUSTED/)
  })

  it('health passthrough merges web accounts + agy describe', () => {
    const r = new Router({ config: CONFIG, webClient: stubWeb(), agyClient: stubAgy() })
    const d = r.describeAll()
    assert.equal(d.accounts.length, 1)
    assert.equal(d.agy.token.loaded, true)
  })
})
