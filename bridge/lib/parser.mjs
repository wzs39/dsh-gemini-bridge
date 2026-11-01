/**
 * Response parser for the Gemini StreamGenerate endpoint.
 *
 * The raw response body looks like:
 *
 *   )]}'\n\n
 *   <length>\n
 *   [[["wrb.fr","SNlM0e","<inner-json-string>",null,null,null,"generic"],...]\n
 *   <length>\n
 *   ...
 *
 * The actual answer is a JSON string embedded inside the outer array at position
 * [0][2] of each `wrb.fr` chunk. That inner string is itself a JSON array whose
 * structure is:
 *
 *   parsed[0][0]   → answer text (plain text)
 *   parsed[1][0]   → conversation_id ("c_...")
 *   parsed[1][1]   → response_id ("r_...")
 *   parsed[4]      → list of candidates [{id: "rc_...", content: [[text]]}]
 *
 * Google rotates the layout occasionally.  The parser below:
 * 1. Strips the )]}' prefix.
 * 2. Concatenates all `wrb.fr` chunk payloads.
 * 3. Searches recursively for the first long string that can be parsed as the
 *    top-level response array to avoid hard-coded index brittleness.
 *
 * @module gemini-web-bridge/lib/parser
 */

/**
 * Strip the anti-XSSI prefix and collect all payload strings from wrb.fr chunks.
 *
 * @param {string} raw  Raw response body
 * @returns {{ text: string, conversationId: string, responseId: string, choiceId: string } | null}
 */
export function parseGenerateResponse(raw) {
  // Strip the )]}'\n prefix (exactly four chars + newline).
  const stripped = raw.replace(/^\)\]\}'[\s\S]*?\n\n/, '')

  // The body is length-prefixed chunks, each on its own line.
  // We want the JSON arrays. Collect every line that starts with '['.
  const payloads = []
  for (const line of stripped.split('\n')) {
    const t = line.trim()
    if (t.startsWith('[')) {
      try { payloads.push(JSON.parse(t)) } catch { /* malformed chunk */ }
    }
  }

  // Walk payloads looking for a wrb.fr entry with an answer.
  for (const payload of payloads) {
    const result = extractFromPayload(payload)
    if (result) return result
  }
  return null
}

function extractFromPayload(payload) {
  // payload is typically [[["wrb.fr", "SNlM0e", "<inner>", ...]]]
  if (!Array.isArray(payload)) return null
  for (const outer of payload) {
    if (!Array.isArray(outer)) continue
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue
      // entry[2] is the inner JSON string.
      const inner = entry[2]
      if (typeof inner !== 'string') continue
      try {
        const parsed = JSON.parse(inner)
        if (!Array.isArray(parsed)) continue
        return extractAnswer(parsed)
      } catch { /* not valid JSON */ }
    }
  }
  return null
}

function extractAnswer(parsed) {
  // Attempt the well-known layout first.
  try {
    const text = parsed?.[0]?.[0]
    const convId = parsed?.[1]?.[0]
    const respId = parsed?.[1]?.[1]
    const candidates = parsed?.[4]
    const choiceId = Array.isArray(candidates) && candidates[0]
      ? candidates[0][0]
      : ''

    if (typeof text === 'string' && text.length > 0) {
      return { text, conversationId: convId ?? '', responseId: respId ?? '', choiceId }
    }
  } catch { /* try recursive next */ }

  // Fallback: recursively find the first long answer-shaped string.
  return searchDeep(parsed)
}

function searchDeep(node, depth = 0) {
  if (depth > 6) return null
  if (typeof node === 'string' && node.length > 10 && !node.startsWith('http') && !node.startsWith('c_')) {
    return { text: node, conversationId: '', responseId: '', choiceId: '' }
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = searchDeep(child, depth + 1)
      if (r) return r
    }
  }
  return null
}
