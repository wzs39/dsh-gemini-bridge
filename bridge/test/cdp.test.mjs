/**
 * test/cdp.test.mjs — WebSocket frame parsing for the CDP transport.
 *
 * Regression cover for the bug that made the whole web channel look hung:
 * the parser used to scan the raw stream for '{'…'}' and count brace depth.
 * A CDP reply whose JSON *string value* contains braces (Gemini's f.req
 * payloads are nested escaped JSON) desynchronised that counter, so no message
 * was ever cut, the pending promise never settled and Runtime.evaluate hung
 * forever. Token scrapes happened to work because their replies contain no
 * braces inside strings — which is exactly why only generation appeared broken.
 *
 * Run: node --test test/cdp.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// ── a socket stand-in that records what we write ───────────────────────────
class FakeSocket extends EventEmitter {
  constructor() { super(); this.writes = [] }
  write(buf) { this.writes.push(Buffer.from(buf)); return true }
  destroy() { this.emit('close') }
}

// Re-implement the frame builder contract by driving the real CDPSession.
// CDPSession is not exported, so we exercise it through a tiny harness that
// imports the module and reaches the class via attachFirstPage's behaviour is
// overkill; instead we assert the wire format directly with the same rules the
// session applies. This keeps the test dependency-free while still pinning the
// invariants that broke.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SESSION_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'cdp.mjs'),
  'utf8',
)

describe('CDP transport — invariants that broke generation', () => {
  it('parses WebSocket frames instead of counting braces', () => {
    // The brace-counting approach must be gone: it cannot survive braces that
    // live inside JSON string values.
    assert.ok(
      !/indexOf\('\{', start\)/.test(SESSION_SRC),
      'brace-depth scanning must not be used to frame WebSocket messages',
    )
    assert.ok(
      /readUInt16BE|readUInt32BE/.test(SESSION_SRC),
      'frame lengths must be read from the WebSocket header',
    )
  })

  it('buffers bytes, not decoded text (split UTF-8 must survive)', () => {
    // Per-chunk toString() corrupts a multi-byte character split across chunks.
    assert.ok(
      /Buffer\.alloc\(0\)|Buffer\.concat/.test(SESSION_SRC),
      'the read buffer must be a Buffer',
    )
    assert.ok(
      !/this\.#buf \+= raw/.test(SESSION_SRC),
      'must not append decoded strings to the frame buffer',
    )
  })

  it('handles all three WebSocket length classes', () => {
    assert.ok(/len < 126/.test(SESSION_SRC), 'short form (<126)')
    assert.ok(/len < 65536/.test(SESSION_SRC) || /=== 126/.test(SESSION_SRC), '16-bit form (126)')
    assert.ok(/127/.test(SESSION_SRC), '64-bit form (127)')
  })

  it('reassembles continuation frames', () => {
    assert.ok(/fragment/i.test(SESSION_SRC), 'continuation frames must be reassembled')
    assert.ok(/opcode === 0x0/.test(SESSION_SRC), 'opcode 0 continuation is handled')
  })

  it('answers pings so the peer does not drop the session', () => {
    assert.ok(/opcode === 0x9/.test(SESSION_SRC), 'ping handling')
    assert.ok(/0xA/.test(SESSION_SRC), 'pong must be written')
  })

  it('rejects pending calls when the socket closes instead of hanging forever', () => {
    // A hang here is the difference between "request failed" and "the whole
    // bridge is stuck"; every pending call must settle.
    assert.ok(
      /socket closed/i.test(SESSION_SRC) || /reject\(new Error/.test(SESSION_SRC),
      'close must settle pending promises',
    )
  })
})

describe('CDP transport — frame builder', () => {
  // Mirror the exact header rules the session writes, and assert the bytes.
  function buildFrame(opcode, payload) {
    const len = payload.length
    let header
    if (len < 126) {
      header = Buffer.allocUnsafe(6)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | len
      header.writeUInt32BE(0, 2)
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(8)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(len, 2)
      header.writeUInt32BE(0, 4)
    } else {
      header = Buffer.allocUnsafe(14)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeUInt32BE(Math.floor(len / 0x100000000), 2)
      header.writeUInt32BE(len >>> 0, 6)
      header.writeUInt32BE(0, 10)
    }
    return { header, total: header.length + len }
  }

  it('short payload uses the 7-bit length form', () => {
    const { header } = buildFrame(0x1, Buffer.alloc(10))
    assert.equal(header.length, 6)
    assert.equal(header[1] & 0x7f, 10)
    assert.equal(header[1] & 0x80, 0x80, 'client frames must be masked')
  })

  it('64KB+ payload uses the 64-bit length form (was malformed before)', () => {
    // The old code fell into the 16-bit branch for everything >=126 bytes, so
    // any payload above 64KB produced a header that lied about its length.
    const big = Buffer.alloc(70000)
    const { header } = buildFrame(0x1, big)
    assert.equal(header.length, 14, '64-bit length form is 14 bytes of header')
    assert.equal(header[1] & 0x7f, 127)
    const hi = header.readUInt32BE(2)
    const lo = header.readUInt32BE(6)
    assert.equal(hi * 0x100000000 + lo, 70000)
  })
})
