/**
 * test/detect.test.mjs — ban-risk signal classification tests.
 *
 * Run: node --test test/detect.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyUpstream, pauseFor } from '../lib/detect.mjs'

describe('classifyUpstream', () => {
  it('401 is auth_expired with hard stop', () => {
    const v = classifyUpstream({ status: 401 })
    assert.equal(v.class, 'auth_expired')
    assert.equal(v.hardStop, true)
  })

  it('403 with login redirect words is auth_expired', () => {
    const v = classifyUpstream({ status: 403, error: 'redirect to https://accounts.google sign-in' })
    assert.equal(v.class, 'auth_expired')
  })

  it('403 without auth words is a bot-shaped refusal (throttled)', () => {
    const v = classifyUpstream({ status: 403 })
    assert.equal(v.class, 'throttled')
    assert.equal(v.hardStop, true)
  })

  it('429 is throttled', () => {
    assert.equal(classifyUpstream({ status: 429 }).class, 'throttled')
  })

  it('5xx is an upstream fault, NOT an account failure', () => {
    const v = classifyUpstream({ status: 503 })
    assert.equal(v.class, 'upstream_fault')
    assert.equal(v.hardStop, false)
  })

  it('200 with captcha marker is caught from the body', () => {
    const v = classifyUpstream({ status: 200, raw: '<title>unusual traffic' })
    assert.equal(v.class, 'captcha')
    assert.equal(v.hardStop, true)
  })

  it('plain 200 answer is ok', () => {
    const v = classifyUpstream({ status: 200, raw: ")]}'\n[[[\"wrb.fr\",...]]] sure, here is your answer" })
    assert.equal(v.class, 'ok')
  })

  it('pauseFor orders severity: captcha >= auth > throttled', () => {
    assert.ok(pauseFor('captcha') >= pauseFor('auth_expired'))
    assert.ok(pauseFor('auth_expired') >= pauseFor('throttled'))
    assert.equal(pauseFor('ok'), 0)
  })
})
