/**
 * OpenAI <-> Antigravity upstream (v1internal) protocol conversion.
 *
 * The upstream contract was established by the agyapi project and re-probed on
 * this machine (probe-agy-upstream.ps1 -> HTTP 200 + exact echo). The parts
 * that carry real engineering:
 *
 * - `thoughtSignature`: every tool turn may come back with an opaque signature
 *   that MUST be replayed on the next request alongside the functionCall.
 *   OpenAI clients drop unknown fields but preserve `tool_call_id` verbatim,
 *   so the signature rides inside the id as `call_x__thought__<sig>` and is
 *   split on the FIRST occurrence only (signatures may contain the separator).
 * - Schema sanitizing: upstream validates a JSON Schema subset and rejects
 *   unknown keywords, so $ref/$defs, allOf, const-unions, nullable type arrays,
 *   format/pattern/const/examples all get demoted or resolved first.
 * - Errors arrive in-band with HTTP 200 (`{"error":{"code":429,...}}`); every
 *   payload must be checked before treating it as a completion.
 *
 * @module gemini-web-bridge/lib/agyconvert
 */

/** Client selector -> [upstream model id, thinkingLevel]. Unknown names pass through unchanged. */
const MODEL_MAP = {
  'gemini-3.8-flash-low': ['gemini-3.8-flash-tiered', 'LOW'],
  'gemini-3.8-flash': ['gemini-3.8-flash-tiered', 'MEDIUM'],
  'gemini-3.8-flash-medium': ['gemini-3.8-flash-tiered', 'MEDIUM'],
  'gemini-3.8-flash-high': ['gemini-3.8-flash-tiered', 'HIGH'],
}

/** Map one OpenAI-ish model selector to its upstream id + thinking config. */
export function resolveModel(name) {
  const hit = MODEL_MAP[name]
  if (hit) return { model: hit[0], thinkingLevel: hit[1] }
  return { model: name ?? '', thinkingLevel: null }
}

const THOUGHT_SEP = '__thought__'

/** Encode a tool-call id with its thought signature for the round trip. */
export function encodeToolCallId(id, signature) {
  return signature ? `${id}${THOUGHT_SEP}${signature}` : id
}

/** Split `call_x__thought__<sig>`; only the first occurrence splits. */
export function decodeToolCallId(id) {
  if (typeof id !== 'string') return { id: String(id ?? ''), signature: null }
  const at = id.indexOf(THOUGHT_SEP)
  if (at === -1) return { id, signature: null }
  return { id: id.slice(0, at), signature: id.slice(at + THOUGHT_SEP.length) }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/**
 * Build the upstream envelope from an OpenAI chat payload.
 *
 * @param {{ messages: object[], tools?: object[], tool_choice?: unknown, model?: string, defaultModel?: string }} payload
 * @returns {{ envelope: object, upstreamModel: string }}
 */
export function buildRequest(payload) {
  const messages = payload.messages ?? []
  const systemParts = []
  const contents = []
  // call-id -> function name, so tool results can name their response even
  // when the client does not send `name` on the tool message.
  const callNames = new Map()

  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      systemParts.push(textOf(m.content))
      continue
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: textOf(m.content) }] })
      continue
    }
    if (m.role === 'assistant') {
      const parts = []
      if (m.content) parts.push({ text: String(m.content) })
      for (const tc of m.tool_calls ?? []) {
        const { id, signature } = decodeToolCallId(tc.id)
        const call = tc.function ?? {}
        callNames.set(tc.id, call.name)
        callNames.set(id, call.name)
        const part = {
          functionCall: {
            id,
            name: call.name,
            args: parseMaybeJson(call.arguments),
          },
        }
        if (signature) part.thoughtSignature = signature
        parts.push(part)
      }
      if (parts.length) contents.push({ role: 'model', parts })
      continue
    }
    if (m.role === 'tool') {
      const name = m.name ?? callNames.get(m.tool_call_id) ?? callNames.get(decodeToolCallId(m.tool_call_id).id) ?? ''
      const parsed = parseMaybeJson(m.content)
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: asObject(parsed) } }],
      })
    }
  }

  const { model: upstreamModel, thinkingLevel } = resolveModel(payload.model ?? payload.defaultModel)

  const request = { contents }
  if (systemParts.length) request.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] }

  if (Array.isArray(payload.tools) && payload.tools.length) {
    request.tools = [{
      functionDeclarations: payload.tools.map(t => {
        const f = t.function ?? t
        const decl = { name: f.name, parametersJsonSchema: sanitizeSchema(f.parameters ?? {}) }
        if (f.description) decl.description = f.description
        return decl
      }),
    }]
    request.toolConfig = { functionCallingConfig: { mode: toolMode(payload.tool_choice) } }
  }

  if (thinkingLevel) {
    request.generationConfig = { thinkingConfig: { thinkingLevel, includeThoughts: true } }
  }

  request.sessionId = sessionIdFor(messages)

  const envelope = {
    project: payload.project,
    requestId: `req-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    requestType: 'agent',
    model: upstreamModel,
    request,
  }
  return { envelope, upstreamModel }
}

function toolMode(choice) {
  if (choice === 'none') return 'NONE'
  if (choice === 'required') return 'ANY'
  return 'VALIDATED'
}

function sessionIdFor(messages) {
  const firstUser = messages.find(m => m.role === 'user')
  const seed = firstUser ? textOf(firstUser.content) : ''
  let h = 5381
  for (let i = 0; i < Math.min(seed.length, 512); i++) {
    h = (((h << 5) + h) + seed.charCodeAt(i)) | 0
  }
  return `-${(h >>> 0).toString(36)}`
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    // Only text parts are carried; image input (inlineData) is documented as
    // out of scope for this channel.
    return content.filter(p => p?.type === 'text').map(p => p.text).join('')
  }
  return content == null ? '' : String(content)
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value ?? {}
  try { return JSON.parse(value) } catch { return value }
}

function asObject(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  if (Array.isArray(v)) return { result: v }
  return { result: String(v ?? '') }
}

// ---------------------------------------------------------------------------
// Schema sanitizing (subset the upstream validates against)
// ---------------------------------------------------------------------------

/**
 * Resolve/flatten a JSON Schema into the subset upstream accepts.
 * Kept keywords: type, description, enum, properties, required, items,
 * additionalProperties. Everything else is demoted into the description.
 */
export function sanitizeSchema(schema, root = schema, seen = new Set()) {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) {
    return { type: 'object' }
  }
  seen.add(schema)
  let node = schema

  // $ref: resolve local pointers against the root document.
  if (typeof node.$ref === 'string') {
    const resolved = resolveRef(node.$ref, root)
    const rest = { ...node }
    delete rest.$ref
    if (resolved) return sanitizeSchema({ ...resolved, ...rest }, root, seen)
    return { type: 'object', description: `(unresolved ref ${node.$ref})` }
  }

  // allOf: merge member schemas (objects only; later wins on conflicts).
  if (Array.isArray(node.allOf)) {
    const merged = {}
    for (const part of node.allOf) Object.assign(merged, part ?? {})
    if (node.description) merged.description = node.description
    return sanitizeSchema(merged, root, seen)
  }

  let hints = []
  let type = node.type
  let enumValues = node.enum

  // anyOf/oneOf of consts -> string+enum; otherwise take the first non-null.
  const union = node.anyOf ?? node.oneOf
  if (Array.isArray(union) && union.length) {
    const consts = union.filter(u => u && 'const' in u).map(u => u.const)
    if (consts.length === union.length) {
      enumValues = consts
      type = 'string'
    } else {
      const pick = union.find(u => !(u?.type === 'null')) ?? union[0]
      const merged = { ...pick }
      if (node.description) merged.description = node.description
      return sanitizeSchema(merged, root, seen)
    }
  }

  // Nullable type arrays -> first concrete type + a description hint.
  if (Array.isArray(type)) {
    const concrete = type.filter(t => t !== 'null')
    if (type.includes('null')) hints.push('may be null')
    type = concrete[0] ?? 'string'
  }

  // Demote unsupported keywords into the description text.
  for (const key of ['format', 'pattern', 'examples', 'default', 'minimum', 'maximum', 'minLength', 'maxLength']) {
    if (key in node) hints.push(`${key}=${JSON.stringify(node[key])}`)
  }
  if ('const' in node) hints.push(`const=${JSON.stringify(node.const)}`)

  const out = {}
  if (type) out.type = type
  const desc = [node.description, hints.length && `(${hints.join('; ')})`].filter(Boolean).join(' ')
  if (desc) out.description = desc
  if (enumValues) out.enum = enumValues

  if (node.properties && typeof node.properties === 'object') {
    out.properties = {}
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = sanitizeSchema(v, root, seen)
    }
  }
  if (node.required) out.required = node.required
  if (node.items) out.items = sanitizeSchema(node.items, root, seen)
  if ('additionalProperties' in node && typeof node.additionalProperties === 'boolean') {
    out.additionalProperties = node.additionalProperties
  }
  return out
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) return null
  const segments = ref.slice(2).split('/')
  let node = root
  for (const s of segments) {
    const key = s.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!node || typeof node !== 'object') return null
    node = node[key]
  }
  return node ?? null
}

// ---------------------------------------------------------------------------
// Response mapping
// ---------------------------------------------------------------------------

/**
 * Map one parsed upstream SSE payload to OpenAI chunk pieces.
 *
 * @returns {{ error?: {code:number,status:string,message:string},
 *             delta: {content?: string, reasoning_content?: string, tool_calls?: object[]},
 *             finishReason?: string, usage?: object }}
 */
export function mapChunk(obj) {
  if (obj?.error) {
    return {
      error: {
        code: obj.error.code ?? 500,
        status: obj.error.status ?? 'UPSTREAM_ERROR',
        message: obj.error.message ?? 'upstream error',
      },
      delta: {},
    }
  }
  const inner = obj?.response ?? obj ?? {}
  const candidate = inner.candidates?.[0]
  const parts = candidate?.content?.parts ?? []

  let content = ''
  let reasoning = ''
  const toolCalls = []
  for (const part of parts) {
    if (typeof part?.text === 'string' && part.text.length) {
      if (part.thought) reasoning += part.text
      else content += part.text
    }
    if (part?.functionCall) {
      toolCalls.push({
        id: encodeToolCallId(
          part.functionCall.id ?? `call_${Math.floor(Math.random() * 1e6).toString(36)}`,
          part.thoughtSignature,
        ),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      })
    }
  }

  const delta = {}
  if (content) delta.content = content
  if (reasoning) delta.reasoning_content = reasoning
  if (toolCalls.length) delta.tool_calls = toolCalls

  const out = { delta }
  if (candidate?.finishReason) out.finishReason = candidate.finishReason
  const um = inner.usageMetadata
  if (um) {
    out.usage = {
      prompt_tokens: um.promptTokenCount ?? 0,
      completion_tokens: um.candidatesTokenCount ?? 0,
      total_tokens: um.totalTokenCount ?? 0,
      reasoning_tokens: um.thoughtsTokenCount ?? 0,
    }
  }
  return out
}

/** Map the upstream finish reason to the OpenAI one, given whether tools were emitted. */
export function mapFinishReason(finishReason, emittedToolCalls) {
  switch (finishReason) {
    case 'STOP': return emittedToolCalls ? 'tool_calls' : 'stop'
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter'
    default: return emittedToolCalls ? 'tool_calls' : 'stop'
  }
}
