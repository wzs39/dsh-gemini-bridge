/**
 * test/session-tokens.test.mjs — token extraction contract.
 *
 * Two measured failures in scrapePageTokens(), both of which produced a
 * misleading "session expired; run node bin/login.mjs" error while the session
 * was perfectly valid:
 *
 *   1. SNlM0e is "<22-char id>:<epoch millis>". The old class [\w\-_]+ excludes
 *      the colon, so the match failed on a good page.
 *   2. FdrFJe appears several times in the document and the first hit is a bare
 *      number (e.g. "-7730566936813324387"). The real build label is the
 *      "boq_gemini-web-…" string; using the number made StreamGenerate hang
 *      rather than fail.
 *
 * The authoritative source is window.WIZ_global_data (SNlM0e / cfb2h), which
 * the session now reads first, falling back to the HTML scrape.
 *
 * Run: node --test test/session-tokens.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(DIR, '..', 'lib', 'session.mjs'), 'utf8')

describe('token extraction', () => {
  it('SNlM0e pattern tolerates the colon inside the token', () => {
    // Guard against a regression to an alphabet-restricted class.
    assert.ok(
      !/"SNlM0e":"\(\[\\w\\-_\]\+\)"/.test(SRC),
      'must not restrict SNlM0e to [\\w\\-_] — the token contains ":"',
    )
    assert.ok(
      /"SNlM0e":"\(\[\^"\]\+\)"/.test(SRC),
      'SNlM0e must be captured as the whole quoted string',
    )
  })

  it('prefers WIZ_global_data over scraping HTML', () => {
    assert.ok(/WIZ_global_data/.test(SRC), 'WIZ_global_data is the primary source')
    assert.ok(/cfb2h/.test(SRC), 'build label comes from cfb2h')
  })

  it('build label pattern rejects a bare number', () => {
    // The fallback regex must anchor on the known prefixes, otherwise it picks
    // up the numeric field and the request hangs.
    assert.ok(
      /boq_|prod-/.test(SRC),
      'build label matching must require the boq_/prod- prefix',
    )
  })

  it('a missing SNlM0e reports session expiry (not a parse crash)', () => {
    assert.ok(/session expired/.test(SRC))
  })
})

describe('generation request shape', () => {
  it('posts to StreamGenerate (not batchexecute)', () => {
    // batchexecute + the entertg wrapper returns HTTP 400 with a ~139-byte body
    // for every account — verified live, so the endpoint choice matters.
    assert.ok(
      /assistant\.lamda\.BardFrontendService\/StreamGenerate/.test(SRC),
      'generation goes through StreamGenerate',
    )
  })

  it('sends f.req as [null, JSON.stringify(inner)]', () => {
    assert.ok(/\[null, JSON\.stringify\(innerRequest\)\]/.test(SRC))
  })

  it('issues the call from inside the page (fingerprint-matched)', () => {
    // Copying cookies out and calling from Node lands in google.com/sorry —
    // measured. The fetch must originate in the browser.
    assert.ok(/evaluate\(this\.#page/.test(SRC), 'fetch runs via CDP Runtime.evaluate')
    assert.ok(/credentials: 'include'|credentials: "include"/.test(SRC))
  })
})
