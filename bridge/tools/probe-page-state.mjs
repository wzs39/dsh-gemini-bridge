// 页面 fetch 全部挂起，但 evaluate 正常 —— 检查页面是不是假活：
// 1) 是不是有模态框/重定向拦住
// 2) document.visibilityState / focus
// 3) 用同步 XHR 绕过 fetch（fetch 可能被 service worker 拦截）
// 4) 检查是否有 service worker 接管了作用域
import { attachFirstPage, evaluate } from '../lib/cdp.mjs'

const OUT = '../runs/page-state.log'
const fs = await import('node:fs')
try { fs.writeFileSync(OUT, '') } catch { /* ignore */ }
const log = (...a) => {
  const line = a.join(' ') + '\n'
  process.stdout.write(line)
  try { fs.appendFileSync(OUT, line) } catch { /* ignore */ }
}
const race = (p, ms, label) => Promise.race([
  p, new Promise((_, r) => setTimeout(() => r(new Error(label + ' TIMEOUT')), ms)),
])

const page = await attachFirstPage(9334, { preferOrigin: 'https://gemini.google.com' })

// A. 页面基本状态
try {
  const st = await race(evaluate(page, `(function(){
    return {
      href: location.href,
      ready: document.readyState,
      visibility: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
      online: navigator.onLine,
      title: document.title,
      swController: navigator.serviceWorker && navigator.serviceWorker.controller
        ? navigator.serviceWorker.controller.scriptURL : null,
    };
  })()`), 10000, 'state')
  log('== 页面状态 ==')
  for (const [k, v] of Object.entries(st ?? {})) log(`  ${k}: ${JSON.stringify(v)}`)
} catch (e) { log('state ->', e.message) }

// B. 已注册的 service worker（可能拦截 fetch）
try {
  const sw = await race(evaluate(page, `(async function(){
    if (!navigator.serviceWorker) return { supported: false };
    const rs = await navigator.serviceWorker.getRegistrations();
    return { supported: true, count: rs.length,
      scopes: rs.map(r => ({ scope: r.scope, active: r.active ? r.active.scriptURL : null })) };
  })()`), 10000, 'sw')
  log('\n== Service Worker ==')
  log('  ' + JSON.stringify(sw))
} catch (e) { log('sw ->', e.message) }

// C. 用同步 XHR（不经过 fetch 的信号量/调度）
try {
  const x = await race(evaluate(page, `(function(){
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/app', false);   // sync
      xhr.send(null);
      return { status: xhr.status, len: xhr.responseText.length };
    } catch (e) { return { err: String(e) }; }
  })()`), 20000, 'xhr')
  log('\n== 同步 XHR GET /app ==')
  log('  ' + JSON.stringify(x))
} catch (e) { log('\n== 同步 XHR ==\n  ' + e.message) }

// D. 再看看页面里有没有 blocking 的 modal（Google 的 cookie/consent 弹层）
try {
  const m = await race(evaluate(page, `(function(){
    const txt = (document.body && document.body.innerText || '').slice(0, 600);
    return { bodyLen: (document.body && document.body.innerText || '').length, head: txt };
  })()`), 10000, 'modal')
  log('\n== 页面可见文本（前 600）==')
  log(JSON.stringify(m?.head ?? ''))
} catch (e) { log('modal ->', e.message) }

page.close?.()
setTimeout(() => process.exit(0), 300)
