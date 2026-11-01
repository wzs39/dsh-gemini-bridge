// 直接问运行中的 DSH：客户端模块图里到底有没有 gemini-bridge。
//
// 前几次都在猜 HTTP 路径（/plugins/x/client.js 之类），那些路径受鉴权和
// revisioned batch 影响，猜不中不代表插件有问题。这里换一条确定的路：
// DSH 的 client-modules 服务把 graph 注入 index，而 graph 里的每个 batch
// 都带真实 url。用 Web GUI 的鉴权通道取一次 index，解析出 __DSH_BOOT__。
//
// 用法: node bridge/tools/probe-dsh-boot.mjs [port]
import fs from 'node:fs'
import { createRequire } from 'node:module'

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
const PORT = process.argv[2] ?? '4837'
const BASE = `http://127.0.0.1:${PORT}`

// ── 1. 找到一个能通过鉴权的凭据 ──
// DSH web 的鉴权由 dsh-web 自己发放；本机最可靠的是直接用它的 token 文件
// 或已登录浏览器的 cookie。这里先枚举可能的位置。
const candidates = []

// a) web-login 下可能有会话文件
const webLogin = `${process.env.USERPROFILE}\\.dsh\\web-login`
if (fs.existsSync(webLogin)) {
  for (const f of fs.readdirSync(webLogin)) {
    candidates.push(`${webLogin}\\${f}`)
  }
}
log('== 候选凭据位置 ==')
for (const c of candidates.slice(0, 10)) log('  ' + c)

// ── 2. 不带鉴权先看根响应，确认鉴权形态 ──
const rootResp = await fetch(BASE + '/', { signal: AbortSignal.timeout(8000) })
const rootText = await rootResp.text()
log(`\n== GET / ==`)
log(`  status=${rootResp.status}`)
log(`  body=${JSON.stringify(rootText.slice(0, 120))}`)

if (rootResp.status === 200 && rootText.includes('__DSH_BOOT__')) {
  parseBoot(rootText)
} else {
  log('\n根路径需要鉴权，无法直接拿 boot 图。')
  log('改为检查：client bundle 文件本身是否可被 DSH 组合（离线判定）')
  offlineCheck()
}

function parseBoot(html) {
  const m = html.match(/__DSH_BOOT__\s*=\s*(\{[\s\S]*?\});/)
  if (!m) { log('  未在 HTML 中解析到 __DSH_BOOT__'); return }
  let boot
  try { boot = JSON.parse(m[1]) } catch (e) { log('  boot JSON 解析失败: ' + e.message); return }
  const batches = boot.batches ?? []
  log(`\n== boot 图: ${batches.length} 个 batch ==`)
  const ids = new Set()
  for (const b of batches) {
    for (const id of b.ids ?? []) ids.add(id)
    log(`  [${b.phase}] ${b.url}  ids=${(b.ids ?? []).length}`)
  }
  log(`\n== 是否包含 dsh-gemini-bridge: ${ids.has('dsh-gemini-bridge') ? 'YES' : 'NO'} ==`)
  log('  ids: ' + [...ids].slice(0, 40).join(', '))
}

// ── 3. 离线判定：复刻 client-modules 的收录条件 ──
function offlineCheck() {
  const PROFILE = `${process.env.USERPROFILE}\\.dsh\\profiles\\desktop`
  const req = createRequire(PROFILE + '/x.mjs')
  let failed = 0
  const check = (n, ok, d = '') => {
    if (ok) log(`  PASS  ${n}`); else { log(`  FAIL  ${n}  ${d}`); failed++ }
  }

  let pj
  try { pj = req.resolve('dsh-gemini-bridge/package.json') }
  catch (e) { log('  包解析失败: ' + e.code); process.exitCode = 1; return }

  const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
  const dir = pj.replace(/[\\/]package\.json$/, '')
  log('\n== client-modules 收录条件 ==')
  check('dsh.client 存在', pkg.dsh?.client !== undefined)
  check('platform === "web"', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))

  const ce = pkg.exports?.['./client']
  const rel = typeof ce === 'string' ? ce : (ce?.default ?? ce?.import)
  const file = rel ? `${dir}/${rel.replace(/^\.\//, '')}` : null
  check('exports["./client"] 可解析到文件', file ? fs.existsSync(file) : false, String(file))

  if (file && fs.existsSync(file)) {
    const src = fs.readFileSync(file, 'utf8')
    check('bundle 非空', src.length > 200, `len=${src.length}`)
    // factory id 必须等于包名，前端按包名索引
    const idm = src.match(/id:\s*['"]([^'"]+)['"]/)
    check('factory id === 包名', idm?.[1] === pkg.name, `id=${idm?.[1] ?? '(none)'}`)
    check('导出 apply', /exports\.apply\s*=/.test(src))
    // 语法自检：能被 Node 解析成脚本（用 Function 包一层，不执行副作用）
    try { new Function(src); check('bundle 语法可解析', true) }
    catch (e) { check('bundle 语法可解析', false, e.message) }
  }

  // profile 里是否真的登记了
  const profPkg = JSON.parse(fs.readFileSync(PROFILE + '/package.json', 'utf8'))
  check('profile dependencies 已登记', Boolean(profPkg.dependencies?.['dsh-gemini-bridge']))
  check('profile bundles 已包含', (profPkg.dsh?.profile?.bundles ?? []).includes('dsh-gemini-bridge'))

  log('')
  log(failed === 0 ? '离线条件全部满足 —— 收录失败只可能是运行时问题' : `离线条件失败 ${failed} 项`)
  process.exitCode = failed === 0 ? 0 : 1
}
