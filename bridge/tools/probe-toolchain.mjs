/**
 * 判定：不同 pill 模式下，响应里的**工具链**是否不同。
 *
 * 上一步已观察到一个强信号：
 *   Pro        → 出现 "data_analysis_tool"（代码解释器/分析工具）
 *   Flash-Lite → 出现 "google"（搜索工具）
 *
 * 这是比"输出长度"可靠得多的判据：工具能力是模型档位的直接体现。
 * 本探针把这当成统计量：每个模式跑多题，统计各工具的出现次数。
 *
 * 用法：node tools/probe-toolchain.mjs [account]
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
await sleep(8500)

const page = await attachFirstPage(port, { preferOrigin: origin })

const pill = () => evaluate(page, `
  (() => {
    const b = document.querySelector('button.input-area-switch');
    if (!b) return null;
    const q = (b.getAttribute('aria-label') || '').match(/[\u201c"']([^\u201d"']+)[\u201d"']/);
    return q ? q[1].trim() : (b.textContent || '').trim();
  })()
`)

async function selectByIndex(idx) {
  await evaluate(page, `
    (async () => {
      const btn = document.querySelector('button.input-area-switch');
      btn.click();
      await new Promise(function (r) { setTimeout(r, 1900); });
      const list = Array.prototype.slice.call(document.querySelectorAll('gem-menu-item[role="menuitem"]'));
      if (list[${idx}]) list[${idx}].click();
      await new Promise(function (r) { setTimeout(r, 2400); });
    })()
  `)
  await sleep(2500)
  return pill()
}

async function gen(prompt) {
  return evaluate(page, `
    (async () => {
      const w = window.WIZ_global_data || {};
      if (!w.SNlM0e) return JSON.stringify({ error: 'no-snlm0e' });
      const inner = [[${JSON.stringify(prompt)}, 0, null, null, null, null, 0], ['en'],
                     ['', '', '', null, null, null, null, null, null, '']];
      const sp = new URLSearchParams({ bl: w.cfb2h || '', rt: 'c',
        _reqid: String(Math.floor(Math.random() * 900000) + 100000), at: w.SNlM0e });
      const g = await fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?' + sp, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
        body: new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify(inner)]) }).toString(),
        credentials: 'include',
      });
      const text = await g.text();
      const tools = ['data_analysis_tool', 'google', 'code_execution', 'python', 'browse'];
      const seen = {};
      for (const t of tools) seen[t] = (text.split(t).length - 1);
      return JSON.stringify({ status: g.status, len: text.length, tools: seen });
    })()
  `)
}

/** 都能同时触发"计算"与"检索"两类需求的中性题 */
const PROMPTS = [
  'Compute 2**100 and tell me the exact number of digits. Show your work.',
  'Calculate the sum of all primes below 20000 and state the result.',
  'What is the current population of Iceland, and compute its growth over 10 years at 1.2 percent?',
]

const runs = []
for (const [idx, name] of [[0, 'Flash-Lite'], [2, 'Pro'], [3, 'Argon']]) {
  const afterPill = await selectByIndex(idx)
  console.log(`\n######## ${name}（pill=${afterPill}）########`)
  const samples = []
  for (const [i, p] of PROMPTS.entries()) {
    const r = JSON.parse(await gen(`${p} <!-- ${name}-${i}-${Date.now()} -->`))
    samples.push(r)
    const tools = Object.entries(r.tools ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}×${v}`).join(' ')
    console.log(`  #${i} len=${String(r.len).padStart(6)} 工具: ${tools || '(无)'}`)
    await sleep(11000)
  }
  runs.push({ name, afterPill, samples })
}

const file = path.join(os.tmpdir(), 'gemini-toolchain.json')
writeFileSync(file, JSON.stringify(runs, null, 2), 'utf8')

console.log('\n=== 各模式工具出现总次数 ===')
for (const r of runs) {
  const total = {}
  for (const s of r.samples) {
    for (const [k, v] of Object.entries(s.tools ?? {})) total[k] = (total[k] ?? 0) + v
  }
  console.log(`${r.name.padEnd(12)} ${JSON.stringify(total)}`)
}
console.log('\n落盘:', file)

page.close()
process.exit(0)
