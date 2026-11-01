/**
 * test/manager.test.mjs — account rotation & parking tests (stubbed sessions).
 *
 * Run: node --test test/manager.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AccountManager } from '../lib/manager.mjs'
import { AgyPool } from '../lib/agytoken.mjs'

function makeConfig() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-test-'))
  return {
    paths: { logs: tmpDir, state: path.join(tmpDir, 'state.json') },
    browser: { port: 9400, executable: null, headless: true, args: [], userDataDir: null },
    protection: {
      requestsPerDay: 100,
      minGapMs: 0,
      maxGapMs: 1,
      failureBreakerAt: 99,
      failureBreakerCooldownMs: 1000,
      budgetWindowsPerDay: 24,
      requestsPerHour: 50,
      burstWindowMs: 0,
      burstRestMs: 0,
      burstIdleResetMs: 0,
      minTurnCycleMs: 0,
      maxInlineWaitMs: 100,
      maxConcurrentWaiters: 4,
      anomalyThreshold: 100,
    },
    behaviour: { tokenTtlMs: 3600000, completionTimeoutMs: 1000 },
    upstream: { origin: 'https://example.invalid', appPath: '/app' },
    accounts: [
      { name: 'pro-a', label: 'Pro account A' },
      { name: 'pro-b', label: 'Pro account B' },
    ],
  }
}

describe('AccountManager', () => {
  let manager, config

  before(() => {
    config = makeConfig()
    manager = new AccountManager(config)
  })

  after(() => {
    manager.stopAll()
    fs.rmSync(config.paths.logs, { recursive: true, force: true })
  })

  it('creates one entry per account with isolated ports and profiles', () => {
    const a = manager.pickAccountByName('pro-a')
    const b = manager.pickAccountByName('pro-b')
    assert.ok(a && b)
    assert.notEqual(a.config.browser.port, b.config.browser.port)
    assert.notEqual(a.config.browser.userDataDir, b.config.browser.userDataDir)
    assert.notEqual(a.config.paths.logs, b.config.paths.logs)
  })

  it('round-robins across accounts', () => {
    const first = manager.pick()
    const second = manager.pick()
    assert.notEqual(first.name, second.name, 'two picks should land on different accounts')
  })

  it('a captcha verdict parks the account and rotation skips it', () => {
    const account = manager.pick()
    const verdict = manager.report(account, { status: 200, raw: 'detected unusual traffic' })
    assert.equal(verdict.class, 'captcha')
    assert.ok(account.pausedUntil > Date.now())

    // The remaining live account must now be picked consistently.
    const other = manager.pick()
    for (let i = 0; i < 5; i++) assert.equal(manager.pick().name, other.name)
  })

  it('nextUnpauseInMs reports the soonest release', () => {
    assert.ok(manager.nextUnpauseInMs() > 0)
  })

  it('recovered() unparks and lifts the auth pause', () => {
    const parked = manager.describeAll().find(d => d.pausedUntil)
    assert.ok(parked, 'expected a parked account')
    assert.ok(manager.recovered(parked.name))
    const acct = manager.pickAccountByName(parked.name)
    assert.equal(acct.pausedUntil, 0)
    assert.equal(acct.pauseReason, null)
  })

  it('all parked -> pick() returns null', () => {
    for (const d of manager.describeAll()) {
      const a = manager.pickAccountByName(d.name)
      manager.report(a, { status: 429 })
    }
    assert.equal(manager.pick(), null)
    // Clean up: unpark for the next tests.
    for (const d of manager.describeAll()) manager.recovered(d.name)
  })

  it('upstream_fault does not park anything', () => {
    const before = manager.pickAccountByName('pro-a').pausedUntil
    manager.report(manager.pickAccountByName('pro-a'), { status: 503 })
    assert.equal(manager.pickAccountByName('pro-a').pausedUntil, before)
  })

  it('describeAll exposes no cookie secrets', () => {
    const text = JSON.stringify(manager.describeAll())
    assert.ok(!text.includes('Secure-1PSID='), 'health output must not carry cookie values')
  })
})

describe('AgyPool (dsh-agy-link pool.json consumer)', () => {
  let tmpDir
  let pool

  function writePoolFile(accounts) {
    fs.writeFileSync(path.join(tmpDir, 'pool.json'), JSON.stringify({
      version: 1, mode: 'sequential',
      accounts,
      activeAccountIds: {}, primaryAccountId: accounts[0]?.id ?? null,
    }))
  }

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-'))
    // Two enabled accounts (one systemHome, one dir-based) + one disabled.
    fs.mkdirSync(path.join(tmpDir, 'acc_b', '.gemini', 'antigravity-cli'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'acc_b', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'a_b', refresh_token: 'r_b', expiry: new Date(Date.now() + 3600_000).toISOString() }, auth_method: 'consumer' }),
    )
    writePoolFile([
      { id: 'acc_primary', alias: 'Primary', email: 'p@example.com', systemHome: true, enabled: true },
      { id: 'acc_b', alias: 'Backup', email: 'b@example.com', dir: path.join(tmpDir, 'acc_b'), enabled: true },
      { id: 'acc_off', alias: 'Off', dir: path.join(tmpDir, 'acc_off'), enabled: false },
    ])
    pool = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
  })

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads enabled accounts only', () => {
    assert.equal(pool.count, 2)
    const ids = pool.describeAll().map(a => a.id)
    assert.ok(ids.includes('acc_primary') && ids.includes('acc_b'))
    assert.ok(!ids.includes('acc_off'))
  })

  it('dir-based account reads its token file; systemHome reports not-loaded in test env', () => {
    const d = pool.describeAll()
    const b = d.find(a => a.id === 'acc_b')
    assert.equal(b.token.loaded, true)
    const p = d.find(a => a.id === 'acc_primary')
    // systemHome resolves to the real user HOME; on CI/test machines without
    // an agy login it is simply not loaded -- the status stays honest.
    assert.equal(typeof p.token.loaded, 'boolean')
  })

  it('describeAll carries no token material', () => {
    const text = JSON.stringify(pool.describeAll())
    assert.ok(!text.includes('a_b') && !text.includes('r_b'), 'token values must never appear in status output')
  })

  it('round-robins and preserves pause across reload()', () => {
    const first = pool.pick()
    assert.ok(first)
    pool.pause(first, 60_000, 'test-park')
    assert.equal(pool.pick().id !== first.id || pool.count === 1, true)
    // reload(): same file, pause state survives for surviving ids.
    pool.reload()
    const d = pool.describeAll().find(a => a.id === first.id)
    assert.ok(d.pausedUntil, 'pause must survive reload')
    // cleanup
    pool.resume(first.id)
  })

  it('resume clears the park', () => {
    const a = pool.pick()
    pool.pause(a, 60_000, 'x')
    assert.ok(pool.resume(a.id))
    assert.equal(pool.describeAll().find(x => x.id === a.id).pausedUntil, null)
  })

  it('all parked -> pick() returns null with a wait estimate', () => {
    // Park every account through a client-style pause on real references:
    // pick twice to capture both account objects (pool has exactly 2 here).
    const seen = new Set()
    for (let i = 0; i < pool.count; i++) {
      const a = pool.pick()
      if (a) { seen.add(a.id); pool.pause(a, 60_000, 'x') }
    }
    assert.equal(seen.size, pool.count, 'every account should have been parked')
    assert.equal(pool.pick(), null, 'no account may be picked while all are parked')
    assert.ok(pool.nextUnpauseInMs() > 0, 'nextUnpauseInMs reflects the soonest release')
    for (const id of seen) pool.resume(id)
    assert.ok(pool.pick(), 'after resume, picks work again')
  })

  it('missing pool file -> empty pool (serve falls back to single mode)', () => {
    const empty = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'nope.json') } } })
    assert.equal(empty.count, 0)
    assert.equal(empty.pick(), null)
  })
})
