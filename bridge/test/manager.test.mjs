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
