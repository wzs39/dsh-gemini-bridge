#!/usr/bin/env node
/**
 * apply-agy-subagent-label.mjs — 让 dsh-agy-link 的子代理内容在 DSH 里可辨认
 *
 * 背景（踩过的坑，务必先读）
 * --------------------------
 * dsh-agy-link 把 subagent 步骤（stepKind === "subagent"）拼进 reasoning 块，
 * 内容是 "[agy subagent] ..." 的纯文本。曾尝试把它改成 tool-call 块，让它像
 * agy_tool 一样渲染成卡片 —— 那是错的，会**导致主会话直接结束**：
 *
 *   1. DSH 只支持三种块类型：text / reasoning / tool-call
 *      （dsh-llm/lib/types/assembler.js 的 switch 只有这三种）
 *   2. tool-call 块必然进入执行队列 —— DSH 会尝试执行它
 *   3. 但 parseMirrorCallId() 只认 "agytc-" 前缀，合成的
 *      "agy-subagent-…" 无法解析成可执行调用
 *   4. 于是 DSH 收到一个「看起来要执行、实际执行不了」的调用，
 *      随后流以 reason: { kind: "stop" } 收尾
 *   5. 结果：主会话认为模型说完了 → 会话结束，子代理的结果永远回不来
 *
 * 正确做法：留在 reasoning 块里，只改进**可辨认性**。子代理的思考过程本来
 * 就属于 reasoning 的语义范畴；用统一的前缀标记（含 role/状态/序号），让
 * 用户在折叠的思考区里也能一眼分清「这是子代理在干活」而不是主模型在思考。
 *
 * 用法：
 *   node apply-agy-subagent-label.mjs           # 应用
 *   node apply-agy-subagent-label.mjs --check   # 只检查
 *   node apply-agy-subagent-label.mjs --revert  # 从备份还原
 *   node apply-agy-subagent-label.mjs --path <dir>
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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
  out.push(path.join(os.homedir(), '.dsh', 'plugins', 'dsh-agy-link'))
  return out
}

const targetDir = candidateDirs().find(d => fs.existsSync(path.join(d, 'dist', 'index.js')))
if (!targetDir) {
  console.error('[label] 找不到 dsh-agy-link/dist/index.js。用 --path 指定。')
  process.exit(1)
}

const distFile = path.join(targetDir, 'dist', 'index.js')
const bakFile = path.join(targetDir, 'dist', 'index.js.bak-subagent-label')

console.log(`[label] target: ${distFile}`)

const MARKER = 'AGY_SUBAGENT_LABEL'

// 原始形态：子代理和 thinking 共用 reasoning 块，子代理只加一个固定前缀。
const OLD = `\t\t\t\t} else {
\t\t\t\t\tconst prev = this.emittedByKey.get(ev.stepKey) ?? "";
\t\t\t\t\tconst deltaText = suffixDelta(prev, ev.text);
\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, ev.text);
\t\t\t\t\tconst banner = prev === "" ? "[agy subagent] " : "";
\t\t\t\t\tconst d = this.appendDelta(banner + deltaText);
\t\t\t\t\tif (d) yield d;
\t\t\t\t}`

// 打完后的形态：首帧带结构化的多行抬头，后续帧带缩进续行标记。
// 保持 reasoning 块语义 —— 不产生任何 tool-call，因此不会触发执行队列。
const NEW = `\t\t\t\t} else {
\t\t\t\t\tconst prev = this.emittedByKey.get(ev.stepKey) ?? "";
\t\t\t\t\tconst deltaText = suffixDelta(prev, ev.text);
\t\t\t\t\tthis.emittedByKey.set(ev.stepKey, ev.text);
\t\t\t\t\t// ${MARKER}：子代理内容留在 reasoning 块内（DSH 只有 text /
\t\t\t\t\t// reasoning / tool-call 三种块，tool-call 会进执行队列，而合成的
\t\t\t\t\t// 调用解析不出 run 坐标 → 主会话会把它当「说完」直接结束）。
\t\t\t\t\t// 这里只提升可辨认度：首帧给结构抬头，后续帧给缩进标记。
\t\t\t\t\tconst firstFrame = prev === "";
\t\t\t\t\tconst role = typeof ev.subagentRole === "string" && ev.subagentRole !== "" ? ev.subagentRole : "";
\t\t\t\t\tconst stateText = typeof ev.state === "string" && ev.state !== "" ? ev.state : "";
\t\t\t\t\tconst meta = [role, stateText].filter(Boolean).join(" · ");
\t\t\t\t\tconst banner = firstFrame
\t\t\t\t\t\t? "── agy subagent" + (meta ? " (" + meta + ")" : "") + " ──\\n"
\t\t\t\t\t\t: "   ";
\t\t\t\t\tconst d = this.appendDelta(banner + deltaText);
\t\t\t\t\tif (d) yield d;
\t\t\t\t}`

if (revert) {
  if (!fs.existsSync(bakFile)) {
    console.error(`[label] 没有备份：${bakFile}`)
    process.exit(1)
  }
  fs.copyFileSync(bakFile, distFile)
  console.log('[label] 已从备份还原')
  process.exit(0)
}

const src = fs.readFileSync(distFile, 'utf8')

if (checkOnly) {
  console.log(src.includes(MARKER) ? '[label] 状态：已应用' : '[label] 状态：未应用（可以打）')
  process.exit(0)
}

if (src.includes(MARKER)) {
  console.log('[label] 已经应用过，跳过（幂等）')
  process.exit(0)
}

if (!src.includes(OLD)) {
  console.error('[label] 锚点缺失：插件版本可能变了，未写入任何改动。')
  process.exit(2)
}

const parts = src.split(OLD)
if (parts.length !== 2) {
  console.error(`[label] 锚点不唯一（出现 ${parts.length - 1} 次），未写入。`)
  process.exit(2)
}

if (!fs.existsSync(bakFile)) {
  fs.copyFileSync(distFile, bakFile)
  console.log(`[label] 备份 -> ${bakFile}`)
}

const out = parts.join(NEW)
const tmp = distFile + '.tmp-subagent-label.mjs'
fs.writeFileSync(tmp, out, 'utf8')
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
} catch (e) {
  fs.rmSync(tmp, { force: true })
  console.error('[label] 语法检查失败，已放弃写入：')
  console.error(String(e.stderr ?? e.message).slice(0, 600))
  process.exit(3)
}
fs.renameSync(tmp, distFile)
console.log('[label] 语法检查通过，已写入。重启 DSH 后生效。')
