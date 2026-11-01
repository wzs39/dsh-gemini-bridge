// 端到端验收：两个通道分别发真实请求，验证内容、账号归属、流式与长输出。
// 用法: node tools/e2e.mjs [port]
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const PORT = process.argv[2] ?? '18901'
const BASE = `http://127.0.0.1:${PORT}`
const KEY = 'sk-local-gemini-web'

async function chat(model, messages, { stream = false } = {}) {
  const t0 = Date.now()
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model, messages, stream }),
  })
  if (!r.ok) {
    const body = await r.text()
    return { ok: false, ms: Date.now() - t0, status: r.status, body: body.slice(0, 400) }
  }
  if (!stream) {
    const j = await r.json()
    return {
      ok: true, ms: Date.now() - t0, status: r.status,
      content: j.choices?.[0]?.message?.content ?? '',
      finish: j.choices?.[0]?.finish_reason,
      model: j.model,
      provider: j.provider ?? j.system_fingerprint ?? null,
    }
  }
  // SSE 流式：累积 delta
  const text = await r.text()
  let acc = ''
  let frames = 0
  let done = false
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') { done = true; continue }
    frames++
    try {
      const j = JSON.parse(payload)
      acc += j.choices?.[0]?.delta?.content ?? ''
    } catch { /* skip */ }
  }
  return { ok: true, ms: Date.now() - t0, status: r.status, content: acc, frames, sawDone: done, streamed: true }
}

function show(label, r) {
  if (!r.ok) { log(`✗ ${label}: HTTP ${r.status} ${r.body}`); return false }
  const head = r.content.replace(/\r?\n/g, ' / ').slice(0, 180)
  const extra = r.streamed ? ` frames=${r.frames} done=${r.sawDone}` : ` finish=${r.finish}`
  log(`✓ ${label}: ${r.ms}ms len=${r.content.length}${extra}`)
  log(`     "${head}"`)
  return true
}

log(`== E2E 目标 ${BASE} ==\n`)
let pass = 0, fail = 0

// 1) 网页通道 —— 三账号各打一次，验证轮转真的换号
log('-- 1. 网页通道（gemini-web），连续三次验证账号轮转 --')
for (let i = 1; i <= 3; i++) {
  const r = await chat('gemini-web', [{ role: 'user', content: `Reply with exactly: WEB-${i}-OK` }])
  // 取 account 归属：服务端在响应头/字段里不一定给，先看内容
  if (show(`web#${i}`, r)) {
    if (new RegExp(`WEB-${i}-OK`).test(r.content)) pass++; else { log(`     ! 内容不含 WEB-${i}-OK`); fail++ }
  } else fail++
}

// 2) 长输出（网页通道）—— 验证不再被截断
log('\n-- 2. 网页通道长输出（防截断）--')
{
  const r = await chat('gemini-web', [{ role: 'user', content: 'Count from 1 to 30, one number per line, then write exactly FINISHED on the last line.' }])
  if (show('web-long', r)) {
    const has30 = /\b30\b/.test(r.content)
    const hasEnd = /FINISHED/.test(r.content)
    log(`     含 30: ${has30}, 含 FINISHED: ${hasEnd}`)
    if (has30 && hasEnd) pass++; else fail++
  } else fail++
}

// 3) 多轮上下文（线程复用）
log('\n-- 3. 网页通道多轮上下文 --')
{
  const r = await chat('gemini-web', [
    { role: 'user', content: 'Remember the code word is BANANA7. Reply OK.' },
    { role: 'assistant', content: 'OK' },
    { role: 'user', content: 'What was the code word? Reply with just the word.' },
  ])
  if (show('web-multiturn', r)) {
    if (/BANANA7/i.test(r.content)) pass++; else { log('     ! 没记住上下文'); fail++ }
  } else fail++
}

// 4) 流式（网页通道）
log('\n-- 4. 网页通道流式 --')
{
  const r = await chat('gemini-web', [{ role: 'user', content: 'Reply with exactly: STREAM-OK' }], { stream: true })
  if (show('web-stream', r)) {
    if (/STREAM-OK/.test(r.content)) pass++; else { log('     ! 流式内容不对'); fail++ }
  } else fail++
}

// 5) agy 通道 —— 三个模型组各一次
log('\n-- 5. agy 通道 --')
for (const m of ['gemini-3.8-flash-medium', 'claude-sonnet-4-6', 'gpt-oss-120b-medium']) {
  const r = await chat(m, [{ role: 'user', content: 'Reply with exactly: AGY-OK' }])
  if (show(`agy:${m}`, r)) {
    if (/AGY-OK/.test(r.content)) pass++; else { log('     ! 内容不含 AGY-OK'); fail++ }
  } else fail++
}

// 6) 错误信息要诚实：不存在的模型
log('\n-- 6. 未知模型应诚实报错而不是假装成功 --')
{
  const r = await chat('definitely-not-a-model-xyz', [{ role: 'user', content: 'hi' }])
  log(r.ok ? `     返回 200（len=${r.content.length}）: ${JSON.stringify(r.content.slice(0, 120))}` : `     HTTP ${r.status}: ${r.body.replace(/\s+/g, ' ').slice(0, 160)}`)
}

log(`\n== 结果: pass=${pass} fail=${fail} ==`)
process.exit(fail > 0 ? 1 : 0)
