/**
 * agy OAuth token custody.
 *
 * Sources, in priority order (both shapes verified on this machine by
 * tools/probe-agy-upstream.ps1):
 *   1. file    ~/.gemini/antigravity-cli/antigravity-oauth-token
 *              JSON: { token: { access_token, refresh_token, expiry, expires_in }, ... }
 *   2. keyring Windows Credential target "gemini:antigravity" (same JSON blob).
 *
 * Rules carried in from the ban post-mortem and agyapi's notes:
 *   - Google ROTATES the refresh token on every refresh. The store therefore
 *     re-reads its source before every refresh, and on write-back adopts the
 *     freshest sibling state (the running agy CLI may have refreshed while we
 *     were not looking). Stale-overwrite would revoke the CLI's own session.
 *   - Write-back is atomic (tmp + rename) and only when the file source is
 *     what we read from. Keyring writes go through credman writeback only if
 *     explicitly enabled; default is read-only against the keyring and a
 *     cache file next to our own state (so we never clobber agy's credential).
 *
 * @module gemini-web-bridge/lib/agytoken
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULT_FILE = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * OAuth client id/secret used to refresh an agy token.
 *
 * These are Google's own "installed app" credentials that the agy CLI ships as
 * constants inside its binary. They are NOT committed to this repository: the
 * values are extracted at runtime from the locally installed CLI, which also
 * means they self-heal when Google rotates them (shipping a hard-coded pair is
 * how this broke before -- the previous constants were retracted and the token
 * endpoint answered `401 invalid_client / "The OAuth client was not found."`,
 * silently killing every refresh once an access token aged out, which surfaced
 * as mid-stream truncation rather than an auth error).
 *
 * Resolution order:
 *   1. env AGY_OAUTH_CLIENT_ID + AGY_OAUTH_CLIENT_SECRET (explicit override)
 *   2. extracted from the installed agy binary (cached per process)
 *   3. give up with a clear error naming the missing piece
 */
const AGY_BIN_CANDIDATES = [
  process.env.AGY_BIN,
  path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
  path.join(os.homedir(), '.local', 'bin', 'agy'),
  '/usr/local/bin/agy',
  '/opt/homebrew/bin/agy',
].filter(Boolean)

// Client ids are "NUM-hash.apps.googleusercontent.com" where the hash mixes
// case (measured on agy 4.3.0: 884354919052-36trc1jjb3tguiac32ov6cod268c5blh…).
// A lowercase-only class silently matches nothing, which looked exactly like
// "the binary has no OAuth client".
const CLIENT_ID_RE = /([0-9]{6,})-[A-Za-z0-9]{8,}\.apps\.googleusercontent\.com/g
// Client secrets are "GOCSPX-" + exactly 28 chars = 35 total. Go stores string
// constants back to back, so an open-ended {20,} swallows the following string
// ("…ZtsXhttps://cloudcode-pa…" arrives as one 40-char match). No trailing
// boundary assertion either: the next char is legitimately a word character
// from the neighbouring constant.
const CLIENT_SECRET_RE = /GOCSPX-[A-Za-z0-9_-]{28}/g

let clientCache = null

/** Read a file as latin-1 so binary bytes survive without decode errors. */
function readBinaryText(file) {
  return fs.readFileSync(file).toString('latin1')
}

/**
 * Extract every client id / secret pair candidate from the agy binary.
 *
 * The pairing is not positional in a Go binary (string table order is not
 * source order), so we return the two pools and let the caller probe which
 * combination the token endpoint accepts. Probing is cached for the process and
 * is the only reliable way to establish the mapping.
 */
function extractClientCandidates() {
  const ids = new Set()
  const secrets = new Set()
  for (const bin of AGY_BIN_CANDIDATES) {
    let text
    try {
      if (!fs.existsSync(bin)) continue
      text = readBinaryText(bin)
    } catch { continue }
    for (const m of text.matchAll(CLIENT_ID_RE)) ids.add(m[0])
    for (const m of text.matchAll(CLIENT_SECRET_RE)) secrets.add(m[0])
  }
  return { ids: [...ids], secrets: [...secrets] }
}

/**
 * Resolve the OAuth client pair.
 *
 * Explicit env wins. Otherwise extract from the installed binary. When several
 * candidates exist the caller-supplied `probe` decides (a single refresh attempt
 * against a real refresh_token); without a probe we cannot guess safely, so we
 * throw instead of silently using a pair that may be retracted.
 */
export async function resolveOAuthClient({ probe = null } = {}) {
  if (process.env.AGY_OAUTH_CLIENT_ID && process.env.AGY_OAUTH_CLIENT_SECRET) {
    return {
      clientId: process.env.AGY_OAUTH_CLIENT_ID,
      clientSecret: process.env.AGY_OAUTH_CLIENT_SECRET,
      source: 'env',
    }
  }
  if (clientCache) return clientCache

  const { ids, secrets } = extractClientCandidates()
  if (ids.length === 0) {
    throw Object.assign(
      new Error(
        'agy OAuth client not found: install the agy CLI, or set '
        + 'AGY_OAUTH_CLIENT_ID / AGY_OAUTH_CLIENT_SECRET',
      ),
      { code: 'NO_OAUTH_CLIENT' },
    )
  }
  if (ids.length === 1 && secrets.length === 1) {
    clientCache = { clientId: ids[0], clientSecret: secrets[0], source: 'binary' }
    return clientCache
  }
  if (!probe) {
    throw Object.assign(
      new Error(
        `agy binary carries ${ids.length} client id(s) and ${secrets.length} secret(s); `
        + 'cannot pick one without a probe. Set AGY_OAUTH_CLIENT_ID / AGY_OAUTH_CLIENT_SECRET.',
      ),
      { code: 'AMBIGUOUS_OAUTH_CLIENT' },
    )
  }

  // Probe each combination; first accepted pair wins and is cached.
  for (const clientId of ids) {
    for (const clientSecret of secrets) {
      try {
        if (await probe({ clientId, clientSecret })) {
          clientCache = { clientId, clientSecret, source: 'binary-probed' }
          return clientCache
        }
      } catch { /* try next */ }
    }
  }
  throw Object.assign(
    new Error('no client id/secret combination from the agy binary was accepted'),
    { code: 'NO_VALID_OAUTH_CLIENT' },
  )
}

/** Mutable holder so refresh paths can learn the pair lazily. */
const oauthClient = { current: null }

/** Best-effort synchronous view; null until resolveOAuthClient has run. */
export function readOAuthClient() {
  if (oauthClient.current) return oauthClient.current
  if (process.env.AGY_OAUTH_CLIENT_ID && process.env.AGY_OAUTH_CLIENT_SECRET) {
    return {
      clientId: process.env.AGY_OAUTH_CLIENT_ID,
      clientSecret: process.env.AGY_OAUTH_CLIENT_SECRET,
      source: 'env',
    }
  }
  return null
}

export class AgyTokenStore {
  #tokenFile
  #cacheFile      // our OWN copy, written after refresh; read back on restart
  #allowKeyring
  #current = null // { access_token, refresh_token, expiryMs }

  constructor({ tokenFile = DEFAULT_FILE, cacheFile, allowKeyring = true, poolAccount = null } = {}) {
    // poolAccount: { id, dir } from ~/.dsh/agy-accounts/pool.json. When set,
    // the token file resolves inside that account's isolated HOME and the
    // refresh cache lands next to OUR state (never inside the account dir,
    // which dsh-agy-link owns and treats as agy's native state).
    if (poolAccount && typeof poolAccount === 'object') {
      this.#tokenFile = poolAccount.systemHome
        ? DEFAULT_FILE
        : path.join(poolAccount.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
      this.#cacheFile = cacheFile ?? path.join(
        os.tmpdir(), 'dsh-gemini-bridge', `agy-cache-${poolAccount.id}.json`,
      )
    } else {
      this.#tokenFile = tokenFile ?? DEFAULT_FILE
      this.#cacheFile = cacheFile ?? path.join(os.homedir(), '.dsh-gemini-bridge', 'agy-token-cache.json')
    }
    this.#allowKeyring = allowKeyring && !(poolAccount && !poolAccount.systemHome)
  }

  /** Every readable source's blob, freshest-guess first (cache → file → keyring). */
  #allSources() {
    const out = []
    for (const file of [this.#cacheFile, this.#tokenFile]) {
      try {
        if (fs.existsSync(file)) {
          const json = JSON.parse(fs.readFileSync(file, 'utf8'))
          const t = json.token ?? json
          if (t.access_token && t.refresh_token) out.push({ source: file, ...t })
        }
      } catch { /* malformed: skip this source */ }
    }
    const blob = this.#allowKeyring ? readKeyring('gemini:antigravity') : null
    if (blob) {
      try {
        const json = JSON.parse(blob)
        const t = json.token ?? json
        if (t.access_token && t.refresh_token) out.push({ source: 'keyring', ...t })
      } catch { /* not JSON; ignore */ }
    }
    return out
  }

  /** Read the freshest available blob without refreshing anything. */
  #readSource() {
    return this.#allSources()[0] ?? null
  }

  /** True when the access token is within 60 s of expiry (or unknown). */
  #nearExpiry(t) {
    if (!t) return true
    if (t.expiryMs) return Date.now() > t.expiryMs - 60_000
    // File blobs carry an ISO-ish `expiry` string; parse best-effort.
    if (t.expiry) {
      const ms = Date.parse(t.expiry)
      if (!Number.isNaN(ms)) return Date.now() > ms - 60_000
    }
    return true
  }

  /**
   * Get a usable access token, refreshing through Google if needed.
   * Re-reads the source first EVERY time (agy CLI and we may race on rotation).
   */
  async accessToken() {
    const fresh = this.#readSource()
    if (fresh && !this.#nearExpiry(fresh)) {
      this.#current = { ...fresh, expiryMs: fresh.expiry ? Date.parse(fresh.expiry) : 0 }
      return fresh.access_token
    }

    const candidate = fresh ?? this.#current
    if (!candidate?.refresh_token) {
      throw Object.assign(new Error('no agy credential found (checked cache, file, keyring)'), { code: 'NO_TOKEN' })
    }
    return this.#doRefresh(candidate)
  }

  /**
   * Skip the freshness check and refresh now (client calls this after an
   * upstream 401 -- the token *looked* valid but the server disagreed).
   */
  async forceRefresh() {
    const source = this.#readSource() ?? this.#current
    if (!source?.refresh_token) {
      throw Object.assign(new Error('no agy credential to refresh'), { code: 'NO_TOKEN' })
    }
    return this.#doRefresh(source)
  }

  async #doRefresh(candidate) {
    // Resolve the OAuth client lazily. Credentials are never hard-coded (a
    // committed pair is what got retracted last time); the probe validates a
    // candidate against THIS refresh_token, so the successful pair is proven
    // usable before we commit to it.
    const client = oauthClient.current ?? await resolveOAuthClient({
      probe: async ({ clientId, clientSecret }) => {
        const testBody = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: candidate.refresh_token,
          grant_type: 'refresh_token',
        })
        const r = await fetch(TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: testBody,
          signal: AbortSignal.timeout(15000),
        })
        const j = await r.json().catch(() => ({}))
        // invalid_grant still proves the CLIENT is valid -- the client was
        // accepted and the token was rejected. Only invalid_client /
        // unauthorized_client mean the pair is wrong.
        return r.ok || (j.error !== 'invalid_client' && j.error !== 'unauthorized_client')
      },
    })
    oauthClient.current = client

    const body = new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: candidate.refresh_token,
      grant_type: 'refresh_token',
    })
    let reply
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
      })
      reply = await res.json()
      if (!res.ok || reply.error) {
        // invalid_grant means the refresh token we held was already rotated by
        // another party (the CLI) -- our cached copy is dead. Re-read the
        // sources once; if a source carries a NEWER refresh token, adopt it.
        const again = this.#readSource()
        if (again && again.refresh_token !== candidate.refresh_token && !this.#nearExpiry(again)) {
          this.#current = again
          return again.access_token
        }
        throw Object.assign(new Error(`refresh failed: ${reply.error_description ?? reply.error ?? res.status}`), { code: 'REFRESH_FAILED' })
      }
    } catch (err) {
      if (err.code === 'REFRESH_FAILED') throw err
      throw Object.assign(new Error(`refresh transport error: ${err.message}`), { code: 'REFRESH_FAILED' })
    }

    const next = {
      source: candidate.source,
      access_token: reply.access_token,
      refresh_token: reply.refresh_token ?? candidate.refresh_token, // Google may rotate
      expiryMs: Date.now() + (reply.expires_in ?? 3599) * 1000,
    }
    this.#current = next
    this.#writeCache(next)
    return next.access_token
  }

  #writeCache(t) {
    try {
      fs.mkdirSync(path.dirname(this.#cacheFile), { recursive: true })
      const tmp = `${this.#cacheFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({
        token: {
          access_token: t.access_token,
          refresh_token: t.refresh_token,
          expiry: new Date(t.expiryMs).toISOString(),
          expires_in: Math.round((t.expiryMs - Date.now()) / 1000),
        },
      }), { mode: 0o600 })
      fs.renameSync(tmp, this.#cacheFile)
    } catch {
      // A cache that cannot be written only costs us the next restart; the
      // in-memory copy still serves this process. Do not fail the request.
    }
  }

  describe() {
    // Read sources directly: status must be honest even before the first
    // accessToken() call has populated #current (dashboard loads early).
    const src = this.#current ?? this.#readSource()
    const source = src?.source
    return {
      loaded: Boolean(src?.access_token),
      source: typeof source === 'string' && source.startsWith('keyring') ? 'keyring:gemini:antigravity' : source ?? null,
      expiry: src?.expiryMs
        ? new Date(src.expiryMs).toISOString()
        : (src?.expiry ? new Date(src.expiry).toISOString() : null),
    }
  }
}

/**
 * Multi-account agy credential pool, consuming the account pool that
 * dsh-agy-link already maintains at ~/.dsh/agy-accounts/pool.json.
 *
 * Why consume rather than rebuild: that plugin owns the Windows credential
 * slot (`gemini:antigravity`) with FIFO-mutex lease semantics, spawns agy
 * children with per-account HOME isolation, and records per-family cooldowns
 * and quota fractions in pool.json. A second writer on those files would race
 * its scheduler. So this pool is a READ-ONLY consumer:
 *   - accounts      = pool.json accounts[] filtered to enabled
 *   - token files   = each account dir's antigravity-oauth-token
 *                     (acc_primary -> system HOME / keyring, like the plugin)
 *   - our writes    = ONLY our own per-account refresh caches (os.tmpdir)
 *   - cooldowns     = tracked in OUR state (pool.json is never written by us)
 *
 * Rotation policy is the bridge's own (simple and aligned with detect.mjs):
 *   sticky-until-failure: stay on the current account until it trips a
 *   hard signal (429 quota / 401 dead), then park it (pauseFor) and move to
 *   the next enabled account; all parked -> AgyAllParkedError.
 */
export class AgyPool {
  #accounts = []   // [{ id, alias, email, systemHome, tokens: AgyTokenStore, pausedUntil, pauseReason }]
  #cursor = 0
  #poolFile

  constructor({ config, AgyTokenStoreCtor = AgyTokenStore } = {}) {
    this.#poolFile = config.agy?.poolFile
      ?? path.join(os.homedir(), '.dsh', 'agy-accounts', 'pool.json')

    const entries = this.#readPoolAccounts()
    for (const entry of entries) {
      this.#accounts.push({
        id: entry.id,
        alias: entry.alias ?? entry.id,
        email: entry.email ?? null,
        systemHome: Boolean(entry.systemHome),
        tokens: new AgyTokenStoreCtor({ poolAccount: entry }),
        pausedUntil: 0,
        pauseReason: null,
      })
    }
  }

  /** Enabled accounts from pool.json; missing/corrupt file -> empty pool. */
  #readPoolAccounts() {
    return this.#readPoolFile().accounts
  }

  /**
   * pool.json 全文（accounts + quotas + cooldowns）。
   *
   * 配额和冷却本来就在这个文件里（dsh-agy-link 写的），只是之前没用起来：
   * 面板只能看到「token 读不读得到」，看不到「还剩多少额度」。token 可读
   * 只意味着凭据没过期，跟上游愿不愿意服务完全是两件事——实测过三个号都
   * 因为 VALIDATION_REQUIRED 被 403 时，token 依然全部 loaded=true。
   */
  #readPoolFile() {
    try {
      const pool = JSON.parse(fs.readFileSync(this.#poolFile, 'utf8'))
      const accounts = (Array.isArray(pool?.accounts) ? pool.accounts : [])
        .filter(a => a && a.enabled !== false && (a.dir || a.systemHome))
      return { accounts, raw: pool }
    } catch {
      return { accounts: [], raw: null }
    }
  }

  get count() { return this.#accounts.length }

  /**
   * 一个账号的配额与冷却快照（来自 pool.json，不是我们自己的计量）。
   *
   * 真实结构（实测本机 pool.json，不要照上游 API 的 groups[].buckets[] 猜）：
   *   quotas: { [group]: {
   *       remainingFraction, resetTime,        // 5h 窗口
   *       weeklyFraction, weeklyResetTime,     // weekly 窗口
   *       description, updatedAt,
   *       models: [{ modelId, displayName, remainingFraction, resetTime }]
   *   } }
   *
   * 所以「桶」就是这两个字段本身，不需要另找 buckets 数组。上游 API 的
   * groups[].buckets[] 是另一套表示（工具里能看到），但插件写进 pool.json 时
   * 已经摊平成上面两个字段了。
   *
   * 组级 remaining 用 5h 窗口：它先耗尽，是「现在能不能打」的判据；weekly
   * 单独透出，因为它决定了「这个号今天还能不能用多久」。
   */
  #quotaFor(id) {
    const raw = this.#readPoolFile().raw
    const entry = (raw?.accounts ?? []).find(a => a?.id === id)
    if (!entry) return { groups: [], cooldowns: [] }

    const groups = []
    for (const [group, q] of Object.entries(entry.quotas ?? {})) {
      if (!q || typeof q !== 'object') continue
      const five = typeof q.remainingFraction === 'number' ? q.remainingFraction : null
      const weekly = typeof q.weeklyFraction === 'number' ? q.weeklyFraction : null
      // 两个窗口都表示为桶，让界面和调度都能看到独立状态。
      const buckets = []
      if (five !== null) {
        buckets.push({ id: `${group}-5h`, window: '5h', remaining: five, resetTime: q.resetTime ?? null })
      }
      if (weekly !== null) {
        buckets.push({ id: `${group}-weekly`, window: 'weekly', remaining: weekly, resetTime: q.weeklyResetTime ?? null })
      }
      groups.push({
        group,
        remaining: five,
        resetTime: q.resetTime ?? null,
        weekly,
        weeklyReset: q.weeklyResetTime ?? null,
        description: q.description ?? null,
        updatedAt: q.updatedAt ?? null,
        buckets,
        models: (Array.isArray(q.models) ? q.models : []).map(m => ({
          id: m.modelId ?? m.id ?? null,
          name: m.displayName ?? m.modelId ?? null,
          remaining: typeof m.remainingFraction === 'number' ? m.remainingFraction : null,
          resetTime: m.resetTime ?? null,
        })),
      })
    }

    const cooldowns = []
    for (const [group, c] of Object.entries(entry.cooldowns ?? {})) {
      if (!c || typeof c !== 'object') continue
      cooldowns.push({
        group,
        until: c.cooldownUntil ?? null,
        reason: c.reason ?? null,
      })
    }
    return { groups, cooldowns }
  }

  describeAll() {
    const now = Date.now()
    return this.#accounts.map(a => {
      const { groups, cooldowns } = this.#quotaFor(a.id)
      const token = a.tokens.describe()
      const parked = a.pausedUntil > now

      // 每个配额组各自判活：一个账号可能 gemini 还能打、anthropic 已经 0%。
      // 用单一 usable 布尔会把「部分可用」抹平成「可用」，那正是面板骗人的
      // 根源。这里透出 per-group 结论，让调用方自己决定要哪一组。
      const groupState = groups.map(g => {
        const cooling = cooldowns.find(c => c.group === g.group && c.until && c.until > now)
        const exhausted = g.remaining !== null && g.remaining <= 0
        return {
          group: g.group,
          remaining: g.remaining,
          weekly: g.weekly,
          resetTime: g.resetTime,
          weeklyReset: g.weeklyReset,
          // Per-window detail: the group summary hides "weekly full but 5h
          // empty", which is the state that actually blocks generation.
          buckets: g.buckets ?? [],
          cooling: Boolean(cooling),
          cooldownUntil: cooling?.until ?? null,
          cooldownReason: cooling?.reason ?? null,
          exhausted,
          // 组可用 = 凭据在 + 没被 park + 该组没冷却 + 该组没耗尽
          usable: Boolean(token.loaded) && !parked && !cooling && !exhausted,
        }
      })

      // 账号级 usable = 至少一个组可用。没有配额信息（pool.json 没写过该号）
      // 时退回只看凭据与 park —— 缺数据不等于不可用，但也不谎报成绿。
      const usable = groupState.length > 0
        ? groupState.some(g => g.usable)
        : Boolean(token.loaded) && !parked

      return {
        id: a.id,
        alias: a.alias,
        email: a.email,
        systemHome: a.systemHome,
        token,
        pausedUntil: parked ? a.pausedUntil : null,
        pauseReason: a.pauseReason,
        quota: { groups: groupState, cooldowns },
        usable,
      }
    })
  }

  /** Next usable account: sticky cursor round-robin, skipping parked. */
  pick() {
    const now = Date.now()
    if (this.#accounts.length === 0) return null
    for (let i = 0; i < this.#accounts.length; i++) {
      const candidate = this.#accounts[(this.#cursor + i) % this.#accounts.length]
      if (candidate.pausedUntil > now) continue
      this.#cursor = (this.#accounts.indexOf(candidate) + 1) % this.#accounts.length
      return candidate
    }
    return null
  }

  nextUnpauseInMs() {
    const now = Date.now()
    const waits = this.#accounts
      .filter(a => a.pausedUntil > now)
      .map(a => a.pausedUntil - now)
    return waits.length ? Math.min(...waits) : 0
  }

  /**
   * Which quota group a model draws from.
   *
   * Measured on this machine: gemini-* models bill the "gemini-5h"/weekly
   * buckets, while claude-* and gpt-oss-* bill "3p-5h"/3p-weekly. The two are
   * independent — an account can be at 100% gemini and 0% 3p at the same time,
   * which is exactly the state that produced "Individual quota reached.
   * Resets in 1h23m" for claude while gemini was untouched.
   */
  static groupForModel(model) {
    const m = String(model ?? '').toLowerCase()
    if (m.startsWith('claude') || m.startsWith('gpt-oss')) return '3p'
    return 'gemini'
  }

  /**
   * Pick the best account for a specific model, honouring per-group quota.
   *
   * Rotation used to be model-blind: it handed out the sticky account even when
   * that account's 3p bucket was empty, so a claude call failed with 429 while
   * two other accounts still had 3p quota. Now the pick is filtered by the
   * model's own group, preferring accounts with headroom.
   *
   * Returns null when no account can serve that group (caller should rotate on
   * failure or report the soonest reset).
   */
  pickForModel(model) {
    const now = Date.now()
    const want = AgyPool.groupForModel(model)
    const candidates = []

    for (const acct of this.#accounts) {
      if (acct.pausedUntil > now) continue
      const { groups, cooldowns } = this.#quotaFor(acct.id)
      // pool.json 里组名是 google / anthropic / openai，而模型只区分
      // gemini 与 3p；3p 可能是 anthropic 也可能是 openai，两者都要看。
      const relevant = groups.filter(g => {
        if (want === 'gemini') return g.group === 'google'
        return g.group === 'anthropic' || g.group === 'openai'
      })
      // 没有任何配额数据时不能判死（老版 pool.json / 新装账号）——放进候选，
      // 靠上游 429 兜底，别因为缺数据就把可用账号饿死。
      if (relevant.length === 0) {
        candidates.push({ acct, score: 0.5, known: false })
        continue
      }
      let blocked = false
      let best = -1
      for (const g of relevant) {
        const cooling = cooldowns.find(c => c.group === g.group && c.until && c.until > now)
        if (cooling) continue
        if (g.remaining !== null && g.remaining <= 0) continue
        const frac = g.remaining === null ? 0.5 : g.remaining
        if (frac > best) best = frac
      }
      if (best < 0) blocked = true
      if (!blocked) candidates.push({ acct, score: best, known: true })
    }

    if (candidates.length === 0) return null

    // 余量最多的优先，同分时按原有 cursor 顺序（保持粘滞感）。
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return 0
    })
    const winner = candidates[0].acct
    this.#cursor = (this.#accounts.indexOf(winner) + 1) % this.#accounts.length
    return winner
  }

  /** All accounts able to serve a model's group right now (for diagnostics). */
  eligibleForModel(model) {
    const want = AgyPool.groupForModel(model)
    const now = Date.now()
    return this.#accounts
      .filter(a => a.pausedUntil <= now)
      .map(a => {
        const { groups, cooldowns } = this.#quotaFor(a.id)
        const relevant = groups.filter(g => want === 'gemini' ? g.group === 'google' : (g.group === 'anthropic' || g.group === 'openai'))
        const usable = relevant.length === 0 || relevant.some(g => {
          const cooling = cooldowns.find(c => c.group === g.group && c.until && c.until > now)
          return !cooling && (g.remaining === null || g.remaining > 0)
        })
        return {
          id: a.id,
          email: a.email,
          usable,
          remaining: relevant.length ? Math.max(...relevant.map(g => g.remaining ?? 0)) : null,
        }
      })
  }

  /** Park one account after a hard-stop signal. */
  pause(account, ms, reason) {
    account.pausedUntil = Date.now() + ms
    account.pauseReason = reason
  }

  /** Recovered-by-human or self-healed: clear the park. */
  resume(id) {
    const account = this.#accounts.find(a => a.id === id)
    if (!account) return false
    account.pausedUntil = 0
    account.pauseReason = null
    return true
  }

  /** Reload pool.json: picks up accounts added/removed by dsh-agy-link. */
  reload() {
    const before = new Set(this.#accounts.map(a => a.id))
    const entries = this.#readPoolAccounts()
    // Replace entries wholesale but PRESERVE pause state for surviving ids
    // (a park is information about upstream behaviour, not about the file).
    const pausedById = new Map(this.#accounts
      .filter(a => a.pausedUntil > 0)
      .map(a => [a.id, { pausedUntil: a.pausedUntil, pauseReason: a.pauseReason }]))
    this.#accounts = entries.map(entry => ({
      id: entry.id,
      alias: entry.alias ?? entry.id,
      email: entry.email ?? null,
      systemHome: Boolean(entry.systemHome),
      // Reuse the existing store for surviving accounts so their in-memory
      // access token (already refreshed) is not dropped.
      tokens: before.has(entry.id)
        ? this.#accounts.find(a => a.id === entry.id).tokens
        : new AgyTokenStore({ poolAccount: entry }),
      pausedUntil: pausedById.get(entry.id)?.pausedUntil ?? 0,
      pauseReason: pausedById.get(entry.id)?.pauseReason ?? null,
    }))
    if (this.#cursor >= this.#accounts.length) this.#cursor = 0
    return { before: before.size, after: this.#accounts.length }
  }
}

export class AgyAllParkedError extends Error {
  constructor(msRemaining) {
    super(`all agy accounts parked; soonest release in ${Math.ceil(msRemaining / 60000)} min`)
    this.name = 'AgyAllParkedError'
    this.retryAfterMs = msRemaining
  }
}

// ---------------------------------------------------------------------------
// Windows keyring reader (advapi32 CredReadW). Non-Windows: returns null.
// ---------------------------------------------------------------------------

let keyringModule = null
function readKeyring(target) {
  if (process.platform !== 'win32') return null
  try {
    if (!keyringModule) keyringModule = loadKeyringBindings()
    return keyringModule.read(target)
  } catch {
    return null
  }
}

function loadKeyringBindings() {
  // koffi/ffi is not a dependency of this project; instead shell out to
  // PowerShell with the P/Invoke reader and capture stdout per call. The value
  // passes through stdout as one line; callers JSON-parse it. Kept deliberately
  // small so the token never lands in a file or log of ours.
  //
  // Invocation notes (both verified on this machine):
  //   - `-Command script target` does NOT bind target to $args; PowerShell
  //     parses it as trailing script text -> ParserError.
  //   - `-File -` with argv works, but on a miss it echoes the script itself
  //     back on stdout -> false positives.
  // So: inline the (hardcoded, trusted) target via JSON.stringify quoting and
  // run one self-contained -Command. A miss prints nothing -> null.
  const readerScript = target => [
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class C {',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  public struct CR { public int Flags; public int Type; [MarshalAs(UnmanagedType.LPWStr)] public string TargetName; [MarshalAs(UnmanagedType.LPWStr)] public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias; [MarshalAs(UnmanagedType.LPWStr)] public string UserName; }',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool CredRead(string t,int ty,int f,out IntPtr p);',
    '  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr p);',
    '  public static string R(string t){ IntPtr p; if(!CredRead(t,1,0,out p)) return null; try{ CR c=(CR)Marshal.PtrToStructure(p,typeof(CR)); byte[] b=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,b,0,b.Length); return System.Text.Encoding.UTF8.GetString(b);} finally{ CredFree(p);} }',
    '}',
    '"@',
    `$v = [C]::R(${JSON.stringify(target)}); if ($null -ne $v) { $v }`,
  ].join('\n')
  return {
    read(target) {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', readerScript(target)], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 1024 * 64,
      })
      const value = out.trim()
      // Guard: never accept an echo of our own script back as a credential.
      if (!value || value.includes('Add-Type -TypeDefinition')) return null
      return value
    },
  }
}
