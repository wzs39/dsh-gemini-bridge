/**
 * Account protection for the Gemini web bridge.
 *
 * Same design philosophy as deepseek-web-bridge/lib/guard.mjs:
 * every guard catches a failure the others miss.
 *
 * - **Pacing**: bell-curve jitter gap between requests.
 * - **Budget**: daily cap spread across 24 windows so traffic cannot pile up.
 * - **Hourly rate**: catches within-hour bursts that budget windows cannot.
 * - **Breaker**: reacts to upstream HTTP refusals immediately.
 * - **Anomaly score**: tracks silent degradation (empty/truncated answers).
 * - **Burst rest**: forces a pause after sustained activity.
 *
 * Gemini-specific adjustments vs. DeepSeek:
 * - No WAF token window (Gemini uses Google account session, not AWS WAF).
 * - Tighter daily budget (20 vs. 30) because Google's behavior analysis is
 *   more holistic; it correlates usage *across days*, not just within a day.
 * - Longer minimum gap (8 s vs. 5 s) because Gemini's browser app itself
 *   shows longer inter-message gaps than DeepSeek's.
 *
 * @module gemini-web-bridge/lib/guard
 */

import fs from 'node:fs'
import path from 'node:path'

/** HTTP status codes that mean "the account noticed something". */
const HOSTILE = {
  403: { level: 3, cooldownMs: 6 * 60 * 60 * 1000, reason: 'forbidden' },
  429: { level: 2, cooldownMs: 60 * 60 * 1000,      reason: 'rate-limited' },
  401: { level: 3, cooldownMs: 2 * 60 * 60 * 1000,  reason: 'unauthorised' },
}

/** Per-success anomaly decay (same weight as the most common anomaly charge). */
const ANOMALY_DECAY_PER_SUCCESS = 2

const BREAKER_TABLE = { http: HOSTILE }

export class GuardError extends Error {
  constructor(message, { retryAfterMs, code } = {}) {
    super(message)
    this.name = 'GuardError'
    this.retryAfterMs = retryAfterMs
    this.code = code
  }
}

function humanGap(minMs, maxMs) {
  const sample = (Math.random() + Math.random() + Math.random()) / 3
  return Math.round(minMs + sample * (maxMs - minMs))
}

export class Guard {
  #config
  #state
  #logFile
  #nextAllowedAt = 0
  #consecutiveFailures = 0
  #recent = []
  #restUntil = 0
  #inFlight = 0
  #waiters = 0
  #concurrentPeak = 0
  #concurrencyRejects = 0
  #hourTimer = null
  #lastCooldown = null

  constructor(config) {
    this.#config = config
    this.#logFile = path.join(config.paths.logs, 'guard.jsonl')
    fs.mkdirSync(config.paths.logs, { recursive: true })
    this.#state = this.#load()
    this.#hourTimer = setInterval(() => {
      this.#checkHourlyRate().catch(() => {})
      this.#save()
    }, 60000)
    this.#hourTimer.unref?.()
  }

  stop() {
    if (this.#hourTimer) clearInterval(this.#hourTimer)
    this.#hourTimer = null
  }

  #load() {
    const file = path.join(this.#config.paths.logs, 'guard-state.json')
    const today = new Date().toISOString().slice(0, 10)
    const fresh = {
      day: today,
      requestsToday: 0,
      cooldownUntil: 0,
      level: 0,
      reason: null,
      lastRequestAt: 0,
      anomalyScore: 0,
      hourStamps: [],
      windowIndex: -1,
      windowSpent: 0,
      burstStartedAt: 0,
      hourOfDay: new Array(24).fill(0),
      callMix: { completion: 0, tokenRefresh: 0 },
    }
    if (!fs.existsSync(file)) return fresh
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved.day !== today) {
        return {
          ...saved,
          day: today,
          requestsToday: 0,
          windowIndex: -1,
          windowSpent: 0,
          hourOfDay: new Array(24).fill(0),
          callMix: { ...fresh.callMix },
        }
      }
      const merged = { ...fresh, ...saved }
      merged.hourOfDay = Array.isArray(saved.hourOfDay) && saved.hourOfDay.length === 24
        ? saved.hourOfDay
        : new Array(24).fill(0)
      merged.callMix = { ...fresh.callMix, ...(saved.callMix ?? {}) }
      return merged
    } catch {
      return fresh
    }
  }

  #save() {
    if (!this.#dirty) return
    this.#dirty = false
    const file = path.join(this.#config.paths.logs, 'guard-state.json')
    try {
      fs.writeFileSync(file, JSON.stringify(this.#state, null, 2))
    } catch (error) {
      this.#record({ event: 'state-write-failed', message: String(error?.message ?? error) })
    }
  }
  #dirty = false

  flush() { this.#dirty = true; this.#save() }

  #tally(kind) {
    const mix = this.#state.callMix
    if (kind && Object.prototype.hasOwnProperty.call(mix, kind)) {
      mix[kind] += 1
      this.#dirty = true
    }
  }

  #record(entry) {
    try {
      fs.appendFileSync(this.#logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    } catch {}
  }

  status() {
    const budget = this.#config.protection.requestsPerDay
    return {
      level: this.#state.level,
      reason: this.#state.reason,
      cooldownSeconds: Math.max(0, Math.ceil((this.#state.cooldownUntil - Date.now()) / 1000)),
      requestsToday: this.#state.requestsToday,
      budgetPerDay: budget,
      budgetUsedPercent: budget > 0 ? Math.round((this.#state.requestsToday / budget) * 100) : 0,
      anomalyScore: Number(this.#state.anomalyScore.toFixed(2)),
      consecutiveFailures: this.#consecutiveFailures,
      nextAllowedInMs: Math.max(0, this.#nextAllowedAt - Date.now()),
      requestsLastHour: this.#hourCount(),
      hourlyCap: this.#config.protection.requestsPerHour,
      windowCap: this.#perWindowCap(),
      windowSpent: this.#state.windowSpent,
      windowMinutes: Math.round(this.#windowMs() / 60000),
      restRemainingSeconds: Math.max(0, Math.ceil((this.#restUntil - Date.now()) / 1000)),
      concurrencyPeak: this.#concurrentPeak,
      concurrencyNow: this.#inFlight,
      concurrencyRejects: this.#concurrencyRejects,
      hourOfDayHistogram: [...this.#state.hourOfDay],
      callMix: { ...this.#state.callMix },
      breakerTable: structuredClone(BREAKER_TABLE),
      lastCooldown: this.#lastCooldown,
      anomalyDecayPerSuccess: ANOMALY_DECAY_PER_SUCCESS,
    }
  }

  successRate() {
    if (this.#recent.length === 0) return -1
    return Math.round((this.#recent.filter(Boolean).length / this.#recent.length) * 100)
  }

  #hourCount() {
    const cutoff = Date.now() - 60 * 60 * 1000
    return this.#state.hourStamps.filter(at => at > cutoff).length
  }

  #trimLedgers() {
    const cutoff = Date.now() - 60 * 60 * 1000
    if (this.#state.hourStamps.length && this.#state.hourStamps[0] <= cutoff) {
      this.#state.hourStamps = this.#state.hourStamps.filter(at => at > cutoff)
      this.#dirty = true
    }
  }

  #perWindowCap() {
    const { requestsPerDay, budgetWindowsPerDay } = this.#config.protection
    if (requestsPerDay <= 0 || budgetWindowsPerDay <= 0) return 0
    return Math.max(1, Math.ceil(requestsPerDay / budgetWindowsPerDay))
  }

  #windowMs() {
    const { budgetWindowsPerDay } = this.#config.protection
    if (budgetWindowsPerDay <= 0) return 0
    return 24 * 60 * 60 * 1000 / budgetWindowsPerDay
  }

  #checkWindowBudget() {
    const { requestsPerDay, budgetWindowsPerDay } = this.#config.protection
    if (requestsPerDay <= 0 || budgetWindowsPerDay <= 0) return
    const perWindow = this.#perWindowCap()
    const windowMs = this.#windowMs()
    const index = Math.floor(Date.now() / windowMs)
    if (this.#state.windowIndex !== index) {
      this.#state.windowIndex = index
      this.#state.windowSpent = 0
      this.#dirty = true
    }
    if (this.#state.windowSpent >= perWindow) {
      const waitMs = Math.max(0, (index + 1) * windowMs - Date.now())
      throw new GuardError(
        `window budget spent (${this.#state.windowSpent}/${perWindow}); spreading daily allowance`,
        { retryAfterMs: waitMs, code: 'WINDOW_BUDGET' },
      )
    }
  }

  async #checkHourlyRate() {
    const cap = this.#config.protection.requestsPerHour
    if (cap <= 0) return
    const used = this.#hourCount()
    if (used >= cap) {
      const oldest = this.#state.hourStamps.find(at => at > Date.now() - 60 * 60 * 1000)
      const waitMs = oldest ? Math.max(1000, oldest + 60 * 60 * 1000 - Date.now()) : 60000
      throw new GuardError(
        `hourly rate reached (${used}/${cap})`,
        { retryAfterMs: waitMs, code: 'HOURLY_RATE' },
      )
    }
  }

  #checkBurst() {
    const { burstWindowMs, burstRestMs, burstIdleResetMs } = this.#config.protection
    if (burstWindowMs <= 0) return
    const now = Date.now()
    if (this.#restUntil > now) {
      const waitMs = this.#restUntil - now
      throw new GuardError(
        `resting between sessions; ${Math.ceil(waitMs / 60000)} min remaining`,
        { retryAfterMs: waitMs, code: 'BURST_REST' },
      )
    }
    const startedAt = this.#state.burstStartedAt ?? 0
    const lastAt = this.#state.lastRequestAt ?? 0
    if (!startedAt || (lastAt && now - lastAt > burstIdleResetMs)) {
      this.#state.burstStartedAt = now
      this.#dirty = true
      return
    }
    if (now - startedAt >= burstWindowMs) {
      const jitter = 0.85 + Math.random() * 0.3
      this.#restUntil = now + Math.round(burstRestMs * jitter)
      this.#state.burstStartedAt = 0
      this.#dirty = true
      this.#record({ event: 'burst-rest', spanMinutes: Math.round((now - startedAt) / 60000) })
      throw new GuardError(
        `worked ${Math.round((now - startedAt) / 60000)} min without pause; resting`,
        { retryAfterMs: this.#restUntil - now, code: 'BURST_REST' },
      )
    }
  }

  async admit() {
    this.#inFlight += 1
    this.#waiters = Math.max(0, this.#waiters - 1)
    if (this.#inFlight > this.#concurrentPeak) {
      this.#concurrentPeak = this.#inFlight
      this.#dirty = true
    }
    try {
      return await this.#admitInner(Date.now())
    } finally {
      this.#inFlight -= 1
    }
  }

  enterQueue() {
    this.#waiters += 1
    if (this.#waiters > (this.#config.protection.maxConcurrentWaiters ?? 1)) {
      this.#concurrencyRejects += 1
      this.#dirty = true
      this.#save()
      this.#waiters -= 1
      throw new GuardError(
        `${this.#waiters + 1} callers queued for one account`,
        { code: 'CONCURRENCY' },
      )
    }
  }

  leaveQueue() {
    this.#waiters = Math.max(0, this.#waiters - 1)
  }

  async #admitInner(now) {
    if (this.#state.cooldownUntil > now) {
      const waitMs = this.#state.cooldownUntil - now
      if (waitMs > this.#config.protection.maxInlineWaitMs) {
        throw new GuardError(
          `cooling down after ${this.#state.reason ?? 'upstream trouble'}; ${Math.ceil(waitMs / 60000)} min remaining`,
          { retryAfterMs: waitMs, code: 'COOLDOWN' },
        )
      }
      this.#record({ event: 'cooldown-tail', remainingMs: waitMs })
      this.#dirty = true
      this.#save()
      await new Promise(resolve => setTimeout(resolve, waitMs))
      if (this.#state.cooldownUntil > Date.now()) {
        const retryAfterMs = this.#state.cooldownUntil - Date.now()
        throw new GuardError(`cooldown extended while waiting`, { retryAfterMs, code: 'COOLDOWN' })
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    if (this.#state.day !== today) {
      this.#state.day = today
      this.#state.requestsToday = 0
      this.#dirty = true
    }

    const budget = this.#config.protection.requestsPerDay
    if (budget > 0 && this.#state.requestsToday >= budget) {
      const midnight = new Date()
      midnight.setHours(24, 0, 0, 0)
      throw new GuardError(
        `daily budget spent (${this.#state.requestsToday}/${budget}); resets at midnight`,
        { retryAfterMs: Math.max(1000, midnight.getTime() - Date.now()), code: 'BUDGET' },
      )
    }

    this.#trimLedgers()
    this.#checkBurst()
    this.#checkWindowBudget()
    await this.#checkHourlyRate()

    const gap = Math.max(0, this.#nextAllowedAt - Date.now())
    if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap))

    const admittedAt = Date.now()
    this.#state.requestsToday += 1
    this.#state.windowSpent += 1
    this.#state.hourStamps.push(admittedAt)
    this.#state.lastRequestAt = admittedAt
    const hour = new Date(admittedAt).getHours()
    this.#state.hourOfDay[hour] = (this.#state.hourOfDay[hour] ?? 0) + 1
    this.#tally('completion')
    this.#dirty = true
    this.#save()
    return this.status()
  }

  succeeded({ startedAt = 0 } = {}) {
    const { minGapMs, maxGapMs, minTurnCycleMs } = this.#config.protection
    const now = Date.now()
    let nextAt = now + humanGap(minGapMs, maxGapMs)
    if (startedAt > 0 && minTurnCycleMs > 0) {
      const floor = startedAt + minTurnCycleMs
      if (floor > nextAt) nextAt = floor
    }
    this.#nextAllowedAt = nextAt
    this.#consecutiveFailures = 0
    this.#recent.push(true)
    if (this.#recent.length > 20) this.#recent.shift()
    const score = this.#state.anomalyScore - ANOMALY_DECAY_PER_SUCCESS
    this.#state.anomalyScore = Math.max(0, score)
    this.#dirty = true
    this.#save()
  }

  failed(status, { reason } = {}) {
    const { minGapMs, maxGapMs, failureBreakerAt, failureBreakerCooldownMs } = this.#config.protection
    this.#consecutiveFailures += 1
    this.#recent.push(false)
    if (this.#recent.length > 20) this.#recent.shift()

    const entry = HOSTILE[status]
    if (entry) {
      // An explicit caller reason wins over the status-table default: detect.mjs
      // has already classified WHY the call failed, which is strictly more
      // information than the bare status code.
      this.#punish(reason ? { ...entry, reason } : entry)
    } else if (this.#consecutiveFailures >= failureBreakerAt) {
      this.#punish({ level: 2, cooldownMs: failureBreakerCooldownMs, reason: reason ?? 'consecutive-failures' })
    } else {
      this.#nextAllowedAt = Date.now() + humanGap(minGapMs, maxGapMs)
    }
    this.#dirty = true
    this.#save()
  }

  /**
   * Lift an AUTH-class suspension after a human re-login, and only that.
   *
   * From the DeepSeek incident: a 12-hour auth pause is correct for an
   * unattended bridge, but it becomes wrong the moment credentials are fresh.
   * 429/403 pauses are NOT lifted here -- changing a token does not change
   * what the server thinks of this client's behaviour.
   */
  authRecovered() {
    if (!/auth|token|login|session/i.test(this.#state.reason ?? '')) return false
    this.#state.cooldownUntil = 0
    this.#state.level = 0
    this.#state.reason = null
    this.#consecutiveFailures = 0
    this.#dirty = true
    this.#record({ event: 'auth-recovered' })
    this.#save()
    return true
  }

  anomaly(reason, weight = 1) {
    this.#state.anomalyScore += weight
    const threshold = this.#config.protection.anomalyThreshold ?? 4
    if (this.#state.anomalyScore >= threshold) {
      this.#punish({ level: 2, cooldownMs: 60 * 60 * 1000, reason: `anomaly: ${reason}` })
    }
    this.#dirty = true
    this.#save()
  }

  #punish({ level, cooldownMs, reason }) {
    if (level <= this.#state.level && this.#state.cooldownUntil > Date.now()) return
    const jitter = 0.85 + Math.random() * 0.3
    const actual = Math.round(cooldownMs * jitter)
    const until = Date.now() + actual
    if (until > this.#state.cooldownUntil) {
      this.#state.cooldownUntil = until
      this.#state.level = Math.max(this.#state.level, level)
      this.#state.reason = reason
      this.#lastCooldown = { reason, level, actualMs: actual, until: new Date(until).toISOString() }
      this.#record({ event: 'punish', level, reason, cooldownMs: actual })
    }
  }

  reset() {
    this.#state.cooldownUntil = 0
    this.#state.level = 0
    this.#state.reason = null
    this.#consecutiveFailures = 0
    this.#nextAllowedAt = 0
    this.#restUntil = 0
    this.#state.anomalyScore = 0
    this.#dirty = true
    this.#record({ event: 'manual-reset' })
    this.#save()
  }
}
