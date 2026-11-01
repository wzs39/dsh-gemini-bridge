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
    completionTimeoutMs: 120000,
    tokenTtlMs: 3600000,
    emptyRetries: 1,
  },
  // Multi-account rotation. Each entry gets its own browser CDP port
  // (root port + i*10), its own profile directory and its own guard state.
  // Empty/absent == single anonymous "default" account.
  accounts: [],
  protection: {
    requestsPerDay: 20,
    minGapMs: 8000,
    maxGapMs: 25000,
    failureBreakerAt: 2,
    failureBreakerCooldownMs: 3600000,
    budgetWindowsPerDay: 24,
    requestsPerHour: 4,
    burstWindowMs: 1200000,
    burstRestMs: 480000,
    burstIdleResetMs: 600000,
    minTurnCycleMs: 15000,
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
    defaultModel: 'gemini-3.8-flash',
    tokenFile: null, // null -> ~/.gemini/antigravity-cli/antigravity-oauth-token
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
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object') {
      result[k] = mergeDeep(base[k], v)
    } else {
      result[k] = v
    }
  }
  return result
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
