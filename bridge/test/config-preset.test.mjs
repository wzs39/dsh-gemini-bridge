/**
 * test/config-preset.test.mjs — pacing preset expansion.
 *
 * The preset layer exists because the protection fields are interlocked and
 * the interaction is a trap:
 *
 *   windowCap = ceil(requestsPerDay / budgetWindowsPerDay)
 *
 * With the old shipped defaults (20 / 24) that is ceil(0.83) = 1, so the config
 * claimed "20 per day" while enforcing "1 per hour" — the daily allowance was
 * literally unreachable, and a normal chat burst hit WINDOW_BUDGET. Measured
 * live: pro1 spent its single slot and the next request 429'd while two Pro
 * accounts sat idle.
 *
 * These tests pin the arithmetic so a future preset cannot reintroduce it.
 *
 * Run: node --test test/config-preset.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig } from '../lib/config.mjs'

const tmpConfigs = []
function configWith(protection) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify({ protection }))
  tmpConfigs.push(dir)
  return loadConfig(file)
}

/** ceil() semantics, restated here so the test does not import the impl. */
const windowCapOf = (perDay, windows) => Math.ceil(perDay / windows)

describe('pacing presets', () => {
  it('balanced is the default when nothing is configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-test-'))
    tmpConfigs.push(dir)
    const c = loadConfig(path.join(dir, 'does-not-exist.json'))
    assert.equal(c.protection.appliedPreset, 'balanced')
  })

  for (const [name, perDay, perHour, windows] of [
    ['cautious', 40, 6, 24],
    ['balanced', 120, 12, 24],
    ['brisk', 400, 30, 24],
  ]) {
    it(`${name}: expands to real numbers and a truthful daily ceiling`, () => {
      const c = configWith({ preset: name })
      const p = c.protection
      assert.equal(p.appliedPreset, name)
      assert.equal(p.requestsPerDay, perDay)
      assert.equal(p.requestsPerHour, perHour)
      assert.equal(p.budgetWindowsPerDay, windows)
      assert.equal(p.effectiveWindowCap, windowCapOf(perDay, windows))
      assert.equal(p.effectiveCeilingPerDay, p.effectiveWindowCap * windows)

      // Every gate must be a real number: a null reaching the guard would mean
      // "no limit" and silently disable protection.
      for (const key of ['requestsPerDay', 'requestsPerHour', 'budgetWindowsPerDay',
        'minGapMs', 'maxGapMs', 'burstWindowMs', 'burstRestMs',
        'burstIdleResetMs', 'minTurnCycleMs']) {
        assert.equal(typeof p[key], 'number', `${name}.${key} must be a number`)
      }

      // A preset must be usable: at least one request per window, and the gap
      // must not exceed the window (otherwise the window gate is unreachable).
      assert.ok(p.effectiveWindowCap >= 1, `${name} must allow >=1 per window`)
      assert.ok(p.minGapMs <= p.maxGapMs, `${name} gap range is inverted`)
    })
  }

  it('the shipped presets never reproduce the ceil(20/24)=1 trap', () => {
    // The exact numeric defect that made a three-account pool behave like one
    // account: a sub-1 ratio silently rounds up to 1/hour.
    for (const name of ['cautious', 'balanced', 'brisk']) {
      const c = configWith({ preset: name })
      const p = c.protection
      const ratio = p.requestsPerDay / p.budgetWindowsPerDay
      assert.ok(
        ratio >= 1,
        `${name}: ${p.requestsPerDay}/${p.budgetWindowsPerDay} = ${ratio} < 1 — `
        + 'windowCap rounds to 1/h and the daily budget becomes unreachable',
      )
      assert.ok(
        p.effectiveCeilingPerDay >= p.requestsPerDay,
        `${name}: effective ceiling ${p.effectiveCeilingPerDay} must not be below `
        + `the configured ${p.requestsPerDay}`,
      )
    }
  })

  it('an explicit value overrides the preset', () => {
    const c = configWith({ preset: 'brisk', requestsPerHour: 3, minGapMs: 30000 })
    const p = c.protection
    assert.equal(p.requestsPerHour, 3, 'explicit requestsPerHour must win')
    assert.equal(p.minGapMs, 30000, 'explicit minGapMs must win')
    // Untouched fields still come from the preset.
    assert.equal(p.requestsPerDay, 400)
    assert.equal(p.appliedPreset, 'brisk')
  })

  it('rejects an unknown preset instead of silently running unprotected', () => {
    assert.throws(
      () => configWith({ preset: 'turbo-nonsense' }),
      /unknown protection\.preset/,
    )
  })

  it('brisk is strictly more permissive than balanced, which beats cautious', () => {
    const cau = configWith({ preset: 'cautious' }).protection
    const bal = configWith({ preset: 'balanced' }).protection
    const bri = configWith({ preset: 'brisk' }).protection
    for (const key of ['requestsPerDay', 'requestsPerHour', 'effectiveWindowCap']) {
      assert.ok(cau[key] < bal[key], `cautious.${key} < balanced.${key}`)
      assert.ok(bal[key] < bri[key], `balanced.${key} < brisk.${key}`)
    }
    // Gaps shrink as throughput rises.
    assert.ok(cau.minGapMs > bal.minGapMs && bal.minGapMs > bri.minGapMs)
  })
})

describe('pacing presets: failure reaction stays preset-independent', () => {
  it('the breaker is identical across every preset', () => {
    // Throughput is a tuning choice; how fast a hard-stop signal parks an
    // account is not. A "faster" preset must never weaken the breaker.
    const values = ['cautious', 'balanced', 'brisk'].map(name => {
      const p = configWith({ preset: name }).protection
      return { at: p.failureBreakerAt, cooldown: p.failureBreakerCooldownMs, anomaly: p.anomalyThreshold }
    })
    for (const v of values) {
      assert.deepEqual(v, values[0], 'breaker settings must not vary by preset')
    }
    assert.equal(values[0].at, 2)
    assert.equal(values[0].anomaly, 4)
  })
})

// Cleanup temp dirs created by configWith().
process.on('exit', () => {
  for (const dir of tmpConfigs) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})
