// 诊断：从 profile 视角复刻 client-modules 的收录判定。
//
// client-modules 只扫描 loader entries 里声明了 dsh.client 的包，并且要求
// exports["./client"] 能解析到一个真实存在的文件。任何一步失败，插件在前端
// 就完全不存在——右下角不会有胶囊，控制台也不会报错，静默消失。
//
// 这里把每一步单独打出来，定位到底断在哪一环。
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const PROFILE = process.env.USERPROFILE + '/.dsh/profiles/desktop'
const PKG = 'dsh-gemini-bridge'
const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }

const requireFromProfile = createRequire(join(PROFILE, 'index.mjs'))

let failed = 0
const check = (n, ok, d = '') => {
  if (ok) log(`PASS  ${n}`)
  else { log(`FAIL  ${n}  ${d}`); failed++ }
}

// 1) 包本身能不能从 profile 解析
let pkgJsonPath
try {
  pkgJsonPath = requireFromProfile.resolve(`${PKG}/package.json`)
  check('包可从 profile 解析', true)
  log(`      ${pkgJsonPath}`)
} catch (e) {
  check('包可从 profile 解析', false, e.code)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
const pkgDir = dirname(pkgJsonPath)

// 2) 声明了 dsh.client 吗
check('声明 dsh.client', pkg.dsh?.client !== undefined)
check('dsh.client.platform 是字符串', typeof pkg.dsh?.client?.platform === 'string', JSON.stringify(pkg.dsh?.client?.platform))

// 3) exports["./client"] 存在且文件真实可读
const clientExport = pkg.exports?.['./client']
check('exports["./client"] 存在', clientExport !== undefined, JSON.stringify(clientExport))
const rel = typeof clientExport === 'string'
  ? clientExport
  : clientExport?.default ?? clientExport?.import
const clientFile = rel ? join(pkgDir, rel) : null
check('client 文件真实存在', clientFile ? existsSync(clientFile) : false, String(clientFile))
if (clientFile && existsSync(clientFile)) {
  const src = readFileSync(clientFile, 'utf8')
  check('client 文件非空', src.length > 100, `len=${src.length}`)
  // 浏览器半身必须走 __ModuleLoader__ 注册
  check('使用 __ModuleLoader__.load', src.includes('window.__ModuleLoader__.load'))
  check('导出 apply', /exports\.apply\s*=/.test(src))
  // id 必须等于包名，否则前端按包名找不到
  const m = src.match(/id:\s*['"]([^'"]+)['"]/)
  check('factory id 等于包名', m?.[1] === PKG, `id=${m?.[1] ?? '(无)'} 期望=${PKG}`)
}

// 4) dsh.client.inject 里每个包都要能从 profile 解析，否则 client 组合失败
log('')
log('== dsh.client.inject 逐项解析 ==')
for (const dep of pkg.dsh?.client?.inject ?? []) {
  let ok = false
  let detail = ''
  try { requireFromProfile.resolve(dep); ok = true } catch (e) { detail = e.code }
  // 宿主内置包可能不在 profile node_modules，而在 DSH 安装目录
  if (!ok) {
    const inInstall = `E:/deepseek/resources/app/dsh/node_modules/${dep}`
    if (existsSync(inInstall)) { ok = true; detail = '(仅在 DSH 安装目录)' }
  }
  check(`  ${dep}`, ok, detail)
}

log('')
log(failed === 0 ? '全部通过' : `失败 ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
