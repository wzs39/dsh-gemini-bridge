// 深度诊断：不走完整 session，手工复现 generateRaw 的三个阶段，
// 每步打印，定位到底是页面没就绪、token 不对、还是 fetch 本身挂住。
import { loadConfig } from '../lib/config.mjs'
import { AccountManager } from '../lib/manager.mjs'
import { attachFirstPage, evaluate } from '../lib/cdp.mjs'
import { appendFileSync, writeFileSync } from 'node:fs'

const OUT = process.argv[3] ?? '../runs/diag-live.log'
try { writeFileSync(OUT, '') } catch { /* ignore */ }
const log = (...a) => {
  const line = a.join(' ') + '\n'
  process.stdout.write(line)
  try { appendFileSync(OUT, line) } catch { /* ignore */ }
}
const name = process.argv[2] ?? 'pro1'
const config = loadConfig()
const manager = new AccountManager(config)
const acct = manager.pickAccountByName(name)
const port = acct.config.browser.port
const origin = config.upstream.origin
log(`[${name}] port=${port} origin=${origin}`)

// 先把浏览器拉起来（用 session 的 ensureBrowser）
await acct.session.ensureBrowser()
log('ensureBrowser ok')

// ── 1. 列出全部 target ──
const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())
const pages = list.filter(t => t.type === 'page')
log(`\n== ${pages.length} 个 page target ==`)
for (const [i, p] of pages.entries()) {
  log(`  [${i}] ${JSON.stringify(p.url).slice(0, 90)}`)
  log(`       ws=${(p.webSocketDebuggerUrl ?? '').slice(-28)}`)
}

// ── 2. 用 preferOrigin 连一次，看落在了哪 ──
const page = await attachFirstPage(port, { preferOrigin: origin })
const href = await evaluate(page, 'location.href')
const ready = await evaluate(page, 'document.readyState')
log(`\n== attach 结果 ==`)
log(`  href  = ${JSON.stringify(href)}`)
log(`  ready = ${ready}`)

// ── 3. 页面里能否真的读到 token ──
const toks = await evaluate(page, `(function(){
  const g = window.WIZ_global_data || {};
  return { snlm0e: g.SNlM0e || null, cfb2h: g.cfb2h || null, fdr: g.FdrFJe || null,
           hasGemini: typeof window.WIZ_global_data !== 'undefined' };
})()`)
log(`\n== 页面全局数据 ==`)
log(`  hasGeminiData = ${toks?.hasGemini}`)
log(`  snlm0e        = ${toks?.snlm0e ? String(toks.snlm0e).slice(0, 30) + '… (len ' + String(toks.snlm0e).length + ')' : 'null'}`)
log(`  cfb2h         = ${toks?.cfb2h ?? 'null'}`)

if (!toks?.snlm0e) {
  log('\n页面里没有 SNlM0e —— 说明连的不是 gemini 应用页，或页面未加载完')
  manager.stopAll(); setTimeout(() => process.exit(1), 300)
}

// ── 4. 手工发一次 StreamGenerate，带分段计时 ──
const snlm0e = toks.snlm0e
const bl = toks.cfb2h || toks.fdr
const inner = [[ 'Reply with exactly: DIAG-OK', 0, null, null, null, null, 0 ], ['en'], ['', '', '', null, null, null, null, null, null, '']]
const fReq = JSON.stringify([null, JSON.stringify(inner)])
const params = new URLSearchParams({ bl, rt: 'c', _reqid: String(Math.floor(Math.random()*900000)+100000), at: snlm0e })
const url = `${origin}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?${params}`
const body = new URLSearchParams({ 'f.req': fReq }).toString()

log(`\n== 手工 StreamGenerate ==`)
log(`  bl   = ${bl}`)
log(`  url  = ${url.slice(0, 130)}…`)
const t0 = Date.now()
const res = await evaluate(page, `
  (async () => {
    const t = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1' },
        body: ${JSON.stringify(body)},
        credentials: 'include',
        signal: ctrl.signal,
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, len: text.length, ms: Date.now() - t, head: text.slice(0, 200) };
    } catch (e) {
      return { error: String(e && e.message || e), ms: Date.now() - t };
    } finally { clearTimeout(timer); }
  })()
`)
log(`  总耗时 ${Date.now() - t0}ms`)
log(`  结果: ${JSON.stringify(res, null, 2).slice(0, 800)}`)

page.close?.()
manager.stopAll()
setTimeout(() => process.exit(0), 500)
