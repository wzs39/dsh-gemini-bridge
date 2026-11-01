/**
 * Response parser for the Gemini StreamGenerate endpoint.
 *
 * The raw body is the anti-XSSI prefix followed by any number of
 * length-prefixed chunks:
 *
 *   )]}'\n\n
 *   5452\n
 *   [["wrb.fr",null,"<inner-json-string>",...],["di",5799]]
 *   454\n
 *   [["wrb.fr",null,"<inner-json-string>",...]]
 *   <total-len>\n          ← trailing "e" / "di" / "af.httprm" bookkeeping
 *
 * Two facts about this layout are load-bearing and were both wrong in the
 * first implementation (it answered every request with "empty answer"):
 *
 * 1. The `wrb.fr` entry is a DIRECT element of the payload array — the payload
 *    is `[["wrb.fr", …], …]`, not `[[["wrb.fr", …]]]`. An extra wrapper level
 *    makes every lookup miss.
 *
 * 2. Each chunk carries a CUMULATIVE SNAPSHOT of the answer, not a delta.
 *    Measured on a 40-line answer: block sizes 2 → 20 → 44 → 68 → 92 → 117,
 *    each one a prefix-extension of the previous. Concatenating them yields
 *    "WEB-WEB-OKWEB-OKWEB-OK"; taking the last one yields "WEB-OK".
 *
 * The inner JSON (entry[2]) is shaped:
 *
 *   [ null,                                   // [0]
 *     ["c_…", "r_…"],                         // [1] conversation / response id
 *     null, null,
 *     [ ["rc_…", ["text", …], …] ],           // [4] candidates
 *     … ]
 *
 * Text lives at `inner[4][0][1]` as an array of string fragments that must be
 * joined. Older captures used `inner[0][0]` as the text and a plain
 * `inner[4][0][0]` choice id, so both shapes are accepted.
 *
 * @module gemini-web-bridge/lib/parser
 */

const XSSI_PREFIX = /^\)\]\}'[^\n]*\n(\r?\n)?/

/**
 * Parse a StreamGenerate body into the final answer.
 *
 * @param {string} raw  Raw response body
 * @returns {{ text: string, conversationId: string, responseId: string, choiceId: string } | null}
 */
export function parseGenerateResponse(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null

  const snapshots = collectSnapshots(raw)
  if (snapshots.length === 0) return null

  // Snapshot semantics: the widest capture is the complete answer. Delta
  // semantics (older captures / other endpoints): concatenate instead.
  const shape = classifySnapshots(snapshots)
  const text = shape === 'delta'
    ? snapshots.map(s => s.text).join('')
    : snapshots[snapshots.length - 1].text

  const meta = snapshots[snapshots.length - 1]
  return {
    text,
    conversationId: meta.conversationId,
    responseId: meta.responseId,
    choiceId: meta.choiceId,
  }
}

/**
 * Walk every wrb.fr chunk and return the answer capture it carries.
 * Chunks with no candidate text (trailing bookkeeping) are skipped.
 */
function collectSnapshots(raw) {
  const out = []
  for (const payload of parseChunks(raw)) {
    for (const entry of payload) {
      const snap = snapshotFromEntry(entry)
      if (snap) out.push(snap)
    }
  }
  return out
}

/**
 * Split the body into JSON payloads.
 *
 * Each payload is a SINGLE LINE of JSON (raw newlines never appear inside JSON
 * strings — they are escaped), so line splitting is the reliable route. The
 * `<len>\n` framing is attempted first but only trusted when its frames
 * actually parse: measured against the live endpoint the declared length is
 * off by one (it counts a separator that the body does not contain), which
 * shifts every subsequent frame. Whichever route yields more valid payloads
 * wins.
 */
function parseChunks(raw) {
  const body = raw.replace(XSSI_PREFIX, '')

  const fromFrames = collectPayloads(splitLengthPrefixed(body))
  const fromLines = collectPayloads(body.split(/\r?\n/))
  return fromFrames.length >= fromLines.length && fromFrames.length > 0
    ? fromFrames
    : fromLines
}

function collectPayloads(candidates) {
  const payloads = []
  for (const chunk of candidates) {
    const t = chunk.trim()
    if (!t.startsWith('[')) continue
    try { payloads.push(JSON.parse(t)) } catch { /* malformed chunk */ }
  }
  return payloads
}

function splitLengthPrefixed(body) {
  const out = []
  let i = 0
  while (i < body.length) {
    // Skip to the start of a length line.
    while (i < body.length && (body[i] === '\n' || body[i] === '\r' || body[i] === ' ')) i++
    let j = i
    while (j < body.length && body[j] >= '0' && body[j] <= '9') j++
    if (j === i) break                      // not a length line: stop framing
    const len = Number.parseInt(body.slice(i, j), 10)
    if (!Number.isFinite(len) || len < 0) break
    if (body[j] === '\r') j++
    if (body[j] === '\n') j++
    if (j + len > body.length) break        // truncated frame
    out.push(body.slice(j, j + len))
    i = j + len
  }
  return out
}

/** Extract one chunk's answer capture, or null when it carries no text. */
function snapshotFromEntry(entry) {
  if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') return null
  const inner = entry[2]
  if (typeof inner !== 'string') return null   // null on in-flight middleware chunks

  let parsed
  try { parsed = JSON.parse(inner) } catch { return null }
  if (!Array.isArray(parsed)) return null

  return snapshotFromInner(parsed)
}

function snapshotFromInner(parsed) {
  const conversationId = str(parsed?.[1]?.[0])
  const responseId = str(parsed?.[1]?.[1])

  // Current layout: candidates[0] = [choiceId, [text fragments], …]
  const candidates = parsed?.[4]
  if (Array.isArray(candidates) && Array.isArray(candidates[0])) {
    const choiceId = str(candidates[0][0])
    const fragments = candidates[0][1]
    const text = Array.isArray(fragments)
      ? fragments.filter(f => typeof f === 'string').join('')
      : str(fragments)
    if (text) return { text, conversationId, responseId, choiceId }
  }

  // Legacy layout: text at parsed[0][0], choice id at parsed[4][0][0].
  const legacyText = str(parsed?.[0]?.[0])
  if (legacyText) {
    const choiceId = str(Array.isArray(candidates) ? candidates[0]?.[0] : '')
    return { text: legacyText, conversationId, responseId, choiceId }
  }

  return null
}

function str(v) {
  return typeof v === 'string' ? v : ''
}

/**
 * 'snapshot' when each capture extends the previous one (the real Gemini
 * behavior); 'delta' when captures are disjoint; 'single' for one capture.
 */
function classifySnapshots(snapshots) {
  if (snapshots.length <= 1) return 'single'
  let nested = 0
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].text
    const next = snapshots[i].text
    if (next.length >= prev.length && next.startsWith(prev)) nested++
  }
  return nested >= snapshots.length - 1 ? 'snapshot' : 'delta'
}
