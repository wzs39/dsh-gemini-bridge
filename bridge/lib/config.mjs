/**
 * Configuration loader.
 *
 * Reads `config.json` from the project root, applies defaults, and freezes the
 * result so callers cannot accidentally mutate shared state.
 *
 * @module gemini-web-bridge/lib/config
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const DEFAULTS = {
  upstream: {
    origin: 'https://gemini.google.com',
    appPath: '/app',
    batchExecutePath: '/_/BardChatUi/data/batchexecute',
    rpcid: 'entertg',
  },
  browser: {
    executable: null,
    headless: false,
    port: 9334,
    args: [],
    userDataDir: null,
  },
  server: {
    host: '127.0.0.1',
    port: 18901,
    apiKey: 'sk-local-gemini-web',
    model: 'gemini-web',
  },
  behaviour: {
    keepAliveSeconds: 900,
    // Total cap for one completion. Kept generous: this is a backstop against a
    // hung socket, NOT a length limit. A fixed 120s used to kill long-but-healthy
    // generations mid-stream (measured: a 1500-line answer was cut at 40530 chars
    // with finishReason never arriving). Real liveness is judged by
    // streamIdleTimeoutMs below.
    completionTimeoutMs: 1800000,
    // Abort only after this long with NO bytes from upstream. A long answer keeps
    // resetting it, so generation length stops being a death sentence while a
    // genuinely stalled stream still fails fast.
    streamIdleTimeoutMs: 120000,
    tokenTtlMs: 3600000,
    emptyRetries: 1,
  },
  // Multi-account rotation. Each entry gets its own browser CDP port
  // (root port + i*10), its own profile directory and its own guard state.
  // Empty/absent == single anonymous "default" account.
  accounts: [],
  protection: {
    // ---------------------------------------------------------------------
    // Pacing preset. `protection.preset` expands to the numbers below; any key
    // you set explicitly still wins, so this is a starting point, not a lock.
    //
    // Why this exists: the fields are interlocked and the interaction is not
    // obvious. The killer was `windowCap = ceil(requestsPerDay /
    // budgetWindowsPerDay)`. With the old defaults (20 / 24) that is ceil(0.83)
    // = 1, i.e. "one request per account per hour" -- while the config said
    // "20 per day". The daily allowance was unreachable and a normal chat burst
    // hit WINDOW_BUDGET. A real Pro user sending one message every ~20s is far
    // above that. Tuning one number by hand silently breaks another.
    //
    //   cautious  -- new profile / new login, first week
    //   balanced  -- DEFAULT: normal heavy personal use
    //   brisk     -- long agent runs; still keeps a human shape
    //
    // The gates that actually protect the account are pacing gap, hourly rate
    // and burst rest — NOT the daily cap. A preset raises throughput by widening
    // the daily/window allowance while keeping every anti-fingerprint gate.
    // ---------------------------------------------------------------------
    preset: 'balanced',
    presets: {
      cautious: {
        requestsPerDay: 40,
        budgetWindowsPerDay: 24,      // -> windowCap ceil(40/24) = 2/h
        requestsPerHour: 6,
        minGapMs: 15000,
        maxGapMs: 45000,
        burstWindowMs: 1200000,       // 20 min of activity
        burstRestMs: 480000,          // then rest 8 min
        burstIdleResetMs: 600000,
        minTurnCycleMs: 15000,
      },
      balanced: {
        requestsPerDay: 120,
        budgetWindowsPerDay: 24,      // -> windowCap ceil(120/24) = 5/h
        requestsPerHour: 12,
        minGapMs: 6000,
        maxGapMs: 18000,
        burstWindowMs: 1800000,       // 30 min of activity
        burstRestMs: 300000,          // then rest 5 min
        burstIdleResetMs: 600000,
        minTurnCycleMs: 8000,
      },
      brisk: {
        requestsPerDay: 400,
        budgetWindowsPerDay: 24,      // -> windowCap ceil(400/24) = 17/h
        requestsPerHour: 30,
        minGapMs: 2000,
        maxGapMs: 6000,
        burstWindowMs: 2400000,       // 40 min of activity
        burstRestMs: 180000,          // then rest 3 min
        burstIdleResetMs: 900000,     // a 15 min gap resets the burst window
        minTurnCycleMs: 3000,
      },
    },
    // Explicit values below override the preset. Left as null == "take it from
    // the preset" so /health can report which preset actually applied.
    requestsPerDay: null,
    requestsPerHour: null,
    budgetWindowsPerDay: null,
    minGapMs: null,
    maxGapMs: null,
    // These are failure reactions, not pacing: keep them identical in every
    // preset. A hard-stop signal parks the account regardless of throughput.
    failureBreakerAt: 2,
    failureBreakerCooldownMs: 3600000,
    burstWindowMs: null,
    burstRestMs: null,
    burstIdleResetMs: null,
    minTurnCycleMs: null,
    maxInlineWaitMs: 120000,
    maxConcurrentWaiters: 1,
    // Anomaly score that trips a cooldown. Each empty answer adds 2, each
    // success decays 2; 4 == "two empty answers with no success between".
    // This is the soft-ban detector: Google degrades before it ever returns
    // an error, so a 200-with-nothing is treated as a refusal signal.
    anomalyThreshold: 4,
  },
  // agy (Antigravity) upstream channel: reuses this machine's agy CLI OAuth
  // credential and talks to v1internal directly. The region gate lives in the
  // CLI only -- verified live (tools/probe-agy-upstream.ps1 -> HTTP 200).
  // Set enabled=false to run web-channel-only.
  agy: {
    enabled: true,
    project: 'aicode-consumers',
    defaultModel: 'gemini-3.8-flash-medium',
    tokenFile: null, // null -> ~/.gemini/antigravity-cli/antigravity-oauth-token
    poolFile: null, // null -> auto: use ~/.dsh/agy-accounts/pool.json when present, else single-account mode
  },
  paths: {
    logs: path.join(ROOT, 'logs'),
    state: path.join(ROOT, 'state.json'),
  },
  debug: {
    capture: false,
  },
}

function mergeDeep(base, overrides) {
  const result = { ...base }
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (v === undefined) continue
    // `null` is an explicit "unset this" marker, not "no opinion". It must
    // propagate so DEFAULTS' null placeholders (protection's preset-managed
    // fields) do not shadow the user's value. Objects still recurse.
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] !== null) {
      result[k] = mergeDeep(base[k], v)
    } else {
      result[k] = v
    }
  }
  // Anything not overridden still points at the DEFAULTS sub-object. Callers
  // mutate the merged result (applyPacingPreset does), so hand back a deep
  // clone: a shallow copy here let the FIRST loadConfig() permanently bake its
  // preset into the module-level DEFAULTS, and every later load in the same
  // process then ignored its own `protection.preset`. Only visible when
  // loadConfig() ran twice -- exactly what a test suite and a reloading host do.
  return structuredClone(result)
}

/**
 * Expand `protection.preset` into concrete numbers.
 *
 * Explicit non-null overrides always win, so a hand-tuned value is never
 * silently replaced. The expansion happens on the MERGED object, which means
 * the preset is applied even when config.json only names it.
 */
function applyPacingPreset(merged) {
  const prot = merged.protection
  if (!prot) return
  const name = prot.preset ?? 'balanced'
  const table = prot.presets ?? {}
  const preset = table[name]
  if (!preset) {
    throw new Error(
      `unknown protection.preset "${name}"; known: ${Object.keys(table).join(', ') || '(none)'}`,
    )
  }

  // Record what was actually applied before overwriting with numbers.
  prot.appliedPreset = name

  for (const [key, value] of Object.entries(preset)) {
    if (prot[key] === null || prot[key] === undefined) prot[key] = value
  }

  // A leftover null in a gate means "no limit", which silently disables
  // protection. Anything the preset did not define falls back to a real number.
  for (const key of ['requestsPerDay', 'requestsPerHour', 'budgetWindowsPerDay',
    'minGapMs', 'maxGapMs', 'burstWindowMs', 'burstRestMs',
    'burstIdleResetMs', 'minTurnCycleMs']) {
    if (prot[key] === null || prot[key] === undefined) prot[key] = 0
  }

  // The trap this whole mechanism exists to avoid: ceil() rounds a
  // sub-1-per-window allowance up to 1, so "N per day" quietly becomes
  // "1 per hour" and the day budget can never be reached. Surface it instead of
  // letting the user wonder why a 20/day config serves 24/day at best.
  const windows = prot.budgetWindowsPerDay
  if (windows > 0 && prot.requestsPerDay > 0) {
    const cap = Math.ceil(prot.requestsPerDay / windows)
    prot.effectiveWindowCap = cap
    prot.effectiveCeilingPerDay = cap * windows
  }
}

export function loadConfig(configPath) {
  // GEMINI_BRIDGE_CONFIG  = 运行配置（由 DSH 插件托管时注入）
  // GEMINI_BRIDGE_DATA    = 可写数据目录（logs/state/profiles）；安装目录可能只读
  const file = configPath
    ?? process.env.GEMINI_BRIDGE_CONFIG
    ?? path.join(ROOT, 'config.json')
  const dataDir = process.env.GEMINI_BRIDGE_DATA ?? null
  let overrides = {}
  if (fs.existsSync(file)) {
    try {
      overrides = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${e.message}`)
    }
  }
  const merged = mergeDeep(DEFAULTS, overrides)
  // Expand the pacing preset AFTER merging so `protection.preset` from
  // config.json applies, and so explicit overrides still win over it.
  applyPacingPreset(merged)
  // Ensure paths are always set (config.json rarely has them)
  if (!merged.paths) merged.paths = { ...DEFAULTS.paths }
  merged.paths.logs ??= DEFAULTS.paths.logs
  merged.paths.state ??= DEFAULTS.paths.state
  // A hosted install (npm package inside node_modules) is read-only: all
  // writable state must live under GEMINI_BRIDGE_DATA when provided.
  if (dataDir) {
    merged.paths = Object.freeze({
      ...merged.paths,
      logs: path.join(dataDir, 'logs'),
      state: path.join(dataDir, 'state.json'),
      data: dataDir,
    })
  }
  return Object.freeze(merged)
}
