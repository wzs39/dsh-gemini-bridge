/**
 * test/guard.test.mjs — unit tests for the guard.
 *
 * Run: node --test test/guard.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Guard, GuardError } from '../lib/guard.mjs'

function makeConfig(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'))
  return {
    paths: { logs: tmpDir, state: path.join(tmpDir, 'state.json') },
    protection: {
      requestsPerDay: 10,
      minGapMs: 0,
      maxGapMs: 10,
      failureBreakerAt: 2,
      failureBreakerCooldownMs: 60000,
      budgetWindowsPerDay: 24,
      requestsPerHour: 5,
      burstWindowMs: 0,    // disable burst for unit tests
      burstRestMs: 0,
      burstIdleResetMs: 0,
      minTurnCycleMs: 0,
      maxInlineWaitMs: 5000,
      maxConcurrentWaiters: 1,
      anomalyThreshold: 4,
    },
    ...overrides,
  }
}

describe('Guard', () => {
  let guard, config

  before(() => {
    config = makeConfig()
    guard = new Guard(config)
  })

  after(() => {
    guard.stop()
    fs.rmSync(config.paths.logs, { recursive: true, force: true })
  })

  it('admits first request', async () => {
    const status = await guard.admit()
    assert.equal(status.requestsToday, 1)
  })

  it('succeeds and resets consecutive failures', async () => {
    guard.failed(0)
    guard.succeeded()
    const s = guard.status()
    assert.equal(s.consecutiveFailures, 0)
  })

  it('applies cooldown on 429', async () => {
    guard.failed(429)
    const s = guard.status()
    assert.ok(s.cooldownSeconds > 0, 'should have cooldown after 429')
  })

  it('allows manual reset', async () => {
    guard.reset()
    const s = guard.status()
    assert.equal(s.cooldownSeconds, 0)
    assert.equal(s.level, 0)
  })

  it('respects budget caps', async () => {
    // Drain until ANY budget guard fires (window or daily).
    guard.reset()
    const budget = config.protection.requestsPerDay
    let fired = false
    for (let i = 0; i < budget + 5; i++) {
      try { await guard.admit() } catch (e) {
        // Accept WINDOW_BUDGET, BUDGET or HOURLY_RATE as expected.
        assert.ok(
          /budget|rate/i.test(e.message),
          `unexpected guard error: ${e.message}`,
        )
        fired = true
        break
      }
    }
    assert.ok(fired, 'a budget guard should have fired before budget+5 requests')
  })
})

/**
 * Anomaly scoring.
 *
 * Measured regression: a burst of 20 requests ended with all three Pro accounts
 * parked for ~65 minutes. The cause was scoring the FIRST empty answer (weight
 * 2) AND the failed retry (weight 2) on the same request -- 4 points, the whole
 * threshold, from one hiccup. A transient upstream blip must not cost an hour.
 */
describe('Guard: anomaly scoring must need a repeated signal', () => {
  let guard, config

  before(() => {
    config = makeConfig()
    guard = new Guard(config)
  })

  after(() => {
    guard.stop()
    fs.rmSync(config.paths.logs, { recursive: true, force: true })
  })

  it('the threshold equals two weighted signals', () => {
    assert.equal(config.protection.anomalyThreshold, 4)
  })

  it('one signal (weight 2) does not park the account', () => {
    guard.reset()
    guard.anomaly('empty-answer-confirmed', 2)
    assert.equal(guard.status().cooldownSeconds, 0, 'a single signal must not park')
    assert.equal(guard.status().anomalyScore, 2, 'but it is remembered')
  })

  it('a second signal trips exactly one cooldown', () => {
    guard.anomaly('empty-answer-confirmed', 2)
    assert.ok(guard.status().cooldownSeconds > 0, 'two signals must park')
  })

  it('the score resets after tripping, so it cannot re-arm forever', () => {
    // Without the reset, one more empty answer would immediately re-punish and
    // an account could never climb out of the hole.
    assert.equal(guard.status().anomalyScore, 0, 'score must reset after punish')
    guard.anomaly('empty-answer-confirmed', 2)
    assert.equal(guard.status().anomalyScore, 2)
    guard.anomaly('empty-answer-confirmed', 2)
    // Second trip while already parked must not extend the existing window.
    const first = guard.status().cooldownSeconds
    guard.anomaly('empty-answer-confirmed', 2)
    guard.anomaly('empty-answer-confirmed', 2)
    assert.ok(
      guard.status().cooldownSeconds <= first + 2,
      'a trip during an existing park must not meaningfully extend it',
    )
  })

  it('a success decays the score back toward zero', () => {
    guard.reset()
    guard.anomaly('x', 2)
    assert.equal(guard.status().anomalyScore, 2)
    guard.succeeded()
    assert.equal(guard.status().anomalyScore, 0, 'success decays by 2')
  })
})
