/**
 * 端到端实测：bridge 的「网页端模型切换」是否真的生效。
 *
 * 走的是用户实际会走的路径：
 *   POST http://127.0.0.1:18901/v1/chat/completions  { model: 'gemini-web-pro' }
 * 然后：
 *   1. 用 /health 读回账号的 pill 模式（mode 字段）
 *   2. 对比不同 model 参数下 pill 的真实变化
 *   3. 用 generate 的耗时/长度作为行为旁证
 *
 * 用法：node bridge/tools/verify-model-switch.mjs [account]
 */

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cfgPath = path.join(os.homedir(), '.dsh', 'gemini-bridge', 'config.json')
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const base = `http://127.0.0.1:${cfg.server?.port ?? 18901}`
const key = cfg.server?.apiKey ?? 'sk-local-gemini-web'

const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }

async function health() {
  const r = await fetch(`${base}/health`, { headers: H, signal: AbortSignal.timeout(15000) })
  return r.json()
}

async function ask(model, prompt) {
  const t0 = Date.now()
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(300000),
  })
  const ms = Date.now() - t0
  const warn = r.headers.get('x-gemini-mode-warning')
  let body = null
  try { body = await r.json() } catch { /* non-JSON */ }
  return {
    status: r.status,
    ms,
    warn,
    text: body?.choices?.[0]?.message?.content ?? null,
    error: body?.error ?? null,
  }
}

console.log('=== /v1/models ===')
const models = await (await fetch(`${base}/v1/models`, { headers: H })).json()
console.log(models.data.map((m) => m.id).join(', '))

const PROMPT = '只回复一个词：ok'

for (const [i, pair] of [
  ['gemini-web-flash-lite', 'Flash-Lite'],
  ['gemini-web-pro', 'Pro'],
  ['gemini-web-argon', 'Argon'],
  ['gemini-web-flash', 'Flash'],
].entries()) {
  const [model, expect] = pair
  // 每个 prompt 都必须不同：threadKey 现在含 account+mode+prompt，复用同一句
  // 反而会掩盖「换模式后会话是否还能续」这件事，测试要测的是模型切换本身。
  const r = await ask(model, `${PROMPT} (#${i + 1})`)
  const h = await health()
  const pills = h.accounts.map((a) => `${a.name}=${a.session?.mode ?? '?'}`).join(' ')
  console.log(`\n${model}`)
  console.log(`  状态=${r.status} 耗时=${r.ms}ms 警告=${r.warn ?? '-'}`)
  console.log(`  正文=${JSON.stringify((r.text ?? r.error?.message ?? '').slice(0, 60))}`)
  console.log(`  账号 pill: ${pills}   (期望 ${expect})`)
  // 429 是防封闸门而不是失败：如实报出来，别把它算成"切换坏了"。
  if (r.status === 429) console.log('  (限速闸门：本轮被 gap/burst 挡住，等一会儿再打)')
  await new Promise((res) => setTimeout(res, 20000))
}
