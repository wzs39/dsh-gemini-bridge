// 直接驱动打完补丁的 StreamTranslator，喂 subagent 事件，看它吐出来的块类型。
// 这比"语法通过"强得多：它证明运行期真的产生 tool-call 块而不是 reasoning 文本。
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const distPath = process.argv[2] ??
  'C:/Users/qwe/.dsh/profiles/desktop/node_modules/dsh-agy-link/dist/index.js'

const mod = await import(pathToFileURL(distPath).href)

// 找导出里的 translator 构造器（名字可能被压缩，按形状探测）。
const candidates = []
for (const [k, v] of Object.entries(mod)) {
  if (typeof v === 'function' && /translate|stream|emitter|chunk/i.test(k)) candidates.push([k, v])
}
console.log('[probe] candidate exports:', candidates.map(([k]) => k).join(', ') || '(none)')

// 兜底：遍历所有导出找带 prototype.ensureBlock 的类
let Ctor = null, name = null
for (const [k, v] of Object.entries(mod)) {
  if (typeof v === 'function' && v.prototype && typeof v.prototype.ensureBlock === 'function') {
    Ctor = v; name = k; break
  }
}
console.log('[probe] translator class:', name ?? '(not found)')
if (!Ctor) {
  console.log('[probe] 无法定位 translator；跳过运行期验证（补丁本身语法已通过）')
  process.exit(0)
}

const opts = {
  runId: 'probe-run',
  cutOnTool: true,
  useCodeWrapper: false,
  supportsGoalUpdate: false,
  supportsPlanExit: false,
  usage: { finalUsage: () => ({}) },
  resolvedThoughts: new Map(),
  resolvedFullArgs: new Map(),
}
const t = new Ctor(opts)

const events = [
  // 一个 thinking 步骤
  { kind: 'step', stepKind: 'thinking', stepKey: 't1', text: 'let me think' },
  // 一个 subagent 步骤（补丁前：进 reasoning；补丁后：tool-call 块）
  { kind: 'step', stepKind: 'subagent', stepKey: 's1', text: 'subagent started', state: 'ACTIVE' },
  { kind: 'step', stepKind: 'subagent', stepKey: 's1', text: 'subagent started working', state: 'ACTIVE' },
  // 收尾
  { kind: 'result', ok: true, response: 'done', conversationId: 'c1', usage: {} },
]

const out = []
async function drive() {
  for (const ev of events) {
    for await (const chunk of t.translate(ev)) out.push(chunk)
  }
}

// 方法名可能不同：探测 translate / translateEvent / push
const method = ['translate', 'translateEvent', 'push', 'handle'].find(m => typeof t[m] === 'function')
console.log('[probe] driving method:', method ?? '(none)')
if (!method) { process.exit(0) }

async function driveAny() {
  for (const ev of events) {
    for await (const chunk of t[method](ev)) out.push(chunk)
  }
}

try {
  await driveAny()
} catch (e) {
  console.log('[probe] drive error:', e.message.slice(0, 200))
}

const blockTypes = out.filter(c => c.type === 'block-start').map(c => c.blockType)
const toolBlocks = out.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call')
const subagentBlocks = toolBlocks.filter(c => c.block.name === 'agy_subagent')

console.log('\n[probe] block-start types:', JSON.stringify(blockTypes))
console.log('[probe] tool-call blocks:', toolBlocks.length, '| agy_subagent:', subagentBlocks.length)

if (subagentBlocks.length > 0) {
  console.log('\n[probe] ✓ subagent 现在产生独立 tool-call 块')
  for (const b of subagentBlocks) {
    console.log('  name=' + b.block.name + ' args=' + String(b.block.arguments).slice(0, 160))
  }
} else {
  console.log('\n[probe] ✗ 没看到 agy_subagent 块')
  const reasoning = out.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
  console.log('  reasoning 文本:', JSON.stringify(reasoning.slice(0, 200)))
  process.exitCode = 1
}
