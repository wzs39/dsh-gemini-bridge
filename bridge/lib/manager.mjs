/**
 * Multi-account manager: one browser profile per Google account, one guard per
 * account, rotation on hard-stop signals.
 *
 * Why this exists (from the ban post-mortem):
 *   - A degraded account kept in the request path makes every further request a
 *     signal. Rotation converts "keep knocking" into "walk away and come back
 *     later", which is what a human does when logged out.
 *   - Two Pro subscriptions were the actual motivation: two accounts each carry
 *     half the load, doubling the headroom without tripling any single
 *     account's behavioural footprint.
 *
 * Isolation rules:
 *   - Every account gets its own CDP port AND its own userDataDir (profile lock).
 *     Sharing a profile between accounts is the fastest way to look like an
 *     account farm.
 *   - Per-account guard state lives in logs/<account>/guard-state.json so
 *     cooldowns never leak across identities.
 *
 * @module gemini-web-bridge/lib/manager
 */

import fs from 'node:fs'
import path from 'node:path'

import { Session } from './session.mjs'
import { Guard } from './guard.mjs'
import { classifyUpstream, pauseFor } from './detect.mjs'

export class AccountManager {
  #config
  #accounts = []           // [{ name, label, cdpPort, userDataDir, session, guard, pausedUntil, pauseReason }]
  #cursor = 0
  #statesRoot

  constructor(config) {
    this.#config = config
    this.#statesRoot = path.join(config.paths.logs, 'accounts')
    fs.mkdirSync(this.#statesRoot, { recursive: true })

    const list = config.accounts?.length
      ? config.accounts
      : [{ name: 'default', label: 'default account' }]

    for (const [i, spec] of list.entries()) {
      const name = spec.name ?? `acct-${i + 1}`
      const basePort = config.browser.port + i * 10
      // Profile root: explicit per-account > config.browser.userDataDir (single
      // account only) > the writable data dir (GEMINI_BRIDGE_DATA) > install dir.
      // A hosted install is read-only; profiles MUST live under the data dir
      // when the bridge is registered as a DSH plugin.
      const defaultRoot = config.paths?.data
        ?? path.join(config.paths.logs, '..')
      const dir = spec.userDataDir
        ?? (list.length === 1 && config.browser.userDataDir
          ? config.browser.userDataDir
          : path.join(defaultRoot, 'profiles', name))
      const accountConfig = this.#deriveConfig(config, {
        browserPort: basePort,
        userDataDir: dir,
        name,
      })
      const session = new Session(accountConfig)
      const guard = new Guard(accountConfig)
      this.#accounts.push({
        name,
        label: spec.label ?? name,
        pausedUntil: 0,
        pauseReason: null,
        session,
        guard,
        config: accountConfig,
      })
    }
  }

  /** Clone the frozen root config with per-account overrides. */
  #deriveConfig(root, { browserPort, userDataDir, name }) {
    return Object.freeze({
      ...root,
      browser: Object.freeze({ ...root.browser, port: browserPort, userDataDir }),
      paths: Object.freeze({
        ...root.paths,
        logs: path.join(root.paths.logs, 'accounts', name),
        state: path.join(root.paths.state + '.d', name, 'state.json'),
      }),
      accountName: name,
    })
  }

  get count() { return this.#accounts.length }

  /** Lookup by name (for the reset/recovered HTTP routes). */
  pickAccountByName(name) {
    return this.#accounts.find(a => a.name === name) ?? null
  }

  /** Account entries for /health (never includes secrets, only status). */
  describeAll() {
    return this.#accounts.map(a => ({
      name: a.name,
      label: a.label,
      session: a.session.describe(),
      guard: a.guard.status(),
      pausedUntil: a.pausedUntil || null,
      pauseReason: a.pauseReason,
    }))
  }

  /**
   * Pick the next usable account, round-robin, skipping paused ones.
   *
   * @returns the account entry, or null when every account is parked.
   * @throws nothing; a null return means "no traffic may go out right now".
   */
  pick() {
    const now = Date.now()
    for (let i = 0; i < this.#accounts.length; i++) {
      const candidate = this.#accounts[(this.#cursor + i) % this.#accounts.length]
      if (candidate.pausedUntil > now) continue
      this.#cursor = (this.#accounts.indexOf(candidate) + 1) % this.#accounts.length
      return candidate
    }
    return null
  }

  /** Seconds until the soonest parked account may be retried (for retry-after). */
  nextUnpauseInMs() {
    const now = Date.now()
    const waits = this.#accounts
      .filter(a => a.pausedUntil > now)
      .map(a => a.pausedUntil - now)
    return waits.length ? Math.min(...waits) : 0
  }

  /**
   * Report the outcome of one upstream call for an account.
   *
   * Central routing rule (from the ban): a HARD STOP signal pauses the account
   * for the duration the signal class deserves. It never retries in-path.
   */
  report(account, observed) {
    const verdict = classifyUpstream(observed)

    switch (verdict.class) {
      case 'auth_expired':
      case 'captcha': {
        const pause = pauseFor(verdict.class)
        account.pausedUntil = Date.now() + pause
        account.pauseReason = verdict.reason
        // Feed the guard too, so /health shows the reason.
        account.guard.failed(401, { reason: verdict.reason })
        return verdict
      }
      case 'throttled': {
        const pause = pauseFor('throttled')
        account.pausedUntil = Date.now() + pause
        account.pauseReason = verdict.reason
        account.guard.failed(429, { reason: verdict.reason })
        return verdict
      }
      case 'upstream_fault': {
        // Google's problem, not the account's. Count it, cool nothing.
        account.guard.failed(observed.status ?? 0)
        return verdict
      }
      case 'ok':
      default:
        return verdict
    }
  }

  /** A human re-logged this account in: clear the park and tell the guard. */
  recovered(name) {
    const account = this.#accounts.find(a => a.name === name)
    if (!account) return false
    account.pausedUntil = 0
    account.pauseReason = null
    account.guard.authRecovered?.()
    account.guard.reset()
    return true
  }

  stopAll() {
    for (const a of this.#accounts) {
      a.guard.flush()
      a.guard.stop()
    }
  }
}
