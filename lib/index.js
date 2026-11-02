/**
 * dsh-gemini-bridge — 插件入口（Host 半身）。
 *
 * 把 Gemini 双通道反代网关（bridge/，自带 OpenAI 兼容端点）接进 DeepSeek
 * Harness：
 *   1. 进程托管：DSH 启动时自动拉起 `node <bridgeDir>/bin/serve.mjs`（已有健康
 *      实例则复用，不重复占端口）；异常退出按上限自动重启（1 小时最多 5 次）；
 *      插件停用即杀。就绪探测打 bridge 的 /health。
 *   2. 运行数据外置：bridge 的可写状态（logs / state.json / 浏览器 profile）
 *      全部落在 ~/.dsh/gemini-bridge/（经 GEMINI_BRIDGE_DATA 注入）——npm 安装
 *      进 node_modules 是只读目录，bridge 写自己目录必崩。运行配置首次从
 *      bridge/config.example.json 生成到 ~/.dsh/gemini-bridge/config.json，
 *      插件更新永不覆盖手工改动。
 *   3. 浏览器路径自动发现：seed 时若 browser.executable 为空，按常见
 *      Chrome/Edge 路径探测并写入；探测不到则日志提示手填（不反复弹窗）。
 *   4. 模型接入：注册 provider `gemini-bridge`，模型目录默认经 bridge
 *      /v1/models 自动发现（缓存 5 分钟，零逐请求轮询）：网页通道
 *      gemini-web + agy 通道全家（claude-sonnet-4-6 等）。
 *   5. 防封（插件层，与 bridge 内 guard 层互补）：session-title 本地短路、
 *      冷却期不重试（noRetry 默认开）、并发闸门、密钥/cookie 永不落日志、
 *      usage 路由仅回环。
 *
 * 人工登录不进插件生命周期：网页通道要求用户跑一次
 * `node <bridgeDir>/bin/login.mjs --account <name>` 完成 Google 登录（可见
 * 浏览器交互）。serve 因此可能以"无可用通道"退出：插件记日志、按重启上限
 * 退避，用户在 usage 卡片看到 signed-out 与登录指引即可。
 *
 * 依赖只有 harness 自带的 peer 包，没有第三方运行时依赖。
 *
 * @module index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'

import { GeminiBridgeAdapter } from './openai-adapter.js'
import { scanBrain, readConversation, readConversationFile, resolveConversationFile, defaultAccountsRoot } from './agy-brain.js'

/** raw 路由的 MIME 表：决定浏览器怎么渲染（内嵌阅读器 / 图片解码）。 */
const RAW_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
}

export const name = 'dsh-gemini-bridge'

export const inject = ['llm']

/** 插件包目录（lib/ 的上一级）。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

/** 运行数据目录：bridge 的 config.json / logs / profiles 都落这里，插件更新不覆盖。 */
const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), '.dsh', 'gemini-bridge')

const MODEL_MODALITIES = ['text', 'image']

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1),
})

/**
 * 默认模型目录（harness 目录格式：id/name/contextWindow/maxTokens/inputModalities
 * 全量声明）。留空列表会让「检测模型」依赖 bridge 在线发现——bridge 尚未就绪或
 * 通道降级时目录为空，宿主按空目录报错。静态清单兜底，agy 通道凭据缺失时多余
 * 行在调用时才失败，不影响其余模型。
 */
const DEFAULT_MODELS = [
  { id: 'gemini-web', name: 'Gemini 网页端（跟随账号当前模式）', contextWindow: 1000000, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'gemini-web-flash-lite', name: 'Gemini 3.5 Flash-Lite（网页）', contextWindow: 1000000, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'gemini-web-flash', name: 'Gemini 3.8 Flash（网页）', contextWindow: 1000000, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'gemini-web-pro', name: 'Gemini 3.1 Pro（网页）', contextWindow: 1000000, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'gemini-web-argon', name: 'Gemini 4 Argon（网页）', contextWindow: 1000000, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash Medium（agy）', contextWindow: 1000000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash High（agy）', contextWindow: 1000000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash Low（agy）', contextWindow: 1000000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash（agy）', contextWindow: 1000000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro（agy，需账号验证）', contextWindow: 1000000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6（agy）', contextWindow: 200000, maxTokens: 32768, inputModalities: ['text'] },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking（agy）', contextWindow: 200000, maxTokens: 32768, inputModalities: ['text'] },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B（agy）', contextWindow: 131072, maxTokens: 16384, inputModalities: ['text'] },
]

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关掉后不注册模型提供方、不拉起 bridge 进程'),
  provider: z.string().default('gemini-bridge').description('提供方路由 id（模型选择器里的分组键）'),
  displayName: z.string().default('Gemini 双通道反代（本地防封）').description('提供方显示名'),
  nodePath: z.string().default('node').description('Node 22+ 可执行文件（bridge 无第三方依赖，无需 npm install）'),
  bridgeDir: z.string().default('').description('bridge 目录（含 bin/serve.mjs）；留空 = 插件自带的 bridge/'),
  configPath: z.string().default('').description('bridge 运行配置路径；留空 = ~/.dsh/gemini-bridge/config.json'),
  autoStart: z.boolean().default(true).description('插件加载时自动拉起本地 bridge（检测到健康实例则复用）'),
  autoRestart: z.boolean().default(true).description('bridge 进程异常退出后自动重启（一小时最多 5 次，防崩溃循环）'),
  startTimeoutMs: z.number().step(1).min(3000).default(60000).description('等待 bridge /health 就绪的超时（毫秒；bridge 要拉起浏览器，给足时间）'),
  noRetry: z.boolean().default(true).description('防封默认：不自动重试（冷却/限流/park 期间避免撞门）；关掉后按 retryPolicy 重试'),
  retryPolicy: RetryPolicySchema,
  models: z.array(catalogModel).default(DEFAULT_MODELS).description('默认模型目录（harness 格式全量声明）；清空 = 通过 bridge /v1/models 自动发现（bridge 离线时目录为空会报错，建议保留默认）'),
  maxConcurrent: z.number().step(1).min(1).max(4).default(2).description('同时打到本地 bridge 的最大流数（防封：把并行请求收成近人节奏）'),
  defaultContextWindow: z.number().step(1).min(1).default(1000000).description('未在静态清单里声明 contextWindow 时的默认值'),
  maxTokens: z.number().step(1).min(1).default(32768).description('默认 max_tokens'),
  idleTimeoutMs: z.number().step(1).min(15000).default(300000).description('流空闲超时：连续无数据多少毫秒后掐断（毫秒）'),
})

/** 校验并规范化静态模型清单。 */
function resolveModels(models) {
  const seen = new Set()
  return (Array.isArray(models) ? models : []).map((model) => {
    if (typeof model.id !== 'string' || model.id === '') throw new Error('gemini-bridge: 模型 id 不能为空')
    if (seen.has(model.id)) throw new Error(`gemini-bridge: 模型 "${model.id}" 重复`)
    seen.add(model.id)
    const inputModalities = Array.isArray(model.inputModalities) && model.inputModalities.length > 0 ? model.inputModalities : ['text']
    return {
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      contextWindow: model.contextWindow ?? undefined,
      maxTokens: model.maxTokens ?? undefined,
      inputModalities: [...inputModalities],
    }
  })
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** 把 Config 解析成运行期只读配置；非法值抛错（apply 侧保留上一份可用配置）。 */
export function resolveOptions(config) {
  const noRetry = config.noRetry !== false
  return {
    enabled: config.enabled !== false,
    provider: (typeof config.provider === 'string' && config.provider.trim() !== '') ? config.provider.trim() : 'gemini-bridge',
    displayName: (typeof config.displayName === 'string' && config.displayName.trim() !== '') ? config.displayName.trim() : 'Gemini 双通道反代（本地防封）',
    nodePath: (typeof config.nodePath === 'string' && config.nodePath.trim() !== '') ? config.nodePath.trim() : 'node',
    bridgeDir: (typeof config.bridgeDir === 'string' ? config.bridgeDir.trim() : ''),
    configPath: (typeof config.configPath === 'string' ? config.configPath.trim() : ''),
    autoStart: config.autoStart !== false,
    autoRestart: config.autoRestart !== false,
    startTimeoutMs: config.startTimeoutMs ?? 60000,
    noRetry,
    // 防封默认压成 0 次重试；用户显式关掉 noRetry 才按自己的 retryPolicy 来
    retryPolicy: noRetry === true
      ? resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'gemini-bridge: retryPolicy')
      : resolveRetryPolicy(config.retryPolicy, 'gemini-bridge: retryPolicy'),
    models: resolveModels(config.models),
    maxConcurrent: clampInt(config.maxConcurrent, 1, 4, 2),
    defaultContextWindow: config.defaultContextWindow ?? 1000000,
    maxTokens: config.maxTokens ?? 32768,
    idleTimeoutMs: config.idleTimeoutMs ?? 300000,
  }
}

function readRuntimeConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** 从 bridge 运行配置解析端点与密钥（每次现读，用户改配置即时生效）。 */
function endpointOf(options) {
  const configPath = options().configPath !== '' ? options().configPath : path.join(DEFAULT_RUNTIME_DIR, 'config.json')
  const bridge = readRuntimeConfig(configPath)
  const host = String(bridge?.server?.host ?? '127.0.0.1')
  const port = String(bridge?.server?.port ?? 18901)
  const key = String(bridge?.server?.apiKey ?? '')
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  return { baseURL: `http://${loopback ? '127.0.0.1' : host}:${port}/v1`, key, configPath }
}

/**
 * 浏览器可执行文件自动发现（seed 时用；只探测存在性，不起进程）。
 * 路径全部用正斜杠写法构造，Windows 一样认。
 */
function detectBrowser() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'D:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'D:/Program Files/Microsoft/Edge/Application/msedge.exe',
    path.join(localAppData, 'Chromium', 'chrome.exe'),
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch { /* 无效路径直接跳过 */ }
  }
  return null
}

// ── apply ─────────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  // 配置热更新容错：一次非法改动不打挂正在跑的插件，保留上一份可用配置。
  let current = () => config
  let lastRaw
  let lastGood
  const options = () => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      logger.error?.('gemini-bridge: 配置非法，继续使用上一份可用配置')
      logger.error?.(error)
      return lastGood
    }
  }
  options()

  const entryNs = ctx.fiber?.entry?.options?.id ?? name
  let stopping = false
  let child = undefined
  let restartTimestamps = []

  const bridgeDirOf = () => {
    const configured = options().bridgeDir
    return configured !== '' ? configured : path.join(PLUGIN_DIR, 'bridge')
  }
  const configPathOf = () => {
    const configured = options().configPath
    return configured !== '' ? configured : path.join(DEFAULT_RUNTIME_DIR, 'config.json')
  }

  /**
   * 首次生成运行配置：模板来自插件 bridge/config.example.json，绝不覆盖已有
   * 手工配置。browser.executable 为空时顺手填入自动发现的浏览器路径。
   */
  function seedRuntimeConfig() {
    const configPath = configPathOf()
    if (fs.existsSync(configPath)) return configPath
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      const example = path.join(bridgeDirOf(), 'config.example.json')
      if (!fs.existsSync(example)) throw new Error(`模板缺失：${example}`)
      const seeded = JSON.parse(fs.readFileSync(example, 'utf8'))
      const detected = detectBrowser()
      if (detected && (seeded.browser?.executable === null || seeded.browser?.executable === '')) {
        seeded.browser = { ...seeded.browser, executable: detected }
        logger.info?.(`gemini-bridge: 已自动发现浏览器 ${detected} 并写入运行配置`)
      } else if (!detected) {
        logger.warn?.('gemini-bridge: 未自动找到 Chrome/Edge，请在运行配置 browser.executable 填写浏览器可执行文件完整路径')
      }
      fs.writeFileSync(configPath, JSON.stringify(seeded, null, 2))
      logger.info?.(`gemini-bridge: 已生成运行配置 ${configPath}（账号列表在 accounts 段；人工登录见 README）`)
    } catch (error) {
      logger.warn?.(`gemini-bridge: 运行配置生成失败（${error?.message ?? error}）`)
    }
    return configPath
  }

  async function healthy(base) {
    try {
      const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })
      // bridge 的 /health 任何 JSON 应答都证明进程活着且通道自知状态。
      return resp.ok === true
    } catch {
      return false
    }
  }

  /** bridge 日志文件句柄（5MB 轮转一次，只留一代 .old）。 */
  function openLog() {
    const dir = path.join(path.dirname(configPathOf()), 'logs')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch { /* 目录已存在 */ }
    const logPath = path.join(dir, 'bridge.log')
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > 5 * 1024 * 1024) {
        try {
          fs.rmSync(`${logPath}.old`, { force: true })
        } catch { /* 无旧文件 */ }
        fs.renameSync(logPath, `${logPath}.old`)
      }
    } catch { /* 文件还不存在 */ }
    return fs.openSync(logPath, 'a')
  }

  function scheduleRestart() {
    const config = options()
    if (stopping === true || config.autoStart !== true || config.autoRestart !== true) return
    const now = Date.now()
    restartTimestamps = restartTimestamps.filter((at) => now - at < 3_600_000)
    if (restartTimestamps.length >= 5) {
      logger.warn?.('gemini-bridge: 一小时内已自动重启 5 次，停止重启；排查见插件 logs 目录下 bridge.log')
      return
    }
    restartTimestamps.push(now)
    setTimeout(() => {
      if (stopping === false) void ensureBridge().catch((error) => logger.warn?.(`gemini-bridge: 自动重启失败（${error?.message ?? error}）`))
    }, 5000)
  }

  /** 拉起（或复用）本地 bridge 进程；就绪探测不阻塞 apply。 */
  async function ensureBridge() {
    const config = options()
    if (config.autoStart !== true || stopping === true) return
    if (child !== undefined) return
    const endpoint = endpointOf(options)
    const base = endpoint.baseURL.replace(/\/v1$/, '')
    // 已有健康实例（用户手动起的、或上一次 DSH 会话残留）→ 复用，不重复占端口
    if (await healthy(base)) {
      logger.info?.(`gemini-bridge: 本地网关已在运行，直接复用 ${base}`)
      return
    }
    const bridgeDir = bridgeDirOf()
    const serveMjs = path.join(bridgeDir, 'bin', 'serve.mjs')
    if (fs.existsSync(serveMjs) === false) {
      logger.warn?.(`gemini-bridge: 找不到 ${serveMjs}，进程未拉起（可用 bridgeDir 配置指定目录）`)
      return
    }
    const configPath = seedRuntimeConfig()
    const dataDir = path.dirname(configPath)
    const out = openLog()
    let proc
    try {
      proc = spawn(config.nodePath, [serveMjs], {
        cwd: bridgeDir,
        // 运行配置与全部可写状态外置到数据目录：node_modules 里的安装是只读的。
        env: {
          ...process.env,
          GEMINI_BRIDGE_CONFIG: configPath,
          GEMINI_BRIDGE_DATA: dataDir,
        },
        stdio: ['ignore', out, out],
        windowsHide: true,
      })
    } catch (error) {
      logger.warn?.(`gemini-bridge: bridge 进程拉起失败（${error?.message ?? error}）；确认 nodePath 指向 Node 22+`)
      try { fs.closeSync?.(out) } catch { /* 已关闭 */ }
      return
    }
    child = proc
    proc.on('error', (error) => {
      logger.warn?.(`gemini-bridge: bridge 进程异常（${error?.message ?? error}）`)
    })
    proc.on('exit', (code, signalName) => {
      if (child === proc) child = undefined
      try {
        fs.closeSync?.(out)
      } catch { /* 已关闭 */ }
      const hint = code === 1 ? '（可能没有任何通道可用：网页账号未人工登录且无 agy 凭据。跑一次 node bridge/bin/login.mjs --account <name> 后等待自动重启或重启 DSH）' : ''
      logger.info?.(`gemini-bridge: bridge 进程退出（code=${code ?? '?'} signal=${signalName ?? '?'}）${hint}，详见 bridge.log`)
      scheduleRestart()
    })
    const deadline = Date.now() + config.startTimeoutMs
    while (Date.now() < deadline) {
      if (await healthy(base)) {
        logger.info?.(`gemini-bridge: 本地网关就绪 ${base}（pid=${proc.pid ?? '?'}）`)
        return
      }
      if (child === undefined) {
        logger.warn?.('gemini-bridge: bridge 进程在就绪前退出，排查见 bridge.log')
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (child !== undefined) {
      logger.warn?.(`gemini-bridge: 等待网关就绪超时（${config.startTimeoutMs}ms），进程仍在后台启动中`)
    }
  }

  // ── 模型提供方 ──────────────────────────────────────────────────────────────
  const adapter = new GeminiBridgeAdapter({
    options,
    endpoint: () => endpointOf(options),
    resolveAttachments: () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined),
    logger,
  })

  ctx.effect(() => () => {
    stopping = true
    try {
      child?.kill()
    } catch { /* 进程已退出 */ }
  }, 'gemini-bridge: bridge 进程')

  if (options().enabled) {
    const providerId = options().provider
    ctx.llm.registerConfigurableProviders?.([{
      provider: providerId,
      displayName: options().displayName,
      settingsNs: entryNs,
      settingsPath: [],
    }])
    ctx.llm.registerAdapter([providerId], adapter)
    // 「检测模型」按钮：清缓存重新拉一次目录（用户显式动作才打 /v1/models）
    ctx.llm.registerModelDiscovery?.(entryNs, async () => {
      await adapter.refreshModels()
      const config = options()
      const list = await adapter.listModels(providerId)
      return list.map((model) => {
        const entry = (config.models ?? []).find((item) => item.id === model.id)
        return {
          id: model.id,
          name: model.name,
          contextWindow: entry?.contextWindow ?? config.defaultContextWindow,
          maxTokens: entry?.maxTokens ?? config.maxTokens,
          inputModalities: model.inputModalities,
        }
      })
    })
    const staticCount = (options().models ?? []).length
    logger.info?.(`gemini-bridge: provider "${providerId}" 已注册（本地双通道网关），模型目录=${staticCount > 0 ? `静态 ${staticCount} 条` : '自动发现（经网关缓存）'}`)
  } else {
    logger.info?.('gemini-bridge: enabled=false，模型提供方未注册')
  }

  // ── Usage 路由（供客户端 half 轮询通道/账号状态）──────────────────────────
  // 路径 /plugins/dsh-gemini-bridge/usage 转发到 bridge 的 /health；本地
  // 补充 agy 池视角（bridge 自己的 /health 已带 pool.accounts，这里不重复加工）
  function isLoopbackReq(req) {
    const addr = req.socket?.localAddress ?? ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '0.0.0.0'
  }
  function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        const disposer = webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-gemini-bridge/usage',
          handler: async (req, res) => {
            if (!isLoopbackReq(req)) {
              sendJson(res, 403, { error: 'host-not-trusted' })
              return
            }
            try {
              // endpointOf 收的是 options **函数**（它内部自己再调一次以支持热更新）。
              // 传 options() 的结果会变成 `options is not a function` —— 这条路由
              // 因此一直 502，客户端卡片显示「网关未运行」。
              const endpoint = endpointOf(options)
              const base = endpoint.baseURL.replace(/\/v1$/, '')
              const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(8000) })
              const body = await resp.text()
              res.writeHead(resp.status, { 'content-type': 'application/json' })
              res.end(body)
            } catch (error) {
              sendJson(res, 502, { error: `usage fetch failed: ${error?.message ?? error}` })
            }
          },
        })
        return disposer
      }, 'gemini-bridge: usage route')
    })
  }

  // ── agy brain 浏览路由 ────────────────────────────────────────────────────
  // agy CLI 把会话痕迹写在自己的 brain 目录，DSH 会话里看不到。这三条路由
  // 把那些内容以只读方式暴露给客户端卡片：
  //   GET /plugins/dsh-gemini-bridge/agy/brain             全部会话索引
  //   GET /plugins/dsh-gemini-bridge/agy/brain/conv?account=&id=   单个会话详情
  //   GET /plugins/dsh-gemini-bridge/agy/brain/file?account=&id=&path=  产物内容
  // **只读**：agy-link 维护着这些目录的凭据与 pool 状态，第二个写入者会和它
  // 打架（bridge 消费 pool.json 时遵守同一条规矩）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      // 账号根目录固定在 ~/.dsh/agy-accounts（与 agy-link、bridge 的 poolFile
      // 默认位置一致），不随 runtimeDir 变——那是 bridge 的可写目录，不是 agy 的。
      webCtx.effect(() => {
        const disposer = webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-gemini-bridge/agy/brain',
          handler: async (req, res) => {
            if (!isLoopbackReq(req)) return sendJson(res, 403, { error: 'host-not-trusted' })
            try {
              const data = scanBrain({ root: defaultAccountsRoot() })
              sendJson(res, 200, data)
            } catch (error) {
              sendJson(res, 500, { error: `brain scan failed: ${error?.message ?? error}` })
            }
          },
        })
        return disposer
      }, 'gemini-bridge: agy brain index')

      webCtx.effect(() => {
        const disposer = webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-gemini-bridge/agy/brain/conv',
          handler: async (req, res) => {
            if (!isLoopbackReq(req)) return sendJson(res, 403, { error: 'host-not-trusted' })
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const account = url.searchParams.get('account') ?? ''
              const id = url.searchParams.get('id') ?? ''
              const data = readConversation(account, id, { root: defaultAccountsRoot() })
              sendJson(res, 200, data)
            } catch (error) {
              sendJson(res, 404, { error: `${error?.message ?? error}` })
            }
          },
        })
        return disposer
      }, 'gemini-bridge: agy brain detail')

      webCtx.effect(() => {
        const disposer = webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-gemini-bridge/agy/brain/file',
          handler: async (req, res) => {
            if (!isLoopbackReq(req)) return sendJson(res, 403, { error: 'host-not-trusted' })
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const account = url.searchParams.get('account') ?? ''
              const id = url.searchParams.get('id') ?? ''
              const rel = url.searchParams.get('path') ?? ''
              const data = readConversationFile(account, id, rel, { root: defaultAccountsRoot() })
              sendJson(res, 200, data)
            } catch (error) {
              sendJson(res, 404, { error: `${error?.message ?? error}` })
            }
          },
        })
        return disposer
      }, 'gemini-bridge: agy brain file')

      // 原始字节：图片 <img src>、PDF <iframe src> 直接用这个。
      //
      // 为什么不能只靠上面那条 JSON 路由：
      //   - PDF 1.4 MB base64 化成 ~1.9 MB 塞进 JSON，面板要等整块解析完才动；
      //   - <iframe src="data:application/pdf"> 在 Chrome 里被禁止，data URL
      //     顶层导航只能到顶层文档，所以 PDF 必须有一个真 URL 才能内嵌。
      // 越权检查走的是同一个 resolveConversationFile，不允许另写一份。
      webCtx.effect(() => {
        const disposer = webCtx.webServer.register({
          kind: 'exact',
          path: '/plugins/dsh-gemini-bridge/agy/brain/raw',
          handler: async (req, res) => {
            if (!isLoopbackReq(req)) {
              res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
              res.end('host-not-trusted')
              return
            }
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1')
              const account = url.searchParams.get('account') ?? ''
              const id = url.searchParams.get('id') ?? ''
              const rel = url.searchParams.get('path') ?? ''
              const { real, st } = resolveConversationFile(account, id, rel, { root: defaultAccountsRoot() })
              const ext = path.extname(real).toLowerCase()
              res.writeHead(200, {
                'content-type': RAW_MIME[ext] ?? 'application/octet-stream',
                'content-length': String(st.size),
                'cache-control': 'no-store',
                // 内联显示（不是下载），并禁止一切脚本/插件能力：这里回的是
                // 用户机器上 agy 写出来的文件，不该在 DSH 源里执行任何东西。
                'content-disposition': 'inline',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
              })
              fs.createReadStream(real).pipe(res)
            } catch (error) {
              res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
              res.end(`${error?.message ?? error}`)
            }
          },
        })
        return disposer
      }, 'gemini-bridge: agy brain raw')
    })
  }

  // 进程托管不阻塞插件加载：模型调用若早于网关就绪，适配器会给出明确的
  // TRANSPORT 错误，重试与否由 noRetry（默认不重试）决定。
  void ensureBridge().catch((error) => logger.warn?.(`gemini-bridge: 启动流程异常（${error?.message ?? error}）`))

  logger.info?.(`gemini-bridge: 已加载，provider="${options().provider}"，防封默认：noRetry=${options().noRetry} maxConcurrent=${options().maxConcurrent}`)
}

export { GeminiBridgeAdapter }
export default { name, inject, Config, apply }
