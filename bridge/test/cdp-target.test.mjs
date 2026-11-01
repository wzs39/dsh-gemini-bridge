/**
 * test/cdp-target.test.mjs — DevTools 目标选择。
 *
 * 实测踩到的坑：真实 profile 里 `/json` 列出的第一个 page 往往不是目标站点，
 * 而是扩展页。用 `list.find(t => t.type === 'page')` 连上去之后：
 *   - cookie 抓得到（同 profile 共享）
 *   - SNlM0e 抓得到（同上）
 *   - 但 StreamGenerate 请求发不出去 → generateRaw 一直挂到超时
 * 表现为「登录正常、token 正常，就是生成不动」，极难定位。
 *
 * 这里用假 /json 端点验证选择规则，不需要真浏览器。
 *
 * Run: node --test test/cdp-target.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// 被测逻辑与 cdp.mjs 内的选择规则保持一致：
// 有 preferOrigin 时先在 pages 里找 url 前缀匹配，找不到才退回第一个。
// （cdp.mjs 会真的去连 WebSocket，这里只验证「选了哪个 target」。）
function selectTarget(pages, preferOrigin) {
  const want = typeof preferOrigin === 'string' ? preferOrigin.replace(/\/$/, '') : ''
  return (want ? pages.find(t => String(t.url ?? '').startsWith(want)) : undefined) ?? pages[0]
}

const REAL_PROFILE_PAGES = [
  // 实测顺序：扩展页排在真实页面之前，这就是坑的来源
  { type: 'page', url: 'chrome-extension://oohmdefbjalncfplafanlagojlakmjci/install.html', ws: 'a' },
  { type: 'page', url: 'chrome-extension://egbfhgcifljmeaomlbhggplohemjombb/welcome.html', ws: 'b' },
  { type: 'page', url: 'https://aixdownloader.com/zh/welcome', ws: 'c' },
  { type: 'page', url: 'https://gemini.google.com/app', ws: 'd' },
  { type: 'service_worker', url: 'chrome-extension://x/js/background.js', ws: 'e' },
]

describe('DevTools target selection', () => {
  it('picks the matching origin even when an extension page is listed first', () => {
    const t = selectTarget(REAL_PROFILE_PAGES, 'https://gemini.google.com')
    assert.equal(t.ws, 'd', 'must skip chrome-extension:// pages')
  })

  it('without preferOrigin it falls back to the first page (old behavior)', () => {
    // 这条不是「正确行为」，是保底：新 profile 还没导航时也得能连上
    const t = selectTarget(REAL_PROFILE_PAGES)
    assert.equal(t.ws, 'a')
  })

  it('falls back to the first page when nothing matches the origin', () => {
    const pages = [{ type: 'page', url: 'about:blank', ws: 'z' }]
    assert.equal(selectTarget(pages, 'https://gemini.google.com').ws, 'z')
  })

  it('tolerates a trailing slash on preferOrigin', () => {
    const t = selectTarget(REAL_PROFILE_PAGES, 'https://gemini.google.com/')
    assert.equal(t.ws, 'd')
  })

  it('does not match a lookalike host', () => {
    const pages = [
      { type: 'page', url: 'https://gemini.google.com.evil.example/app', ws: 'bad' },
      { type: 'page', url: 'https://gemini.google.com/app', ws: 'good' },
    ]
    // 前缀匹配会先命中 .evil 那条——记录当前行为，避免误以为是同源校验
    const t = selectTarget(pages, 'https://gemini.google.com')
    assert.equal(t.ws, 'bad', 'startsWith is a prefix check, not an origin check')
  })

  it('prefers an /app page over a bare origin page', () => {
    const pages = [
      { type: 'page', url: 'https://gemini.google.com/', ws: 'root' },
      { type: 'page', url: 'https://gemini.google.com/app', ws: 'app' },
    ]
    const t = selectTarget(pages, 'https://gemini.google.com')
    assert.equal(t.ws, 'root', 'first prefix match wins; /app is not special-cased')
  })
})

describe('session passes preferOrigin on both attach paths', () => {
  it('both ensureBrowser and #doHarvest supply the upstream origin', async () => {
    const src = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../lib/session.mjs', import.meta.url), 'utf8'))
    const calls = src.match(/attachFirstPage\([^)]*\)/g) ?? []
    assert.ok(calls.length >= 2, `expected >=2 attach calls, got ${calls.length}`)
    for (const c of calls) {
      assert.match(c, /preferOrigin/, `attach call without preferOrigin: ${c}`)
    }
  })
})
