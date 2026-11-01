/**
 * test/parser.test.mjs — unit tests for the Gemini response parser.
 *
 * The last two tests replay real captured bodies (test/fixtures/). They exist
 * because the first implementation passed every synthetic test and still
 * answered "upstream returned empty answer" on all three live accounts: the
 * synthetic fixtures encoded the WRONG nesting (one array level too deep) and
 * the wrong incremental/delta semantics.
 *
 * Run: node --test test/parser.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseGenerateResponse } from '../lib/parser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')

/**
 * Build a body in the REAL shape:
 *   )]}'\n\n<len>\n[["wrb.fr",null,"<inner>",…]]
 * Note the wrb.fr entry is a direct element of the payload array.
 */
function makeRaw(innerArray, { lengthPrefix = true } = {}) {
  const entry = ['wrb.fr', null, JSON.stringify(innerArray), null, null, null, 'generic']
  const payload = JSON.stringify([entry])
  const prefix = `)]}'\n\n`
  return lengthPrefix ? `${prefix}${payload.length}\n${payload}\n` : `${prefix}${payload}\n`
}

/** Inner array in the current live layout. */
function inner(text, conv = 'c_1', resp = 'r_2', choice = 'rc_3') {
  return [[null], [conv, resp], null, null, [[choice, [text], null, null, null, null, null, null, [1], 'en']]]
}

describe('parseGenerateResponse', () => {
  it('extracts text from the live layout (wrb.fr as direct array element)', () => {
    const result = parseGenerateResponse(makeRaw(inner('Hello, world!')))
    assert.ok(result, 'should return a result')
    assert.equal(result.text, 'Hello, world!')
    assert.equal(result.conversationId, 'c_1')
    assert.equal(result.responseId, 'r_2')
    assert.equal(result.choiceId, 'rc_3')
  })

  it('returns null for empty raw', () => {
    assert.equal(parseGenerateResponse(''), null)
    assert.equal(parseGenerateResponse(null), null)
    assert.equal(parseGenerateResponse(undefined), null)
  })

  it('strips the anti-XSSI prefix', () => {
    const raw = makeRaw(inner('Test answer'))
    assert.ok(raw.startsWith(`)]}'`), 'raw should start with prefix')
    assert.equal(parseGenerateResponse(raw)?.text, 'Test answer')
  })

  it('joins multiple text fragments in one candidate', () => {
    const i = [[null], ['c_1', 'r_2'], null, null, [['rc_3', ['Hello, ', 'wor', 'ld!']]]]
    assert.equal(parseGenerateResponse(makeRaw(i))?.text, 'Hello, world!')
  })

  it('handles malformed inner JSON gracefully', () => {
    const bad = `)]}'\n\n[[["wrb.fr","SNlM0e","{broken json}",null]]]\n`
    assert.equal(parseGenerateResponse(bad), null)
  })

  it('skips in-flight chunk middleware chunks whose payload is null', () => {
    // Chunk 0: no text yet. Chunk 1: the answer.
    const empty = JSON.stringify([['wrb.fr', null, null, null, null, null, 'generic']])
    const full = JSON.stringify([['wrb.fr', null, JSON.stringify(inner('late answer')), null, null, null, 'generic']])
    const raw = `)]}'\n\n${empty.length}\n${empty}\n${full.length}\n${full}\n`
    assert.equal(parseGenerateResponse(raw)?.text, 'late answer')
  })

  it('takes the widest snapshot instead of concatenating cumulative chunks', () => {
    // The real endpoint re-sends a growing snapshot per chunk. Concatenating
    // produced "WEB-WEB-OKWEB-OKWEB-OK"; only the last capture is the answer.
    const steps = ['WEB-', 'WEB-OK', 'WEB-OK']
    const raw = `)]}'\n\n` + steps
      .map(t => {
        const p = JSON.stringify([['wrb.fr', null, JSON.stringify(inner(t)), null, null, null, 'generic']])
        return `${p.length}\n${p}`
      })
      .join('\n') + '\n'
    assert.equal(parseGenerateResponse(raw)?.text, 'WEB-OK')
  })

  it('concatenates when chunks are disjoint deltas', () => {
    const raw = `)]}'\n\n` + ['Hello, ', 'world']
      .map(t => {
        const p = JSON.stringify([['wrb.fr', null, JSON.stringify(inner(t)), null, null, null, 'generic']])
        return `${p.length}\n${p}`
      })
      .join('\n') + '\n'
    assert.equal(parseGenerateResponse(raw)?.text, 'Hello, world')
  })

  it('still reads the legacy layout (text at inner[0][0])', () => {
    const legacy = [['Legacy answer'], ['c_9', 'r_8'], [], [], [['rc_7', [['Legacy answer']]]]]
    assert.equal(parseGenerateResponse(makeRaw(legacy))?.text, 'Legacy answer')
  })

  it('tolerates a wrong length prefix by falling back to line framing', () => {
    const payload = JSON.stringify([['wrb.fr', null, JSON.stringify(inner('framing drift')), null, null, null, 'g']])
    // Declared length is off by 7, exactly the live-endpoint defect.
    const raw = `)]}'\n\n${payload.length + 7}\n${payload}\n`
    assert.equal(parseGenerateResponse(raw)?.text, 'framing drift')
  })

  // ── Real captured bodies ────────────────────────────────────────────────
  it('parses the captured short stream (fixture)', () => {
    const r = parseGenerateResponse(fixture('stream-short.txt'))
    assert.ok(r, 'fixture must parse')
    assert.equal(r.text, 'WEB-OK')
    assert.equal(r.conversationId, 'c_42168001a42bc70e')
    assert.equal(r.responseId, 'r_6083ccae9604dc36')
    assert.equal(r.choiceId, 'rc_f59635692755ce2c')
  })

  it('parses the captured long stream as the complete snapshot (fixture)', () => {
    const r = parseGenerateResponse(fixture('stream-long.txt'))
    assert.ok(r, 'fixture must parse')
    // 117 chars = "1\n2\n…\n40\n\nDONE." with no duplicated prefix.
    assert.equal(r.text.length, 117)
    assert.ok(r.text.startsWith('1\n2\n3\n'), 'starts at line 1')
    assert.ok(r.text.endsWith('40\n\nDONE.'), 'ends with DONE')
    assert.equal(r.text.match(/DONE/g).length, 1, 'no duplicated tail')
    assert.equal(r.conversationId, 'c_d3963fb903ed14ab')
  })
})
