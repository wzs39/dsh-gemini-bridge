// 复现「agy 出错且 response 为空时不发 finish」的分支。
// 关注点：stream 结束时是否一定吐出 { type: 'finish' }。
// 没有 finish，DSH 侧就永远等不到终止信号 → 会话表现为「突然结束」。
import { AgyClient } from '../lib/agyclient.mjs'

function makePool(ids) {
  const accounts = ids.map(id => ({
    id, pausedUntil: 0, pauseReason: null,
    tokens: { accessToken: async () => `t-${id}`, forceRefresh: async () => `t-${id}` },
  }))
  let cursor = 0
  return {
    accounts,
    get count() { return accounts.length },
    describeAll: () => accounts.map(a => ({ id: a.id })),
    pick() {
      for (let i = 0; i < accounts.length; i++) {
        const a = accounts[(cursor + i) % accounts.length]
        if (a.pausedUntil > Date.now()) continue
        cursor = (accounts.indexOf(a) + 1) % accounts.length
        return a
      }
      return null
    },
    nextUnpauseInMs: () => 1000,
    pause(a, ms, r) { a.pausedUntil = Date.now() + ms; a.pauseReason = r },
    resume(id) { const a = accounts.find(x => x.id === id); if (a) a.pausedUntil = 0; return true },
  }
}

const config = { agy: { project: 'p', defaultModel: 'gemini-3.8-flash-medium' }, behaviour: { streamIdleTimeoutMs: 5000, completionTimeoutMs: 30000 } }

function stubFetch(bodyText, status = 200) {
  const enc = new TextEncoder()
  return async () => new Response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(bodyText)); c.close() },
  }), { status, headers: { 'content-type': 'text/event-stream' } })
}

async function run(label, bodyText, status = 200) {
  const original = globalThis.fetch
  globalThis.fetch = stubFetch(bodyText, status)
  const client = new AgyClient({ config, tokens: null, pool: makePool(['a']) })
  const events = []
  try {
    for await (const e of client.complete({
      model: 'gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: 'hi' }],
    })) events.push(e)
  } catch (e) {
    console.log(`${label}: THREW ${e.name}: ${e.message.slice(0, 80)}`)
    globalThis.fetch = original
    return { events, threw: true }
  } finally {
    globalThis.fetch = original
  }
  const kinds = events.map(e => e.type ?? (e.done ? 'done' : e.delta !== undefined ? 'delta' : '?'))
  const hasFinish = events.some(e => e.done === true || e.finishReason)
  console.log(`${label}: events=${events.length} kinds=[${[...new Set(kinds)].join(',')}] hasFinish=${hasFinish}`)
  return { events, threw: false }
}

console.log('=== 场景 1：正常文本 ===')
await run('normal', 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]}}]}}\r\n\r\n')

console.log('\n=== 场景 2：result 事件 ok=false 且 response 为空（触发 return 的分支）===')
// 这个场景只能通过 stream 内不带任何 text 体现：客户端会抛 EMPTY_STREAM
await run('empty-result', '')

console.log('\n=== 场景 3：in-band 错误（429）===')
await run('inband-429', 'data: {"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}\r\n\r\n')

console.log('\n=== 场景 4：只有 thinking，没有正文 ===')
await run('thinking-only', 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"think","thought":true}]}}]}}\r\n\r\n')
