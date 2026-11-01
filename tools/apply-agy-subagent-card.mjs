#!/usr/bin/env node
/**
 * apply-agy-subagent-card.mjs — 让 dsh-agy-link 的 subagent 在 DSH 里显示为卡片
 *
 * 问题
 * ----
 * dsh-agy-link 把 subagent 步骤（stepKind === "subagent"）拼进 reasoning 块：
 *     yield* this.ensureBlock("reasoning")
 *     appendDelta("[agy subagent] " + text)
 * reasoning 在 DSH 里是一个折叠的灰字文本块，不是可独立渲染的块类型，所以
 * 子代理内容永远不可能有卡片，只能作为 "[agy subagent] ..." 混在思考文本里；
 * 而且它和 thinking 共用同一个块，两者交替出现会互相把对方挤出块外。
 *
 * 修法
 * ----
 * 把 subagent 分支从 reasoning 改成 tool-call 块（和 agy_tool 同一机制），
 * 每个 subagent 步骤发一个 name = "agy_subagent" 的 tool-call：
 *     yield { type: "block-start", blockType: "tool-call" }
 *     yield { type: "block-end", block: { type: "tool-call", name: "agy_subagent", ... } }
 * 并给 presentMirrorCall / presentMirrorResult 加对应 case 让它渲染成原生卡片。
 *
 * 用法
 * ----
 *   node apply-agy-subagent-card.mjs                # 打到默认桌面 profile
 *   node apply-agy-subagent-card.mjs --check         # 只检查是否已打/可打
 *   node apply-agy-subagent-card.mjs --revert        # 从备份还原
 *   node apply-agy-subagent-card.mjs --path <dir>    # 指定 dsh-agy-link 目录
 *
 * 幂等：已打过会直接退出 0；找不到锚点会明确报错，不会写坏文件。
 * 备份：<agy-link>/dist/index.js.bak-subagent-card（首次打补丁时创建）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// ── 定位插件目录 ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const revert = argv.includes('--revert')
const pathFlag = argv.indexOf('--path')
const explicitPath = pathFlag !== -1 ? argv[pathFlag + 1] : null

function candidateDirs() {
  if (explicitPath) return [explicitPath]
  const out = []
  const profiles = path.join(os.homedir(), '.dsh', 'profiles')
  try {
    for (const entry of fs.readdirSync(profiles)) {
      out.push(path.join(profiles, entry, 'node_modules', 'dsh-agy-link'))
    }
  } catch { /* no profiles dir */ }
  // Also the flat plugin location some installs use.
  out.push(path.join(os.homedir(), '.dsh', 'plugins', 'dsh-agy-link'))
  return out
}

const targetDir = candidateDirs().find(d => fs.existsSync(path.join(d, 'dist', 'index.js')))
if (!targetDir) {
  console.error('[patch] 找不到 dsh-agy-link/dist/index.js。用 --path 指定插件目录。')
  console.error('[patch] 试过：')
  for (const d of candidateDirs()) console.error('  ' + d)
  process.exit(1)
}

const distFile = path.join(targetDir, 'dist', 'index.js')
const bakFile = path.join(targetDir, 'dist', 'index.js.bak-subagent-card')

console.log(`[patch] target: ${distFile}`)

// ── 锚点 ────────────────────────────────────────────────────────────────────

const MARKER = 'AGY_SUBAGENT_TOOL_NAME'

// 原始（未打补丁）形态：subagent 和 thinking 合并处理，且拼进 reasoning。
// 必须整段匹配到 else 分支结束，否则只替换前半段会留下孤立的 `} else {`
// （那样会破坏括号配对 —— 实测过，node --check 会在后面的 if (!ev.ok) 处报错）。
const OLD_BRANCH = `\t\t\tif (ev.stepKind === "thinking" || ev.stepKind === "subagent") {
\t\t\t\tyield* this.ensureBlock("reasoning");
\t\t\t\tif (ev.stepKind === "thinking") {
\t\t\t\t\tconst dbThought = this.opts.resolvedThoughts?.get(absIndex);
\t\t\t\t\tif (dbThought && dbThought.trim() !== "") {
\t\t\t\t\t\tconst delta = suffixDelta(this.emittedByKey.get(ev.stepKey) ?? "", dbThought);
\t\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, dbThought);
\t\t\t\t\t\tconst d = this.appendDelta(delta);
\t\t\t\t\t\tif (d) yield d;
\t\t\t\t\t} else {
\t\t\t\t\t\tconst delta = suffixDelta(this.emittedByKey.get(ev.stepKey) ?? "", ev.text);
\t\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, ev.text);
\t\t\t\t\t\tconst d = this.appendDelta(delta);
\t\t\t\t\t\tif (d) yield d;
\t\t\t\t\t}
\t\t\t\t} else {
\t\t\t\t\tconst prev = this.emittedByKey.get(ev.stepKey) ?? "";
\t\t\t\t\tconst deltaText = suffixDelta(prev, ev.text);
\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, ev.text);
\t\t\t\t\tconst banner = prev === "" ? "[agy subagent] " : "";
\t\t\t\t\tconst d = this.appendDelta(banner + deltaText);
\t\t\t\t\tif (d) yield d;
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}`

// 打补丁后的形态：subagent 单独分支，发 tool-call。
const NEW_BRANCH = `\t\t\tif (ev.stepKind === "subagent") {`

const OLD_CONSTS = `\tfinished = false;
\ttotalTextOutput = "";`

const OLD_MIRROR = `const MIRROR_TOOL_NAME = "agy_tool";`

const OLD_PRESENT_CALL = `function presentMirrorCall(args) {
\tconst a = args;
\tconst name = typeof a?.tool === "string" ? a.tool : "";
\tconst input = toolInput(a);
\tswitch (name) {
\t\tcase "run_command":`

const OLD_PRESENT_RESULT = `\tconst text = resultText$1(result.content);
\tswitch (name) {
\t\tcase "run_command":`

// ── 补丁内容 ────────────────────────────────────────────────────────────────

const NEW_CONSTS = `\tfinished = false;
\ttotalTextOutput = "";
\t/** Subagent step keys that already received a card (suffix-delta dedupe). */
\tsubagentOpened = /* @__PURE__ */ new Set();
\t/** True once any subagent step was emitted as a card. */
\tsawSubagentStep = false;`

const NEW_MIRROR = `const MIRROR_TOOL_NAME = "agy_tool";
/**
 * Synthetic tool name for streamed subagent steps.
 *
 * Subagent activity arrives as \`stepKind: "subagent"\` events. It used to be
 * appended to the reasoning block as "[agy subagent] ..." prose, so DSH could
 * never give it a card (reasoning is one collapsed text block). Emitting a
 * tool-call block under this name makes each subagent step render as its own
 * card, the same mechanism agy_tool already uses.
 */
const AGY_SUBAGENT_TOOL_NAME = "agy_subagent";`

const NEW_PRESENT_CALL = `function presentMirrorCall(args) {
\tconst a = args;
\tconst name = typeof a?.tool === "string" ? a.tool : "";
\tconst input = toolInput(a);
\tswitch (name) {
\t\tcase AGY_SUBAGENT_TOOL_NAME: {
\t\t\t// Synthetic card for a streamed subagent step (see AGY_SUBAGENT_TOOL_NAME).
\t\t\t// agy sends no DSH agent id here, so there is nothing to link back to a
\t\t\t// child session -- the card shows the step's role/status and its text.
\t\t\tconst role = pick$1(input, "role", "Role", "TypeName");
\t\t\tconst status = pick$1(input, "status", "Status", "state");
\t\t\treturn {
\t\t\t\tcard: "generic",
\t\t\t\ttitle: role ? \`Subagent: \${role}\` : "Subagent",
\t\t\t\t...status !== void 0 ? { description: String(status) } : {},
\t\t\t\tkind: "other"
\t\t\t};
\t\t}
\t\tcase "run_command":`

const NEW_PRESENT_RESULT = `\tconst text = resultText$1(result.content);
\tswitch (name) {
\t\tcase AGY_SUBAGENT_TOOL_NAME: {
\t\t\t// Streaming subagent text can be long; keep the card readable but do not
\t\t\t// clip as aggressively as generic tool output (10k vs 4k).
\t\t\tconst body = pick$1(args, "text") ?? text;
\t\t\treturn {
\t\t\t\tcard: "generic",
\t\t\t\tcontent: [{
\t\t\t\t\ttype: "text",
\t\t\t\t\ttext: clip(typeof body === "string" ? body : text, 1e4)
\t\t\t\t}]
\t\t\t};
\t\t}
\t\tcase "run_command":`

const NEW_BRANCH_BODY = `\t\t\tif (ev.stepKind === "subagent") {
\t\t\t\t// Subagent steps used to be flattened into the reasoning block as
\t\t\t\t// "[agy subagent] ..." prose, which is why DSH could never draw a
\t\t\t\t// card for them: reasoning is collapsed grey text, not a block type
\t\t\t\t// the UI renders individually. Emit a tool-call block instead so
\t\t\t\t// each subagent step becomes its own card, exactly like agy_tool.
\t\t\t\tconst prev = this.emittedByKey.get(ev.stepKey) ?? "";
\t\t\t\tconst deltaText = suffixDelta(prev, ev.text);
\t\t\t\tthis.emittedByKey.set(ev.stepKey, ev.text);
\t\t\t\tif (deltaText === "" && !this.subagentOpened.has(ev.stepKey)) return;
\t\t\t\tconst close = this.closeOpen();
\t\t\t\tif (close) yield close;
\t\t\t\tconst idx = this.blockIdx;
\t\t\t\tconst rawCallId = \`agy-subagent-\${this.opts.runId}-\${ev.stepKey}\`;
\t\t\t\tconst assignedCallId = rememberToolCallId(this.toolCallStates, rawCallId, AGY_SUBAGENT_TOOL_NAME);
\t\t\t\tconst priorText = prev === "" ? "" : prev;
\t\t\t\tyield {
\t\t\t\t\ttype: "block-start",
\t\t\t\t\tindex: idx,
\t\t\t\t\tblockType: "tool-call"
\t\t\t\t};
\t\t\t\tyield {
\t\t\t\t\ttype: "block-end",
\t\t\t\t\tindex: idx,
\t\t\t\t\tblock: {
\t\t\t\t\t\ttype: "tool-call",
\t\t\t\t\t\tid: toToolCallId(assignedCallId),
\t\t\t\t\t\tname: AGY_SUBAGENT_TOOL_NAME,
\t\t\t\t\t\targuments: JSON.stringify({
\t\t\t\t\t\t\trun: this.opts.runId,
\t\t\t\t\t\t\tstep: ev.stepKey,
\t\t\t\t\t\t\trole: ev.subagentRole ?? void 0,
\t\t\t\t\t\t\tstatus: ev.state ?? void 0,
\t\t\t\t\t\t\ttext: priorText + deltaText
\t\t\t\t\t\t})
\t\t\t\t\t}
\t\t\t\t};
\t\t\t\tthis.blockIdx++;
\t\t\t\tthis.subagentOpened.add(ev.stepKey);
\t\t\t\tthis.sawSubagentStep = true;
\t\t\t\treturn;
\t\t\t}
\t\t\tif (ev.stepKind === "thinking") {
\t\t\t\tyield* this.ensureBlock("reasoning");
\t\t\t\tconst dbThought = this.opts.resolvedThoughts?.get(absIndex);
\t\t\t\tif (dbThought && dbThought.trim() !== "") {
\t\t\t\t\tconst delta = suffixDelta(this.emittedByKey.get(ev.stepKey) ?? "", dbThought);
\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, dbThought);
\t\t\t\t\tconst d = this.appendDelta(delta);
\t\t\t\t\tif (d) yield d;
\t\t\t\t} else {
\t\t\t\t\tconst delta = suffixDelta(this.emittedByKey.get(ev.stepKey) ?? "", ev.text);
\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, ev.text);
\t\t\t\t\tconst d = this.appendDelta(delta);
\t\t\t\t\tif (d) yield d;
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}`

// ── 执行 ────────────────────────────────────────────────────────────────────

function revertPatch() {
  if (!fs.existsSync(bakFile)) {
    console.error(`[patch] 没有备份可还原：${bakFile}`)
    process.exit(1)
  }
  fs.copyFileSync(bakFile, distFile)
  console.log('[patch] 已从备份还原 dist/index.js')
}

if (revert) {
  revertPatch()
  process.exit(0)
}

const src = fs.readFileSync(distFile, 'utf8')
const already = src.includes(MARKER)

if (checkOnly) {
  console.log(already ? '[patch] 状态：已打补丁' : '[patch] 状态：未打补丁（可以打）')
  process.exit(0)
}

if (already) {
  console.log('[patch] 已经是打过补丁的状态，跳过（幂等）')
  process.exit(0)
}

// 逐个锚点替换；任何锚点缺失都整体放弃，不留半成品。
const steps = [
  { name: 'consts (subagentOpened/sawSubagentStep)', from: OLD_CONSTS, to: NEW_CONSTS },
  { name: 'tool name constant', from: OLD_MIRROR, to: NEW_MIRROR },
  { name: 'presentMirrorCall', from: OLD_PRESENT_CALL, to: NEW_PRESENT_CALL },
  { name: 'presentMirrorResult', from: OLD_PRESENT_RESULT, to: NEW_PRESENT_RESULT },
  { name: 'streaming branch', from: OLD_BRANCH, to: NEW_BRANCH_BODY },
]

for (const step of steps) {
  if (!src.includes(step.from)) {
    console.error(`[patch] 锚点缺失：${step.name}`)
    console.error('[patch] 插件版本可能变了，未写入任何改动。')
    console.error('[patch] 需要按新版本重新定位这段代码；备份仍可用 --revert 还原。')
    process.exit(2)
  }
}

if (!fs.existsSync(bakFile)) {
  fs.copyFileSync(distFile, bakFile)
  console.log(`[patch] 备份 -> ${bakFile}`)
}

let out = src
for (const step of steps) {
  // 用 split/join 而不是 replace：替换串里可能含 $ 序列，replace 会当成捕获组引用。
  const parts = out.split(step.from)
  if (parts.length !== 2) {
    console.error(`[patch] 锚点不唯一：${step.name}（出现 ${parts.length - 1} 次）`)
    console.error('[patch] 未写入任何改动。')
    process.exit(2)
  }
  out = parts.join(step.to)
  console.log(`[patch] ✓ ${step.name}`)
}

// 先写临时文件再原子替换，避免中途失败留下半个文件。
// 临时名必须带 .mjs 后缀：node --check 按扩展名判断模块格式，
// 不认识的扩展名会直接 ERR_UNKNOWN_FILE_EXTENSION 而不是做语法检查。
const tmp = distFile + '.tmp-subagent-card.mjs'
fs.writeFileSync(tmp, out, 'utf8')
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (e) {
  fs.rmSync(tmp, { force: true })
  console.error('[patch] 语法检查失败，已放弃写入：')
  console.error(String(e.stderr ?? e.message).slice(0, 800))
  process.exit(3)
}
fs.renameSync(tmp, distFile)
console.log('[patch] 语法检查通过，已写入。')
console.log('[patch] 重启 DSH（或重载插件）后生效。回滚：node apply-agy-subagent-card.mjs --revert')
