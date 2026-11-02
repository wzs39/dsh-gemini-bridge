/**
 * 探针 18：完整判定「模型 hash → 刷新后文案」，建立可信映射表。
 *
 * 关键点：页面每次导航都会丢掉注入的 window.__rpc，必须在导航后重新注入。
 *
 * 用法：node tools/probe-mode-map.mjs [account]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const account = process.argv[2] ?? 'pro3'

const cfgPath = process.env.GEMINI_BRIDGE_CONFIG
  ?? path.join(os.homedir(), '.dsh', 'gemini-bridge', 'config.json')
const config = JSON.parse(readFileSync(cfgPath, 'utf8'))
const acct = (config.accounts ?? []).find((a) => a.name === account)
if (!acct) { console.error(`no account named ${account}`); process.exit(1) }
const port = acct.cdpPort ?? config.browser?.port ?? 9354
const origin = config.upstream?.origin ?? 'https://gemini.google.com'

const { attachFirstPage, evaluate } = await import('../lib/cdp.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(origin + '/app')}`, {
  method: 'PUT',
}).then(async (r) => (r.ok ? r.json() : { err: `HTTP ${r.status}` })).catch((e) => ({ err: String(e) }))
if (created.err) { console.error('new tab failed:', created.err); process.exit(1) }
await sleep(8000)

const page = await attachFirstPage(port, { preferOrigin: origin })

const INJECT = `(() => {
  window.__rpc = async function (id, payload) {
    const w = window.WIZ_global_data || {};
    const at = w.SNlM0e, bl = w.cfb2h || w.FdrFJe;
    let sid = null;
    for (const k of Object.keys(w)) if (typeof w[k] === 'string' && /^-?\\\\d{15,}$/.test(w[k]) && /sid/i.test(k)) sid = w[k];
    if (!sid) { const m = document.documentElement.innerHTML.match(/"FdrFJe":"(-?\\\\d+)"/); if (m) sid = m[1]; }
    const p = new URLSearchParams({ rpcids: id, 'source-path': '/app', bl: bl||'', 'f.sid': sid||'', hl: 'zh-CN', _reqid: String(Math.floor(Math.random()*9e6)+1e6), rt: 'c' });
    const r = await fetch('/_/BardChatUi/data/batchexecute?' + p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
      body: new URLSearchParams({ 'f.req': JSON.stringify([[[id, payload, null, 'generic']]]), at }).toString(),
      credentials: 'include',
    });
    return { status: r.status, text: await r.text() };
  };
  return 'ok';
})()`

const readLabel = () => evaluate(page, `(() => { const b=document.querySelector('button.input-area-switch'); return b ? (b.getAttribute('aria-label')||b.textContent||'').trim() : null })()`)
const relabel = (s) => { const m = String(s ?? '').match(/当前模式为[“"]([^”"]+)[”"]/); return m ? m[1] : String(s ?? '') }

const candidates = [
  ['8c46e95b1a07cecc', 'Flash-Lite'],
  ['56fdd199312815e2', 'Flash'],
  ['e6fa609c3fa255c0', 'Pro'],
  ['95a4c0abcba24364', 'Argon'],
]

const map = []
console.log('初始模式:', relabel(await readLabel()))

for (const [hash, expect] of candidates) {
  await evaluate(page, INJECT)
  const r = await evaluate(page, `(async () => {
    const arr = new Array(100).fill(null);
    arr[99] = ${JSON.stringify(hash)};
    const res = await window.__rpc('L5adhe', JSON.stringify([arr, null, [100]]));
    return res.status + ' ' + (res.text.match(/"wrb\\\\.fr","L5adhe","([^"]*)"/) || [,'?'])[1];
  })()`)
  await sleep(1500)
  await page.send('Page.navigate', { url: `${origin}/app` })
  await sleep(9000)
  const label = relabel(await readLabel())
  const ok = label === expect
  map.push({ hash, expect, rpc: r, afterReload: label, ok })
  console.log(`${expect.padEnd(12)} hash=${hash} rpc=${String(r).padEnd(12)} 刷新后="${label}" ${ok ? '✓' : '✗'}`)
}

const file = path.join(os.tmpdir(), 'gemini-model-hash-map.json')
writeFileSync(file, JSON.stringify(map, null, 2), 'utf8')
console.log('\n落盘:', file)
console.log('全部匹配:', map.every((m) => m.ok))
page.close()
process.exit(0)
