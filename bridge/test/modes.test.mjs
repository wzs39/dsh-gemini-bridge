/**
 * test/modes.test.mjs — the composer-mode encoder and the pill parser.
 *
 * These exist because both halves of the mode switch failed silently in ways a
 * status code could not reveal:
 *   - the pill parser only understood fullwidth quotes, so on an English UI it
 *     returned the whole aria-label, `labelMatches` never matched, and the
 *     switch was re-sent on every request while looking "successful";
 *   - the 16-hex ids are opaque, so a typo routes the account to a model that
 *     exists but is not the one asked for.
 *
 * Run: node --test test/modes.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  WEB_MODES, WEB_MODES as MODES,
  isWebMode, resolveWebMode, webModeIds, labelForHash,
  setModeExpression, labelMatches, READ_PILL_JS,
} from '../lib/modes.mjs'

describe('mode catalog', () => {
  it('exposes the default plus the four switchable composer modes', () => {
    assert.deepEqual(webModeIds(), [
      'gemini-web',
      'gemini-web-flash-lite',
      'gemini-web-flash',
      'gemini-web-pro',
      'gemini-web-argon',
    ])
  })

  it('the default ("follow the account") carries no hash', () => {
    const def = MODES.find((m) => m.id === 'gemini-web')
    assert.equal(def.hash, null, 'no hash => applyMode must not touch the account')
  })

  it('every switchable mode has a distinct 16-hex id', () => {
    const hashes = MODES.map((m) => m.hash).filter((h) => h !== null)
    assert.equal(hashes.length, 4)
    for (const h of hashes) assert.match(h, /^[0-9a-f]{16}$/)
    assert.equal(new Set(hashes).size, hashes.length, 'hashes must be unique')
  })

  it('ids and aliases resolve to the same mode', () => {
    assert.equal(resolveWebMode('gemini-web-pro').hash, 'e6fa609c3fa255c0')
    assert.equal(resolveWebMode('pro').hash, 'e6fa609c3fa255c0')
    assert.equal(resolveWebMode('GEMINI-WEB-PRO').hash, 'e6fa609c3fa255c0')
    assert.equal(resolveWebMode('argon').hash, '95a4c0abcba24364')
  })

  it('empty / absent model means "follow the account"', () => {
    assert.equal(resolveWebMode('').id, 'gemini-web')
    assert.equal(resolveWebMode(undefined).id, 'gemini-web')
  })

  it('an agy id is not a web mode', () => {
    assert.equal(isWebMode('gemini-3.8-flash-medium'), false)
    assert.equal(resolveWebMode('gemini-3.8-flash-medium'), null)
    assert.equal(isWebMode('gemini-web'), true)
    assert.equal(isWebMode(''), true)
  })

  it('labelForHash maps back for /health', () => {
    assert.equal(labelForHash('e6fa609c3fa255c0'), 'Pro')
    assert.equal(labelForHash(''), null)
    assert.equal(labelForHash('deadbeefdeadbeef'), null)
  })
})

describe('setModeExpression', () => {
  it('puts the hash at index 99 and declares the array length', () => {
    const expr = setModeExpression('e6fa609c3fa255c0')
    // The width is carried in the spec blob and used for both the array and the
    // trailing length element: `new Array(spec.width)` + `[spec.width]`.
    assert.match(expr, /"width":100/)
    assert.match(expr, /new Array\(spec\.width\)/)
    assert.match(expr, /arr\[99\] = spec\.hash/)
    assert.match(expr, /\[spec\.width\]/)
    assert.match(expr, /rpcids: 'L5adhe'/)
  })

  it('widens to 265 and sets index 264 when a thinking level is given', () => {
    const expr = setModeExpression('95a4c0abcba24364', 2)
    assert.match(expr, /"width":265/)
    assert.match(expr, /"level":2/)
    assert.match(expr, /arr\[264\] = spec\.level/)
  })

  it('reads f.sid from FdrFJe and bl from cfb2h (not swapped)', () => {
    const expr = setModeExpression('e6fa609c3fa255c0')
    assert.match(expr, /const bl = w\.cfb2h/)
    assert.match(expr, /const sid = w\.FdrFJe/)
  })

  it('uses the page session so cookies and TLS come from Chromium', () => {
    const expr = setModeExpression('e6fa609c3fa255c0')
    assert.match(expr, /credentials: 'include'/)
    assert.match(expr, /'x-same-domain': '1'/)
  })
})

describe('pill parsing contract', () => {
  it('the reader prefers a quoted mode over the whole aria-label', () => {
    // Regression: matching only fullwidth quotes made an English UI return
    // "Open mode picker, currently Flash-Lite", so every request re-switched.
    assert.match(READ_PILL_JS, /button\.input-area-switch/)
    assert.match(READ_PILL_JS, /replace\(\/\\s\+\/g/)
  })

  it('matches a bare label against a versioned, localised pill', () => {
    assert.equal(labelMatches('Pro', 'Pro'), true)
    assert.equal(labelMatches('3.1 Pro', 'Pro'), true, 'version prefix must not break the match')
    assert.equal(labelMatches('Flash-Lite', 'Flash-Lite'), true)
    assert.equal(labelMatches('3.5 Flash-Lite', 'flash lite'), true, 'case and separators')
  })

  it('does not confuse neighbouring tiers', () => {
    // These are the dangerous pairs: a wrong "matched" here means the bridge
    // believes it switched and silently serves the wrong tier.
    assert.equal(labelMatches('Flash-Lite', 'Flash'), false)
    assert.equal(labelMatches('Pro', 'Argon'), false)
    assert.equal(labelMatches('Argon', 'Pro'), false)
  })

  it('null / undefined never match', () => {
    assert.equal(labelMatches(null, 'Pro'), false)
    assert.equal(labelMatches('Pro', null), false)
    assert.equal(labelMatches(undefined, undefined), false)
  })
})

describe('channel naming', () => {
  it('no web mode id collides with an agy id', () => {
    const agy = [
      'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
      'gemini-3.8-flash-tiered', 'gemini-3-flash', 'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
      'gemini-2.5-flash-thinking', 'gemini-3.1-flash-image',
      'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
    ]
    for (const id of agy) {
      assert.equal(isWebMode(id), false, `${id} must not be treated as a web mode`)
    }
    // And no web id or alias may claim an agy id.
    for (const m of WEB_MODES) {
      assert.equal(agy.includes(m.id), false, `${m.id} must not shadow an agy id`)
      for (const alias of m.aliases) {
        assert.equal(agy.includes(alias), false, `alias "${alias}" must not shadow an agy id`)
      }
    }
  })

  it('gemini-3.5-flash-lite stays an agy id (it is a real agy model)', () => {
    // Regression: it used to be listed as a web alias, which routed agy traffic
    // to the web channel and silently served a different model.
    assert.equal(isWebMode('gemini-3.5-flash-lite'), false)
    assert.equal(resolveWebMode('gemini-3.5-flash-lite'), null)
    assert.equal(resolveWebMode('gemini-web-flash-lite').hash, '8c46e95b1a07cecc')
  })
})
