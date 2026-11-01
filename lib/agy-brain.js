/**
 * agy brain 目录只读索引。
 *
 * 问题：agy（Antigravity CLI）把每次会话的全部痕迹写在自己的 brain 目录里，
 * 而不是 DSH 会话里。于是用户在 DSH 里看不到：
 *
 *   - agy 写的产物文件（方案、报告）——落在 <conv>/<conv-id>/ 下
 *   - 完整对话记录（含 thinking、tool_calls、token 统计）
 *   - 每次工具调用的原始输出（output.txt）
 *   - 子代理会话、任务日志、附件（media）
 *
 * 实测规模：2 个账号 / 13 个会话 / 211 个文件 / 7.1 MB —— 全部对用户不可见。
 *
 * 本模块只做三件事：发现、解析、归纳。**绝不写 agy 的任何文件**：
 * agy-link 自己维护凭据槽与 pool 状态，第二个写入者会和它打架
 * （bridge 消费 pool.json 时遵守同一条规矩）。
 *
 * 目录布局（实测）：
 *
 *   ~/.dsh/agy-accounts/<accId>/.gemini/antigravity-cli/brain/<convId>/
 *     <convId>/                    产物目录，文件名由模型决定（optimization-plan.md）
 *     logs/transcript_full.jsonl   完整对话（USER_INPUT / PLANNER_RESPONSE / GENERIC）
 *     logs/transcript.jsonl        精简对话
 *     messages/*.json              消息体
 *     subagents/*.json             子代理会话
 *     tasks/task-*.log             任务日志
 *     media/*.pdf                  附件
 *     transcript/ 与 transcript_full/   分片转录 JSONL
 *     <step>/output.txt            工具输出（按 step 序号分目录）
 *
 * @module agy-brain
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 单个文件读入上限：避免把一个 2.8 MB 的 PDF 或超大 jsonl 塞进内存。 */
const MAX_READ_BYTES = 2 * 1024 * 1024

/** 列表里最多携带多少条记录（超出用截断标记，不让 UI 收到巨型 JSON）。 */
const LIST_LIMIT = 500

/** agy 账号根目录：与 bridge/agytoken.mjs 的 poolFile 默认位置一致。 */
export function defaultAccountsRoot() {
  return path.join(os.homedir(), '.dsh', 'agy-accounts')
}

function safeStat(p) {
  try { return fs.statSync(p) } catch { return null }
}

function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] }
}

/** 递归列出文件，跳过符号链接，避免怪异的环。 */
function walkFiles(dir, base = dir, out = [], depth = 0) {
  if (depth > 6) return out
  for (const ent of safeReaddir(dir)) {
    if (ent.isSymbolicLink()) continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkFiles(full, base, out, depth + 1)
    else if (ent.isFile()) {
      const st = safeStat(full)
      if (!st) continue
      out.push({
        rel: path.relative(base, full).split(path.sep).join('/'),
        name: ent.name,
        size: st.size,
        mtime: st.mtimeMs,
      })
    }
  }
  return out
}

/**
 * 把文件按「agy 的语义类别」归类，UI 才能分组而不是丢一坨文件名。
 *
 * 真实相对路径一律以 `.system_generated/` 开头（实测）：
 *
 *   .system_generated/logs/transcript_full.jsonl   完整对话
 *   .system_generated/logs/chunks/transcript/...   分片转录
 *   .system_generated/steps/<n>/output.txt         工具输出
 *   .system_generated/messages/*.json              消息体
 *   .system_generated/subagents/*.json             子代理会话
 *   .system_generated/tasks/task-*.log             任务日志
 *   optimization-plan.md                           模型写的产物（会话根目录，文件名自定）
 *
 * 所以判定要先剥掉 `.system_generated` 前缀，再按「第几段」分类。
 * 剩下不在任何已知目录下的，才是模型自己生产的文件——那是最需要展示的一类。
 */
export function classifyFile(rel, convId = '') {
  const parts = rel.split('/')
  // 剥掉 agy 的内部前缀
  const isInternal = parts[0] === '.system_generated'
  const rest = isInternal ? parts.slice(1) : parts
  const top = rest[0]
  const name = rest[rest.length - 1]

  if (isInternal) {
    if (top === 'logs') {
      if (rest.includes('chunks')) return 'transcript-shard'
      if (name.startsWith('transcript')) return 'transcript'
      return 'log'
    }
    if (top === 'steps') return name === 'output.txt' ? 'tool-output' : 'step-file'
    if (top === 'messages') return 'message'
    if (top === 'subagents') return 'subagent'
    if (top === 'tasks') return 'task'
    if (top === 'media') return 'media'
  }

  // 不在 .system_generated 下 → 会话根目录里的东西。
  // 实测模型会把产物写进一个以会话 id 命名的子目录
  // （<conv>/<convId>/optimization-plan.md），也有直接放根目录的情况。
  // 这两种都是「模型写的产物」，是用户最需要看到的那一类。
  if (!isInternal) {
    const inOwnSubdir = parts.length > 1 && parts[0] === convId
    if (inOwnSubdir) return 'artifact'
    if (parts.length === 1 && /\.(md|txt|json|html|csv|yaml|yml|log|js|ts|py|sh|ps1)$/i.test(name)) return 'artifact'
  }

  // 剩下的：agy 未来版本可能引入的新目录/新格式。
  // 不按扩展名硬猜，统一标 unknown 让 UI 单列——宁可朴素，不能藏起来。
  return 'unknown'
}

/**
 * 解析 transcript_full.jsonl 的行。
 *
 * 实测字段：step_index / source / type / status / created_at / content /
 * thinking / tool_calls / input_tokens / output_tokens / cache_read_tokens。
 * type 取值：USER_INPUT / PLANNER_RESPONSE / GENERIC / SYSTEM_MESSAGE。
 *
 * 行可能被截断（写盘过程中读取），逐行 try 而不是整文件 JSON.parse。
 */
export function parseTranscript(text) {
  const records = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let rec
    try { rec = JSON.parse(t) } catch { continue }
    records.push({
      step: rec.step_index ?? records.length,
      type: rec.type ?? 'UNKNOWN',
      source: rec.source ?? '',
      status: rec.status ?? '',
      at: rec.created_at ?? '',
      content: typeof rec.content === 'string' ? rec.content : '',
      thinking: typeof rec.thinking === 'string' ? rec.thinking : '',
      toolCalls: Array.isArray(rec.tool_calls) ? rec.tool_calls : [],
      tokens: {
        input: rec.input_tokens ?? 0,
        output: rec.output_tokens ?? 0,
        cacheRead: rec.cache_read_tokens ?? 0,
      },
    })
  }
  return records
}

/** 从对话里提取第一句用户请求，作为这个会话的标题。 */
function titleOf(records) {
  for (const r of records) {
    if (r.type !== 'USER_INPUT' || !r.content) continue

    // content 里带 <USER_REQUEST> 包裹和一堆元数据标签，只取请求正文。
    let raw = r.content
    const m = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/)
    if (m) raw = m[1]

    // agy 会把「历史背景 + 当前请求」拼成一段，当前请求用方括号标出。
    // 优先取 [CURRENT REQUEST ...] 之后的正文，不是这行提示本身。
    const cur = raw.match(/\[CURRENT REQUEST[^\]]*\]([\s\S]*)$/)
    if (cur) raw = cur[1]

    // 去掉其余 XML 风格标签块，避免整段元数据当标题
    raw = raw.replace(/<[A-Z_]+>[\s\S]*?<\/[A-Z_]+>/g, ' ')
    raw = raw.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, ' ')

    const firstLine = raw.split('\n').map(s => s.trim()).filter(Boolean)[0] ?? ''
    if (firstLine) return firstLine.slice(0, 160)
  }
  return ''
}

/** 会话时间范围与 token 合计。 */
function summarize(records) {
  let tokens = { input: 0, output: 0, cacheRead: 0 }
  let models = new Set()
  let first = ''
  let last = ''
  for (const r of records) {
    tokens.input += r.tokens.input
    tokens.output += r.tokens.output
    tokens.cacheRead += r.tokens.cacheRead
    if (r.at) {
      if (!first || r.at < first) first = r.at
      if (!last || r.at > last) last = r.at
    }
    for (const tc of r.toolCalls) {
      const m = tc?.model ?? tc?.model_name
      if (typeof m === 'string') models.add(m)
    }
  }
  return { tokens, models: [...models], firstAt: first, lastAt: last, steps: records.length }
}

/**
 * 扫描全部账号的全部会话。
 *
 * @param {{root?: string}} [opts]
 * @returns {{accounts: object[], conversations: object[], totals: object}}
 */
export function scanBrain(opts = {}) {
  const root = opts.root ?? defaultAccountsRoot()
  const accounts = []
  const conversations = []

  for (const acc of safeReaddir(root)) {
    if (!acc.isDirectory()) continue
    const accDir = path.join(root, acc.name)
    const brainDir = path.join(accDir, '.gemini', 'antigravity-cli', 'brain')
    if (!safeStat(brainDir)?.isDirectory()) continue

    const accConvs = []
    for (const conv of safeReaddir(brainDir)) {
      if (!conv.isDirectory()) continue
      const convDir = path.join(brainDir, conv.name)
      const files = walkFiles(convDir)

      // transcript_full 优先；没有就退回 transcript。
      // 路径带 .system_generated 前缀，用后缀匹配而不是全等。
      const pickTranscript = (files) =>
        files.find(f => f.rel.endsWith('logs/transcript_full.jsonl') && !f.rel.includes('/chunks/'))
        ?? files.find(f => f.rel.endsWith('logs/transcript.jsonl') && !f.rel.includes('/chunks/'))
        ?? null

      const full = pickTranscript(files)
      let records = []
      if (full) {
        const fullPath = path.join(convDir, full.rel)
        const st = safeStat(fullPath)
        if (st && st.size <= MAX_READ_BYTES) {
          try { records = parseTranscript(fs.readFileSync(fullPath, 'utf8')) } catch { /* 读不到就当空 */ }
        }
      }

      const byKind = {}
      for (const f of files) {
        const k = classifyFile(f.rel, conv.name)
        ;(byKind[k] ??= []).push(f)
      }

      const artifacts = (byKind.artifact ?? []).map(f => ({
        rel: f.rel,
        name: f.name,
        size: f.size,
        mtime: f.mtime,
      })).sort((a, b) => b.mtime - a.mtime)

      const sum = summarize(records)
      const entry = {
        account: acc.name,
        id: conv.name,
        dir: convDir,
        title: titleOf(records),
        artifacts,
        fileCount: files.length,
        bytes: files.reduce((n, f) => n + f.size, 0),
        kinds: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])),
        toolOutputs: (byKind['tool-output'] ?? []).length,
        subagents: (byKind.subagent ?? []).length,
        media: (byKind.media ?? []).length,
        ...sum,
      }
      accConvs.push(entry)
      conversations.push(entry)
    }

    const accFiles = accConvs.reduce((n, c) => n + c.fileCount, 0)
    accounts.push({
      id: acc.name,
      dir: accDir,
      conversations: accConvs.length,
      files: accFiles,
      bytes: accConvs.reduce((n, c) => n + c.bytes, 0),
      artifacts: accConvs.reduce((n, c) => n + c.artifacts.length, 0),
    })
  }

  conversations.sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''))

  const totals = {
    accounts: accounts.length,
    conversations: conversations.length,
    files: conversations.reduce((n, c) => n + c.fileCount, 0),
    bytes: conversations.reduce((n, c) => n + c.bytes, 0),
    artifacts: conversations.reduce((n, c) => n + c.artifacts.length, 0),
    toolOutputs: conversations.reduce((n, c) => n + c.toolOutputs, 0),
    subagents: conversations.reduce((n, c) => n + c.subagents, 0),
    media: conversations.reduce((n, c) => n + c.media, 0),
    tokens: conversations.reduce((acc, c) => ({
      input: acc.input + c.tokens.input,
      output: acc.output + c.tokens.output,
      cacheRead: acc.cacheRead + c.tokens.cacheRead,
    }), { input: 0, output: 0, cacheRead: 0 }),
    truncated: conversations.length > LIST_LIMIT,
  }

  return {
    root,
    scannedAt: new Date().toISOString(),
    accounts,
    conversations: conversations.slice(0, LIST_LIMIT),
    totals,
  }
}

/**
 * 读取单个会话的详情：完整对话 + 全部文件清单。
 *
 * @param {string} account 账号目录名
 * @param {string} convId  会话 id
 * @param {{root?: string}} [opts]
 */
export function readConversation(account, convId, opts = {}) {
  const root = opts.root ?? defaultAccountsRoot()
  // 目录名来自 URL，必须挡住 ../ 穿越
  if (!/^[A-Za-z0-9._-]+$/.test(account) || !/^[A-Za-z0-9._-]+$/.test(convId)) {
    throw new Error('invalid account or conversation id')
  }
  const convDir = path.join(root, account, '.gemini', 'antigravity-cli', 'brain', convId)
  if (!safeStat(convDir)?.isDirectory()) throw new Error('conversation not found')

  const files = walkFiles(convDir)
  const full = files.find(f => f.rel.endsWith('logs/transcript_full.jsonl') && !f.rel.includes('/chunks/'))
    ?? files.find(f => f.rel.endsWith('logs/transcript.jsonl') && !f.rel.includes('/chunks/'))
    ?? null
  let records = []
  if (full) {
    const p = path.join(convDir, full.rel)
    const st = safeStat(p)
    if (st && st.size <= MAX_READ_BYTES) {
      try { records = parseTranscript(fs.readFileSync(p, 'utf8')) } catch { /* 空 */ }
    }
  }

  return {
    account,
    id: convId,
    dir: convDir,
    title: titleOf(records),
    summary: summarize(records),
    messages: records.map(r => ({
      step: r.step,
      type: r.type,
      status: r.status,
      at: r.at,
      content: r.content,
      thinking: r.thinking,
      toolCalls: r.toolCalls.map(tc => ({
        name: tc?.name ?? tc?.tool ?? tc?.function?.name ?? '',
        args: tc?.args ?? tc?.arguments ?? null,
      })),
      tokens: r.tokens,
    })),
    files: files
      .map(f => ({ ...f, kind: classifyFile(f.rel, convId) }))
      .sort((a, b) => b.mtime - a.mtime),
  }
}

/**
 * 读取会话内一个具体文件的内容（产物预览）。
 * 只允许会话目录内的相对路径；二进制或超大文件给出说明而不是硬塞。
 */
export function readConversationFile(account, convId, rel, opts = {}) {
  const root = opts.root ?? defaultAccountsRoot()
  if (!/^[A-Za-z0-9._-]+$/.test(account) || !/^[A-Za-z0-9._-]+$/.test(convId)) {
    throw new Error('invalid account or conversation id')
  }
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('..') || rel.startsWith('/')) {
    throw new Error('invalid file path')
  }
  const convDir = path.join(root, account, '.gemini', 'antigravity-cli', 'brain', convId)
  const target = path.join(convDir, rel.split('/').join(path.sep))
  // 解析后仍须落在会话目录内（防符号链接/软链逃逸）
  const real = fs.realpathSync(target)
  const realBase = fs.realpathSync(convDir)
  if (!real.startsWith(realBase + path.sep) && real !== realBase) throw new Error('path escapes conversation')

  const st = safeStat(real)
  if (!st || !st.isFile()) throw new Error('file not found')

  const ext = path.extname(real).toLowerCase()
  const binary = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.gz', '.bin', '.mp4']
  if (binary.includes(ext)) {
    return { path: rel, size: st.size, mtime: st.mtimeMs, binary: true, content: '', note: `二进制文件（${ext}），不在浏览器里渲染` }
  }
  if (st.size > MAX_READ_BYTES) {
    return { path: rel, size: st.size, mtime: st.mtimeMs, binary: false, content: '', note: `文件过大（${Math.round(st.size / 1024)} KB），已跳过` }
  }
  return {
    path: rel,
    size: st.size,
    mtime: st.mtimeMs,
    binary: false,
    content: fs.readFileSync(real, 'utf8'),
    note: '',
  }
}
