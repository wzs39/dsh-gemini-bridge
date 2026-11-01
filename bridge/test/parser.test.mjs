/**
 * test/parser.test.mjs — unit tests for the Gemini response parser.
 *
 * Run: node --test test/parser.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseGenerateResponse } from '../lib/parser.mjs'

// Minimal synthetic response in the format Google returns.
function makeRaw(innerArray) {
  const innerJson = JSON.stringify(innerArray)
  const entry = ['wrb.fr', 'SNlM0e', innerJson, null, null, null, 'generic']
  const outer = JSON.stringify([[entry]])
  return `)]}'

${outer}
`
}

describe('parseGenerateResponse', () => {
  it('extracts text from standard layout', () => {
    const raw = makeRaw([
      ['Hello, world!'],
      ['c_123', 'r_456'],
      [],
      [],
      [['rc_789', [['Hello, world!']]]],
    ])
    const result = parseGenerateResponse(raw)
    assert.ok(result, 'should return a result')
    assert.equal(result.text, 'Hello, world!')
    assert.equal(result.conversationId, 'c_123')
    assert.equal(result.responseId, 'r_456')
    assert.equal(result.choiceId, 'rc_789')
  })

  it('returns null for empty raw', () => {
    const result = parseGenerateResponse('')
    assert.equal(result, null)
  })

  it('strips the anti-XSSI prefix', () => {
    // Prefix present but payload valid
    const inner = [['Test answer'], ['c_1', 'r_2'], [], [], [['rc_3', [['Test answer']]]]]
    const raw = makeRaw(inner)
    assert.ok(raw.startsWith(`)]}'`), 'raw should start with prefix')
    const result = parseGenerateResponse(raw)
    assert.equal(result?.text, 'Test answer')
  })

  it('handles malformed inner JSON gracefully', () => {
    const bad = `)]}'

[[[\"wrb.fr\",\"SNlM0e\",\"{broken json}\",null]]]
`
    const result = parseGenerateResponse(bad)
    assert.equal(result, null)
  })
})
