// tool-gating 真值表：验证「哪些模型会真的回 functionCall」这条判定。
//
// 背景（实测，不是推断）：网页通道 gemini-web 拿到 tools 也不会调用——
// 整个对话被拍平成一段 prompt 发给 StreamGenerate，拿回的是成品文本。
// 一次「用 get_weather 查天气」的实测结果：finish=stop、tool_calls 为空、
// 正文自己编了个天气，还夹带 http://googleusercontent.com/card_content/0。
//
// 给不支持工具的模型声明 tools 的代价不是「没用」，而是：宿主会把 skill
// 与工具链挂到它上面，然后因为永远等不到 tool_calls 而空转或卡死。
// 所以这条判定必须有测试兜着。
//
// 直接复刻实现里的归一化逻辑：peer 依赖只在 DSH 运行时存在，仓库里 import
// 不到 @deepseek-ai/dsh-llm，所以不在单测里实例化整个 adapter。
function supportsTools(model, webModel = 'gemini-web') {
  const id = typeof model === 'string' ? model : ''
  if (id === '') return false
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
  return norm(id) !== norm(webModel) && norm(id) !== 'gemini-web'
}

const CASES = [
  // ── 网页通道：不支持工具 ──
  ['gemini-web', false],
  ['GEMINI-WEB', false],
  ['Gemini-Web', false],
  ['  gemini-web  ', false],
  // ── 空/异常输入：一律当不支持，别默认开 ──
  ['', false],
  [null, false],
  [undefined, false],
  [123, false],
  // ── agy 通道：支持工具（实测 finish_reason=tool_calls）──
  ['gemini-3.8-flash-medium', true],
  ['gemini-3.8-flash-high', true],
  ['gemini-3-flash', true],
  ['claude-sonnet-4-6', true],
  ['claude-opus-4-6-thinking', true],
  ['gpt-oss-120b-medium', true],
]

let failed = 0
for (const [model, want] of CASES) {
  const got = supportsTools(model)
  const ok = got === want
  if (!ok) failed++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${String(JSON.stringify(model)).padEnd(30)} got=${String(got).padEnd(5)} want=${want}\n`)
}

// webModel 被配置成别的名字时，那条名字也必须被排除
const custom = supportsTools('my-web-channel', 'my-web-channel')
process.stdout.write(`${custom === false ? 'PASS' : 'FAIL'}  custom webModel excluded   got=${custom}\n`)
if (custom !== false) failed++

process.stdout.write(`\n${failed === 0 ? '全部通过' : `失败 ${failed}`}\n`)
process.exit(failed === 0 ? 0 : 1)
