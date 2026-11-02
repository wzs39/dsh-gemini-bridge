/**
 * 结论文本所依据的最后一组硬证据：
 * 在同一账号、同一 pill 状态（Pro）下，反复生成，并把**完整响应**落盘，
 * 从中找出能区分模型的字段（不只是模型名）。
 *
 * 目的：如果连一个能区分模型的字段都找不到，就要如实说明
 * 「网页通道的模型切换是否真的影响生成」目前无法从响应侧证明，
 * 而不能靠输出长度这种噪声指标下结论。
 *
 * 用法：node tools/probe-signature.mjs [account]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const account = process.argv[2] ?? 'pro2'

const cfgPath = process.env.GEMINI_BRIDGE_CONFIG
  ?? path.join(os.homedir(), '.dsh', 'gemini-bridge', 'config.json')
const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
const acct = (config.accounts ?? []).find((a) => a.name === account)
if (!acct) { console.error(`no account named ${account}`); process.exit(1) }
const port = acct.cdpPort ?? config.browser?.port ?? 9344
const origin = config.upstream?.origin ?? 'https://gemini.google.com'

const { attachFirstPage, evaluate } = await import('../lib/cdp.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin + '/app')}`, {
  method: 'PUT',
}).then(async (r) => (r.ok ? r.json() : { err: `HTTP ${r.status}` })).catch((e) => ({ err: String(e) }))
if (created.err) { console.error('new tab failed:', created.err); process.exit(1) }
await sleep(8000)

const page = await attachFirstPage(port, { preferOrigin: origin })

/** 通过页内 RPC 设模式（已验证 ACK [1] 表示接受） */
const setMode = (hash) => evaluate(page, `(async () => {
  const w = window.WIZ_global_data || {};
  const arr = new Array(100).fill(null); arr[99] = ${JSON.stringify(hash)};
  const p = new URLSearchParams({ rpcids: 'L5adhe', 'source-path': '/app', bl: w.cfb2h || '',
    'f.sid': w.FdrFJe || '', hl: 'en', _reqid: String(Math.floor(Math.random()*9e6)+1e6), rt: 'c' });
  const r = await fetch('/_/BardChatUi/data/batchexecute?' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
    body: new URLSearchParams({ 'f.req': JSON.stringify([[['L5adhe', JSON.stringify([arr, null, [100]]), null, 'generic']]]), at: w.SNlM0e }).toString(),
    credentials: 'include',
  });
  const t = await r.text();
  return (t.match(/"wrb\\.fr","L5adhe","([^"]*)"/) || [,'?'])[1];
})()`)

const gen = (tag) => evaluate(page, `(async () => {
  const w = window.WIZ_global_data || {};
  const inner = [[${JSON.stringify('回复 ok')} + ' ' + ${JSON.stringify(tag)}, 0, null, null, null, null, 0],
                 ['en'], ['', '', '', null, null, null, null, null, null, '']];
  const sp = new URLSearchParams({ bl: w.cfb2h || '', rt: 'c',
    _reqid: String(Math.floor(Math.random()*900000)+100000), at: w.SNlM0e });
  const g = await fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + sp, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
    body: new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) }).toString(),
    credentials: 'include',
  });
  return await g.text();
})()`)

const dir = path.join(os.tmpdir(), 'gemini-signatures')
const { mkdirSync } = await import('node:fs')
mkdirSync(dir, { recursive: true })

const HASHES = [
  ['8c46e95b1a07cecc', 'flash-lite'],
  ['e6fa609c3fa255c0', 'pro'],
]

const captured = {}
for (const [hash, name] of HASHES) {
  console.log(`\n### ${name} (${hash}) ###`)
  console.log('  setMode ACK:', await setMode(hash))
  await sleep(4000)
  const raw = await gen(`${name}-${Date.now()}`)
  writeFileSync(path.join(dir, `${name}.txt`), raw, 'utf8')
  captured[name] = raw
  console.log('  len:', raw.length, '落盘:', path.join(dir, `${name}.txt`))

  // 打印所有成对出现的模型字样
  const hits = []
  for (const n of ['Flash-Lite', 'Flash', 'Pro', 'Argon', 'thinking', 'THINKING']) {
    const c = (raw.match(new RegExp(n, 'g')) || []).length
    if (c) hits.push(`${n}×${c}`)
  }
  console.log('  关键词计数:', hits.join(' '))
  await sleep(10000)
}

// 对比两份响应里不同的字段片段
console.log('\n=== 两份响应的长度差 ===')
console.log('flash-lite:', captured['flash-lite']?.length ?? 0)
console.log('pro       :', captured['pro']?.length ?? 0)

// 找所有形如 "xxx" 且两者不同的短字符串（启发式定位差异字段）
const tokens = (s) => new Set((s.match(/"[^"\\]{2,40}"/g) || []))
const a = tokens(captured['flash-lite'] ?? '')
const b = tokens(captured['pro'] ?? '')
const onlyA = [...a].filter((x) => !b.has(x))
const onlyB = [...b].filter((x) => !a.has(x))
console.log('\n只在 flash-lite 出现的字符串（前 20）:', onlyA.slice(0, 20))
console.log('只在 pro 出现的字符串（前 20）:', onlyB.slice(0, 20))

page.close()
process.exit(0)
