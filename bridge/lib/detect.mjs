/**
 * Ban-risk signal detection for Gemini upstream responses.
 *
 * Source of the rules here: deepseek-web-bridge/guard-policy.md (one real ban,
 * reconstructed from logs) plus Gemini-API project notes on account degradation.
 *
 * The one rule that matters most:
 *   A credential failure must STOP traffic for that account. The DeepSeek ban
 *   happened because the bridge kept knocking every 5.5 s after the upstream
 *   answered INVALID_TOKEN. Refusing to continue IS the protection.
 *
 * Signal classes:
 *   auth_expired  — session cookies dead; only a human re-login fixes it.
 *                   -> pause the account, rotate to the next one.
 *   captcha       — consent/robot interstitial leaked into the payload.
 *                   -> 24 h cooldown; the account is being degraded.
 *   throttled     — 429/403 rate semantics on a live session.
 *                   -> exponential-ish cooldown, no retry in-path.
 *   degraded      — 200 but empty/absent answer twice in a row.
 *                   -> anomaly score, not a hard stop.
 *
 * @module gemini-web-bridge/lib/detect
 */

/** Markers of a Google consent / captcha / "unusual traffic" interstitial. */
const CAPTCHA_MARKERS = [
  'unusual traffic',
  'recaptcha',
  'enablejs',
  'consent.google.com',
  '/sorry/',
  'not a robot',
]

/** Markers that the session itself is dead (vs. the behaviour being disliked). */
const AUTH_MARKERS = [
  'invalid jwt',
  'unauthenticated',
  'token expired',
  'redirect to login',
  'accounts.google',
]

/**
 * Classify one upstream round-trip.
 *
 * @param {{ status?: number, raw?: string, error?: string }} observed
 *   what came back from session.generateRaw() or its thrown error
 * @returns {{ class: string, hardStop: boolean, reason: string }}
 */
export function classifyUpstream({ status, raw = '', error = '' } = {}) {
  const haystack = `${error} ${raw}`.toLowerCase()

  // HTTP-level first: statuses do not lie the way bodies sometimes do.
  if (status === 401 || (status === 403 && /sign[- ]?in|login|auth/i.test(haystack))) {
    return { class: 'auth_expired', hardStop: true, reason: `HTTP ${status} + auth semantics` }
  }
  if (status === 429) {
    return { class: 'throttled', hardStop: true, reason: 'HTTP 429' }
  }
  if (status === 403) {
    // 403 without auth words = WAF/bot refusal on a live session.
    return { class: 'throttled', hardStop: true, reason: 'HTTP 403 (bot-shaped refusal)' }
  }
  if (status && status >= 500) {
    // Upstream故障 is not a refusal. Do not punish the account for Google's bad minute.
    return { class: 'upstream_fault', hardStop: false, reason: `HTTP ${status}` }
  }

  // Body-level markers (Gemini answers arrive 200 even when degraded).
  if (CAPTCHA_MARKERS.some(m => haystack.includes(m))) {
    return { class: 'captcha', hardStop: true, reason: 'captcha/consent interstitial in payload' }
  }
  if (AUTH_MARKERS.some(m => haystack.includes(m))) {
    return { class: 'auth_expired', hardStop: true, reason: 'auth-expired marker in payload' }
  }
  return { class: 'ok', hardStop: false, reason: 'no signal' }
}

/**
 * How long to park an account after a class of failure.
 *
 * auth_expired is LONG because nothing shorter helps: credentials do not heal
 * themselves until a human re-logs in. A short pause only buys another
 * rejected request -- and rejected-request-with-short-gap is the exact shape
 * of the DeepSeek ban.
 */
export function pauseFor(className) {
  switch (className) {
    case 'auth_expired': return 12 * 60 * 60 * 1000       // 12 h, then probe again
    case 'captcha':      return 24 * 60 * 60 * 1000       // a day; account is degraded
    case 'throttled':    return 60 * 60 * 1000            // an hour
    default:             return 0
  }
}
