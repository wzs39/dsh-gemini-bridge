/**
 * test/agyconvert.test.mjs — OpenAI <-> agy protocol conversion tests.
 *
 * Run: node --test test/agyconvert.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveModel,
  encodeToolCallId,
  decodeToolCallId,
  buildRequest,
  sanitizeSchema,
  mapChunk,
  mapFinishReason,
} from '../lib/agyconvert.mjs'

describe('model resolution', () => {
  it('maps tiered flash selectors', () => {
    assert.deepEqual(resolveModel('gemini-3.8-flash-high'), { model: 'gemini-3.8-flash-tiered', thinkingLevel: 'HIGH' })
    assert.deepEqual(resolveModel('gemini-3.8-flash'), { model: 'gemini-3.8-flash-tiered', thinkingLevel: 'MEDIUM' })
  })
  it('passes unknown names through unchanged', () => {
    assert.deepEqual(resolveModel('claude-sonnet-4-6'), { model: 'claude-sonnet-4-6', thinkingLevel: null })
  })
})

describe('thoughtSignature round-trip', () => {
  it('encodes and decodes on the FIRST separator', () => {
    const enc = encodeToolCallId('call_1', 'sig__inner')
    assert.equal(enc, 'call_1__thought__sig__inner')
    const { id, signature } = decodeToolCallId(enc)
    assert.equal(id, 'call_1')
    assert.equal(signature, 'sig__inner')
  })
  it('plain id decodes to no signature', () => {
    assert.deepEqual(decodeToolCallId('call_2'), { id: 'call_2', signature: null })
  })
})

describe('buildRequest', () => {
  it('separates system into systemInstruction', () => {
    const { envelope } = buildRequest({
      project: 'p', model: 'gemini-3-flash',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
    })
    assert.equal(envelope.request.systemInstruction.parts[0].text, 'be terse')
    assert.equal(envelope.request.contents.length, 1)
    assert.equal(envelope.request.contents[0].role, 'user')
    assert.equal(envelope.project, 'p')
  })

  it('maps assistant tool_calls to functionCall parts with decoded signature', () => {
    const { envelope } = buildRequest({
      project: 'p', model: 'gemini-3-flash',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{
          id: encodeToolCallId('call_9', 'SIG'),
          function: { name: 'get_weather', arguments: '{"city":"HKL"}' },
        }] },
        { role: 'tool', tool_call_id: 'call_9', content: '{"temp":3}' },
      ],
    })
    const model = envelope.request.contents[1]
    assert.equal(model.role, 'model')
    const fc = model.parts.find(p => p.functionCall).functionCall
    assert.equal(fc.name, 'get_weather')
    assert.deepEqual(fc.args, { city: 'HKL' })
    assert.equal(model.parts.find(p => p.functionCall).thoughtSignature, 'SIG')

    const fr = envelope.request.contents[2].parts[0].functionResponse
    assert.equal(fr.name, 'get_weather')
    assert.deepEqual(fr.response, { temp: 3 })
  })

  it('emits a stable sessionId derived from the first user message', () => {
    const a = buildRequest({ project: 'p', model: 'x', messages: [{ role: 'user', content: 'same' }] }).envelope.request.sessionId
    const b = buildRequest({ project: 'p', model: 'x', messages: [{ role: 'user', content: 'same' }] }).envelope.request.sessionId
    const c = buildRequest({ project: 'p', model: 'x', messages: [{ role: 'user', content: 'other' }] }).envelope.request.sessionId
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.ok(a.startsWith('-'))
  })

  it('tools become functionDeclarations + VALIDATED mode', () => {
    const { envelope } = buildRequest({
      project: 'p', model: 'x',
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } } }],
    })
    assert.equal(envelope.request.toolConfig.functionCallingConfig.mode, 'VALIDATED')
    const decl = envelope.request.tools[0].functionDeclarations[0]
    assert.equal(decl.name, 'f')
    assert.equal(decl.description, 'd')
    assert.ok(decl.parametersJsonSchema)
  })
})

describe('sanitizeSchema', () => {
  it('resolves local $ref', () => {
    const root = {
      type: 'object',
      properties: { x: { $ref: '#/$defs/Str' } },
      $defs: { Str: { type: 'string', description: 'a string' } },
    }
    const out = sanitizeSchema(root)
    assert.equal(out.properties.x.type, 'string')
    assert.ok(!('$ref' in out.properties.x))
    assert.ok(!('$defs' in out))
  })

  it('flattens allOf', () => {
    const out = sanitizeSchema({ allOf: [{ type: 'object' }, { properties: { a: { type: 'number' } } }] })
    assert.equal(out.type, 'object')
    assert.equal(out.properties.a.type, 'number')
  })

  it('collapses const anyOf to string+enum', () => {
    const out = sanitizeSchema({ anyOf: [{ const: 'x' }, { const: 'y' }] })
    assert.equal(out.type, 'string')
    assert.deepEqual(out.enum, ['x', 'y'])
  })

  it('demotes nullable type arrays and format', () => {
    const out = sanitizeSchema({ type: ['string', 'null'], format: 'date-time' })
    assert.equal(out.type, 'string')
    assert.match(out.description, /may be null/)
    assert.match(out.description, /date-time/)
  })

  it('terminates ref cycles with an object placeholder', () => {
    const node = { type: 'object', properties: {} }
    node.properties.self = node // self-cycle
    const out = sanitizeSchema(node)
    assert.equal(out.properties.self.type, 'object')
  })
})

describe('mapChunk', () => {
  it('separates thought text from answer text', () => {
    const { delta } = mapChunk({ response: { candidates: [{ content: { parts: [
      { text: 'thinking...', thought: true },
      { text: 'answer' },
    ] } }] } })
    assert.equal(delta.content, 'answer')
    assert.equal(delta.reasoning_content, 'thinking...')
  })

  it('wraps functionCall with a signature-carrying id', () => {
    const { delta } = mapChunk({ response: { candidates: [{ content: { parts: [
      { functionCall: { name: 'f', args: { a: 1 } }, thoughtSignature: 'SIG' },
    ] } }] } })
    const tc = delta.tool_calls[0]
    assert.equal(tc.function.name, 'f')
    assert.equal(tc.function.arguments, '{"a":1}')
    assert.match(tc.id, /__thought__SIG$/)
  })

  it('surfaces in-band errors', () => {
    const { error } = mapChunk({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } })
    assert.equal(error.code, 429)
    assert.equal(error.status, 'RESOURCE_EXHAUSTED')
  })

  it('relays usageMetadata as OpenAI usage', () => {
    const { usage } = mapChunk({ response: { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 2 } } })
    assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reasoning_tokens: 2 })
  })
})

describe('mapFinishReason', () => {
  it('STOP + tool calls -> tool_calls', () => {
    assert.equal(mapFinishReason('STOP', true), 'tool_calls')
    assert.equal(mapFinishReason('STOP', false), 'stop')
  })
  it('MAX_TOKENS -> length; SAFETY -> content_filter', () => {
    assert.equal(mapFinishReason('MAX_TOKENS', false), 'length')
    assert.equal(mapFinishReason('SAFETY', false), 'content_filter')
  })
})
