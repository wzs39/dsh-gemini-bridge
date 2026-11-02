/**
 * 核实：UI 点选能否真正把 pill 切到目标模式。
 *
 * 之前 probe-echo-count 里 `uiSelectAndReload('Pro')` 之后 pill 仍是 Flash-Lite，
 * 说明点击没命中。这里把菜单项的真实文案与点击结果都打出来。
 *
 * 用法：node tools/probe-ui-select.mjs [account]
 */

import { readFileSync } from 'node:fs'
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

console.log('初始 pill:', await pill())

// 打开菜单，列出所有 menuitem 的精确文案
const items = await evaluate(page, `
  (async () => {
    const btn = document.querySelector('button.input-area-switch');
    if (!btn) return JSON.stringify({ error: 'no-button' });
    btn.click();
    await new Promise(function (r) { setTimeout(r, 2000); });
    const list = Array.prototype.slice.call(document.querySelectorAll('gem-menu-item[role="menuitem"]'));
    return JSON.stringify({
      count: list.length,
      texts: list.map(function (e) { return (e.textContent || '').trim(); }),
    });
  })()
`)
console.log('菜单项:', items)
await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
await sleep(1500)

// 按索引点第 N 项（3.1 Pro 通常是第 3 个，index 2）
for (const idx of [2, 0]) {
  const clicked = await evaluate(page, `
    (async () => {
      const btn = document.querySelector('button.input-area-switch');
      btn.click();
      await new Promise(function (r) { setTimeout(r, 1900); });
      const list = Array.prototype.slice.call(document.querySelectorAll('gem-menu-item[role="menuitem"]'));
      const el = list[${idx}];
      if (!el) return 'no-item-' + ${idx};
      const label = (el.textContent || '').trim();
      el.click();
      await new Promise(function (r) { setTimeout(r, 2400); });
      return 'clicked index ' + ${idx} + ' = "' + label + '"';
    })()
  `)
  console.log(clicked)
  await sleep(2200)
  const beforeReload = await pill()
  await page.send('Page.navigate', { url: origin + '/app' })
  await sleep(9500)
  const afterReload = await pill()
  console.log(`  pill 切换后(未刷新)=${beforeReload}   刷新后=${afterReload}`)
}

page.close()
process.exit(0)
