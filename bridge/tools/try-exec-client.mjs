// 在 Node 里模拟 DSH 浏览器端的模块加载器，真正执行 client.js。
//
// 静态检查全过（id 对、apply 导出、语法可解析），前端却看不到任何东西，
// 那大概率是 factory 执行期抛错。DSH 的 __ModuleLoader__ 是 queue 模式：
// 先收 load({id, factory}) 注册，再由 create() 把 factory 跑起来。
// 这里提供一个最小假的 loader + 假 React，把 factory 跑一遍，
// 任何 throw 都会被原样打出来。
//
// 用法: node bridge/tools/try-exec-client.mjs
import fs from 'node:fs'
import vm from 'node:vm'

// client.js 属于插件根目录的 lib/（宿主半身），不在 bridge/lib/（网关本体）
const CLIENT = new URL('../../lib/client.js', import.meta.url)
const src = fs.readFileSync(CLIENT, 'utf8')

const log = (...a) => { process.stdout.write(a.join(' ') + '\n') }
let failed = 0
const check = (n, ok, d = '') => {
  if (ok) log(`PASS  ${n}`); else { log(`FAIL  ${n}  ${d}`); failed++ }
}

// ── 假 React：只要组件不被真正渲染，createElement 返回普通对象即可 ──
const React = {
  createElement: (type, props, ...children) => ({ $$type: type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
}

const registrations = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(reg) { registrations.push(reg) },
    },
  },
  document: {
    createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
    head: { appendChild() {} },
    querySelector: () => null,
    body: { appendChild() {} },
  },
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' }),
  AbortSignal: { timeout: () => undefined },
  encodeURIComponent,
  JSON,
  Math,
  Date,
  Promise,
  Symbol,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  TypeError,
}

let ctx
try {
  ctx = vm.createContext(sandbox)
  vm.runInContext(src, ctx, { filename: 'lib/client.js' })
  check('client.js 可在沙箱执行', true)
} catch (e) {
  check('client.js 可在沙箱执行', false, `${e.name}: ${e.message}`)
  process.exitCode = 1
  process.exit(1)
}

check('通过 __ModuleLoader__.load 注册', registrations.length === 1, `count=${registrations.length}`)
const reg = registrations[0]
check('registration 有 id', typeof reg?.id === 'string', String(reg?.id))
check('registration 有 factory', typeof reg?.factory === 'function')

// ── 执行 factory（等价于浏览器 create() 里的那一步）──
let exported
try {
  exported = reg.factory((spec) => {
    if (spec === 'react') return React
    throw new Error(`unexpected external: ${spec}`)
  })
  check('factory 执行无异常', true)
} catch (e) {
  check('factory 执行无异常', false, `${e.name}: ${e.message}`)
  process.exitCode = 1
  process.exit(1)
}

check('factory 返回 exports 对象', typeof exported === 'object' && exported !== null)
check('exports.apply 是函数', typeof exported?.apply === 'function', typeof exported?.apply)
check('exports.inject 是数组', Array.isArray(exported?.inject), JSON.stringify(exported?.inject))

// ── 执行 apply（等价于宿主激活插件）──
// 假 slots：记录注册了哪些 slot。默认两个都「存在」，模拟正常宿主。
const registered = []
let injectedSlots = []
const fakeCtx = {
  locale: {
    register(ns, dict) { return { ns } },
    bind(ns) { return (k) => String(k) },
  },
  slots: {
    inject(slot, fn) {
      injectedSlots.push(slot)
      // 宿主行为：slot 存在才调用 fn
      return fn()
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

try {
  await exported.apply(fakeCtx)
  check('apply 执行无异常', true)
} catch (e) {
  check('apply 执行无异常', false, `${e.name}: ${e.message}`)
  process.exitCode = 1
  process.exit(1)
}

log('')
log('== 注册结果 ==')
log('  inject 过的 slot: ' + JSON.stringify(injectedSlots))
log('  实际 register: ' + JSON.stringify(registered.map(r => r.options?.id ?? r.options?.key ?? r.options?.name)))
check('注册了 usage 卡片', registered.some(r => r.options?.id === 'dsh-gemini-bridge-usage'))
check('注册了 brain 面板', registered.some(r => r.options?.id === 'dsh-gemini-bridge-brain'))

// ── 侧边栏面板配对：sidebar.panellist.id 必须等于 main.key ──
// 官方 plugin-manager / schedule 的配对方式。写岔了不会报错，只是点了图标
// 切不到面板——静默失效，所以必须有断言兜住。
const panellist = registered.find(r => r.options?.name === 'sidebar.panellist')
const mainPanel = registered.find(r => r.options?.name === 'main')
check('注册了 sidebar.panellist 图标', Boolean(panellist))
check('注册了 main 面板', Boolean(mainPanel))
if (panellist && mainPanel) {
  check(
    'panellist.id === main.key（点图标能切到面板）',
    panellist.options.id === mainPanel.options.key,
    `id=${panellist.options.id} key=${mainPanel.options.key}`,
  )
  check('图标有 label', typeof panellist.options.label === 'function' || typeof panellist.options.label === 'string')
}

log('')
log(failed === 0 ? '全部通过 —— bundle 在运行时是健康的' : `失败 ${failed}`)
process.exitCode = failed === 0 ? 0 : 1
