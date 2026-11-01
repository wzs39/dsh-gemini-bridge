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

/**
 * Regression: pick() used to look only at `pausedUntil` and ignore each
 * account's own guard. With the shipped defaults (`requestsPerDay: 20`,
 * `budgetWindowsPerDay: 24` => 1 request per account per hour) the first
 * account to spend its window aborted the call with WINDOW_BUDGET while two
 * healthy siblings sat idle — measured live on three Pro accounts.
 */
describe('AccountManager: per-account quota must not block siblings', () => {
  let manager, config

  // One request per account per window, so the second call must rotate.
  const quotaConfig = () => {
    const base = makeConfig()
    return {
      ...base,
      protection: {
        ...base.protection,
        requestsPerDay: 24,
        budgetWindowsPerDay: 24,   // => windowCap 1
        requestsPerHour: 100,
        minGapMs: 0,
        maxGapMs: 0,
        minTurnCycleMs: 0,
      },
      accounts: [
        { name: 'q-a', label: 'Quota A' },
        { name: 'q-b', label: 'Quota B' },
        { name: 'q-c', label: 'Quota C' },
      ],
    }
  }

  before(() => {
    config = quotaConfig()
    manager = new AccountManager(config)
  })

  after(() => {
    manager.stopAll()
    fs.rmSync(config.paths.logs, { recursive: true, force: true })
  })

  it('an account whose window is spent is skipped, not returned', async () => {
    const first = manager.pick()
    assert.ok(first, 'first pick must succeed')
    await first.guard.admit()   // consume the single per-window slot
    assert.equal(first.guard.availability().ok, false, 'sanity: window is now spent')

    const second = manager.pick()
    assert.ok(second, 'a sibling with quota left must be picked')
    assert.notEqual(second.name, first.name, 'must not hand back the spent account')
  })

  it('all three windows spent -> pick() returns null and says why', async () => {
    // q-a's window was consumed by the previous test. Drain whatever is left
    // rather than re-admitting a spent account (which throws by design).
    for (const d of manager.describeAll()) {
      const a = manager.pickAccountByName(d.name)
      if (a.guard.availability().ok) await a.guard.admit()
    }
    assert.equal(manager.pick(), null)

    const reasons = manager.parkReasonFor()
    assert.equal(reasons.length, 3, 'every blocked account must be reported')
    for (const r of reasons) assert.match(r, /window budget spent/, `unexpected reason: ${r}`)

    assert.ok(manager.nextUnpauseInMs() > 0, 'retry-after must be a real wait')
  })

  it('a parked account still wins the reason report over a quota block', () => {
    const acct = manager.pickAccountByName('q-a')
    acct.pausedUntil = Date.now() + 60000
    acct.pauseReason = 'unusual traffic'
    const reasons = manager.parkReasonFor()
    assert.ok(reasons.some(r => r.includes('unusual traffic')), `got: ${reasons.join(' | ')}`)
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

  it('quota groups drive per-group usability, not a single boolean', () => {
    // A real account can serve gemini while its anthropic/openai quota is at 0
    // (observed live). A single account-level boolean hides exactly that, which
    // is how the dashboard used to claim "ready" for a partly-dead account.
    writePoolFile([
      {
        id: 'acc_split', alias: 'Split', email: 'split@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: {
          google: {
            remainingFraction: 0.99, resetTime: new Date(Date.now() + 3600_000).toISOString(),
            models: [{ modelId: 'gemini-3.8-flash-high', remainingFraction: 0.99 }],
          },
          anthropic: {
            remainingFraction: 0, resetTime: new Date(Date.now() + 3600_000).toISOString(),
            models: [{ modelId: 'claude-sonnet-4-6', remainingFraction: 0 }],
          },
        },
        cooldowns: {
          anthropic: { cooldownUntil: Date.now() + 3600_000, reason: 'quota' },
        },
      },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
    const d = p.describeAll()[0]
    const byGroup = Object.fromEntries(d.quota.groups.map(g => [g.group, g]))
    assert.equal(byGroup.google.usable, true, 'a group with quota left stays usable')
    assert.equal(byGroup.anthropic.usable, false, 'an exhausted group must not report usable')
    assert.equal(byGroup.anthropic.exhausted, true)
    assert.equal(byGroup.anthropic.cooling, true)
    assert.equal(d.usable, true, 'the account is usable while at least one group can serve')
  })

  it('an account whose every quota group is exhausted is not usable', () => {
    writePoolFile([
      {
        id: 'acc_dead', alias: 'Dead', email: 'dead@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: {
          google: { remainingFraction: 0, resetTime: new Date(Date.now() + 3600_000).toISOString(), models: [] },
        },
        cooldowns: {},
      },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
    assert.equal(p.describeAll()[0].usable, false, 'all groups empty -> account unusable')
  })

  it('a parked account is never usable, even with full quota', () => {
    writePoolFile([
      {
        id: 'acc_parked', alias: 'Parked', email: 'parked@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: { google: { remainingFraction: 1, models: [] } },
        cooldowns: {},
      },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
    const acct = p.pick()
    p.pause(acct, 60_000, 'auth')
    const d = p.describeAll()[0]
    assert.equal(d.usable, false, 'a parked account must not be reported usable')
    assert.ok(d.pausedUntil)
    assert.equal(d.pauseReason, 'auth')
  })

  it('missing quota data falls back to credential+park, not a fake green', () => {
    // pool.json written by an older dsh-agy-link may carry no quotas at all.
    // Missing data must not be reported as unusable (it may well work), and it
    // must not be reported as fresh quota either.
    writePoolFile([
      { id: 'acc_noq', alias: 'NoQuota', email: 'noq@example.com', enabled: true, dir: path.join(tmpDir, 'acc_b') },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
    const d = p.describeAll()[0]
    assert.deepEqual(d.quota.groups, [], 'no quota data -> empty groups')
    assert.equal(d.usable, true, 'credential present and not parked -> usable')
  })

  it('the 5h and weekly windows surface as separate buckets', () => {
    // Real pool.json shape (verified on this machine): a group carries
    // remainingFraction (5h window) and weeklyFraction (weekly window) as two
    // flat fields — there is NO buckets[] array in the file. The 5h field is
    // what decides "can I generate right now"; weekly decides "how long will
    // this account last". Collapsing them hides the blocking state.
    writePoolFile([
      {
        id: 'acc_buckets', alias: 'B', email: 'b@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: {
          anthropic: {
            remainingFraction: 0,
            resetTime: '2026-11-01T19:48:16Z',
            weeklyFraction: 1,
            weeklyResetTime: '2026-11-08T00:26:24Z',
          },
        },
      },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
    const g = p.describeAll()[0].quota.groups[0]
    assert.equal(g.buckets.length, 2, 'both windows surface as buckets')
    const five = g.buckets.find(b => b.window === '5h')
    const weekly = g.buckets.find(b => b.window === 'weekly')
    assert.equal(five.remaining, 0, '5h window empty')
    assert.equal(weekly.remaining, 1, 'weekly window still full')
    // The group's effective remaining MUST follow the 5h window: weekly full but
    // 5h empty means generation is blocked right now.
    assert.equal(g.remaining, 0, 'group remaining follows the 5h window')
    assert.equal(g.usable === undefined || g.usable === false, true, 'an empty 5h window blocks the group')
  })

  it('groupForModel routes claude/gpt-oss to 3p and gemini to gemini', () => {
    assert.equal(AgyPool.groupForModel('gemini-3.8-flash-medium'), 'gemini')
    assert.equal(AgyPool.groupForModel('gemini-3-flash'), 'gemini')
    assert.equal(AgyPool.groupForModel('claude-sonnet-4-6'), '3p')
    assert.equal(AgyPool.groupForModel('claude-opus-4-6-thinking'), '3p')
    assert.equal(AgyPool.groupForModel('gpt-oss-120b-medium'), '3p')
  })

  it('pickForModel skips an account whose model bucket is exhausted', () => {
    // The live failure this fixes: two accounts had 3p quota, one was empty,
    // and a model-blind pick handed out the empty one -> 429 "Resets in 1h23m"
    // even though the model was available elsewhere.
    fs.mkdirSync(path.join(tmpDir, 'acc_b', '.gemini', 'antigravity-cli'), { recursive: true })
    writePoolFile([
      {
        id: 'acc_3p_empty', alias: 'Empty3p', email: 'empty@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: {
          anthropic: { remainingFraction: 0, weeklyFraction: 1 },
          google: { remainingFraction: 1, weeklyFraction: 1 },
        },
        cooldowns: {},
      },
      {
        id: 'acc_3p_ok', alias: 'Ok3p', email: 'ok@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: {
          anthropic: { remainingFraction: 0.9, weeklyFraction: 0.8 },
          google: { remainingFraction: 0.2, weeklyFraction: 0.9 },
        },
        cooldowns: {},
      },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })

    // claude must skip the 3p-empty account...
    const forClaude = p.pickForModel('claude-sonnet-4-6')
    assert.equal(forClaude.id, 'acc_3p_ok', 'claude must be routed to the account with 3p quota')

    // ...while gemini prefers the account with more gemini headroom.
    const forGemini = p.pickForModel('gemini-3.8-flash-medium')
    assert.equal(forGemini.id, 'acc_3p_empty', 'gemini picks by gemini quota, not 3p')
  })

  it('eligibleForModel reports per-account availability for a model family', () => {
    fs.mkdirSync(path.join(tmpDir, 'acc_b', '.gemini', 'antigravity-cli'), { recursive: true })
    writePoolFile([
      {
        id: 'a1', alias: 'A1', email: 'a1@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: { anthropic: { remainingFraction: 0, weeklyFraction: 0.5 } },
      },
      {
        id: 'a2', alias: 'A2', email: 'a2@example.com', enabled: true,
        dir: path.join(tmpDir, 'acc_b'),
        quotas: { anthropic: { remainingFraction: 0.5, weeklyFraction: 0.5 } },
      },
    ])
    const p = new AgyPool({ config: { agy: { poolFile: path.join(tmpDir, 'pool.json') } } })
    const rows = p.eligibleForModel('claude-sonnet-4-6')
    assert.equal(rows.find(r => r.id === 'a1').usable, false, 'empty 3p 5h window is not usable for claude')
    assert.equal(rows.find(r => r.id === 'a2').usable, true)
  })
})
