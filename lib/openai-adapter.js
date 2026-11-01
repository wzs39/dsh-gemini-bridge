/**
 * Gemini Bridge 的 OpenAI 兼容适配器（Host 半身）。
 *
 * 职责：把 DSH 的消息/工具词表转成 OpenAI `/v1/chat/completions`，把 bridge
 * 的 SSE 流转回 DSH 的流式事件词表（block-start / text-delta / reasoning-delta /
 * tool-call-delta / block-end / usage / finish）。
 *
 * 防封要点（与 bridge 内 guard 五层互补，都在插件层落实）：
 *   1. 全部请求只打本地 bridge（127.0.0.1 回环），绝不直连 Google；
 *   2. `purpose === 'session-title'` 本地短路：会话标题不产生任何上游请求；
 *   3. 模型目录走 bridge /v1/models（5 分钟缓存），resolveModel 只读缓存，
 *      绝不逐请求探测；
 *   4. bridge 的拒绝语义原样透传：429（预算/冷却/park）与 503（账号 parked）
 *      都转成 LlmError 上抛，重试与否由 noRetry（默认 maxRetries=0）决定
 *      ——冷却窗口内不撞门是 bridge 防封体系的一部分，插件不能拆台；
 *   5. 并发闸门：同时打到 bridge 的流默认不超过 2 条。bridge 自己
 *      maxConcurrentWaiters=1，插件侧再收一道，避免 DSH 并行子代理排队
 *      超深触发 CONCURRENCY 拒绝；
 *   6. 密钥不落日志：endpoint key 只进请求头，任何日志行不带出；
 *   7. thoughtSignature 走 tool_call_id 走私（bridge 约定），插件侧对 id
 *      原样保留、原样回传，绝不清洗——清洗会拆掉 agy 通道的多轮工具链。
 *
 * @module lib/openai-adapter.js
 */

import { LlmAdapter, LlmError, attributionHeaders, offloadedImageText } from '@deepseek-ai/dsh-llm'

/** 模型目录缓存 TTL：与 DSH 其它 provider 一致，多余拉取一律不做。 */
const MODEL_CACHE_TTL_MS = 300_000

/**
 * 计数信号量：限制同时打到本地 bridge 的流数。
 * 排队期间响应 options.signal 的中止（以 ABORTED 拒绝，不留幽灵占位）。
 */
class Semaphore {
  constructor(limit) {
    this._limit = Math.max(1, limit)
    this._active = 0
    this._queue = []
  }

  /** 占一个槽位；返回释放函数。 */
  async acquire(signal) {
    if (this._active < this._limit) {
      this._active += 1
      return () => this._release()
    }
    const entry = { onAbort: undefined, resolve: undefined, reject: undefined }
    const promise = new Promise((resolve, reject) => {
      entry.resolve = () => {
        if (signal !== undefined && entry.onAbort !== undefined) signal.removeEventListener('abort', entry.onAbort)
        this._active += 1
        resolve()
      }
      entry.reject = reject
      entry.onAbort = () => {
        const at = this._queue.indexOf(entry)
        if (at >= 0) this._queue.splice(at, 1)
        reject(new LlmError('请求被调用方中止（并发排队时）', 'ABORTED'))
      }
    })
    this._queue.push(entry)
    if (signal !== undefined) {
      if (signal.aborted === true) entry.onAbort()
      else signal.addEventListener('abort', entry.onAbort, { once: true })
    }
    await promise
    return () => this._release()
  }

  _release() {
    this._active = Math.max(0, this._active - 1)
    const next = this._queue.shift()
    if (next !== undefined) next.resolve()
  }
}

/** content 既可能是字符串也可能是块数组；取全部 text 块的拼接。 */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 取最后一条有正文的用户消息（session-title 本地短路用）。 */
function lastUserText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'user') {
      const text = textOf(list[index].content).trim()
      if (text !== '') return text
    }
  }
  return ''
}

export class GeminiBridgeAdapter extends LlmAdapter {
  /**
   * @param options () => resolveOptions() 的产物（热更新容错在 index.js）
   * @param endpoint () => { baseURL, key }（读 bridge 运行配置，改端口/密钥即时生效）
   * @param resolveAttachments () => attachments 服务（图片块字节来源）
   * @param logger 结构化日志（绝不打印 apiKey / cookie）
   */
  constructor({ options, endpoint, resolveAttachments, logger }) {
    super()
    this._options = options
    this._endpoint = endpoint
    this._resolveAttachments = resolveAttachments
    this._logger = logger ?? console
    this._gate = new Semaphore(2)
    this._modelCache = undefined
    this._gateLimit = -1
    this._finishReason = undefined
  }

  /** 并发上限跟随配置（只在数值变化时重建闸门，避免丢排队状态）。 */
  _gateFor(limit) {
    if (this._gateLimit !== limit) {
      this._gate = new Semaphore(limit)
      this._gateLimit = limit
    }
    return this._gate
  }

  /**
   * 这个模型会不会真的回 functionCall？
   *
   * - agy 通道（v1internal）原生支持：请求里的 tools 会被转成
   *   `functionDeclarations`，上游回的 `functionCall` 再转回 OpenAI
   *   `tool_calls`（bridge/lib/agyconvert.mjs）。实测 finish_reason=tool_calls，
   *   参数 `{"city":"Helsinki"}` 正确。
   * - 网页通道（gemini-web）不支持：整个对话被拍平成一段 prompt 发给
   *   StreamGenerate，拿回成品文本。实测即使给了 tools 也 finish=stop、
   *   tool_calls 为空，正文自己编了个答案。
   *
   * 所以按模型名判定，而不是按「有没有传 tools」判定。判错的代价很大：
   * 给不支持工具的模型声明 tools，宿主会把 skill 与工具链挂上去，然后因为
   * 永远等不到 tool_calls 而空转或卡死——这正是「用不了 skill 和工具」的来源。
   */
  _supportsTools(model) {
    const id = typeof model === 'string' ? model : ''
    if (id === '') return false
    // 网页通道就是那一个 id（config.server.model，默认 gemini-web）。
    // 大小写不敏感：模型 id 由用户配置，写成 Gemini-Web 不该导致误判有工具。
    const webModel = this._options()?.model ?? 'gemini-web'
    const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '')
    return norm(id) !== norm(webModel) && norm(id) !== 'gemini-web'
  }

  providerInfo(provider) {
    return { id: provider, name: this._options().displayName ?? provider }
  }

  /** 防封默认：index.js 已按 noRetry 把策略压成 maxRetries=0，这里只做透传。 */
  providerRetryPolicy() {
    return this._options().retryPolicy
  }

  /** 静态清单优先；否则走 bridge 的 /v1/models（带 5 分钟缓存 + 失败静默）。 */
  async listModels(provider) {
    const config = this._options()
    const configured = Array.isArray(config.models) ? config.models : []
    if (configured.length > 0) {
      return configured.map((model) => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: [...(model.inputModalities ?? ['text'])],
      }))
    }
    if (this._modelCache !== undefined && Date.now() - this._modelCache.at < MODEL_CACHE_TTL_MS) {
      return this._modelCache.list
    }
    const { baseURL, key } = this._endpoint()
    try {
      const headers = { accept: 'application/json' }
      if (key !== '') headers.authorization = `Bearer ${key}`
      const resp = await fetch(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(8000) })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const body = await resp.json()
      const list = Array.isArray(body?.data)
        ? body.data
            .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id !== '')
            .map((entry) => ({
              provider,
              id: entry.id,
              name: typeof entry.name === 'string' && entry.name !== '' ? entry.name : entry.id,
              inputModalities: ['text'],
            }))
        : []
      this._modelCache = { at: Date.now(), list }
      return list
    } catch (error) {
      this._logger.warn?.(`gemini-bridge: 拉取模型目录失败（${error?.message ?? error}）；本轮返回空目录，不影响已配置模型`)
      return []
    }
  }

  /** 「检测模型」按钮入口：清缓存后重新拉一次。 */
  async refreshModels() {
    this._modelCache = undefined
  }

  /** 只读缓存与静态配置，绝不发起网络请求（防封：模型解析零上游流量）。 */
  async resolveModel(provider, model) {
    const config = this._options()
    const hit = this._modelCache?.list?.find((entry) => entry.id === model)
    const entry = (Array.isArray(config.models) ? config.models : []).find((item) => item.id === model)
    return {
      provider,
      id: model,
      name: hit?.name ?? entry?.name ?? model,
      inputModalities: [...(hit?.inputModalities ?? entry?.inputModalities ?? ['text'])],
      context: { contextWindow: entry?.contextWindow ?? config.defaultContextWindow },
      defaultMaxTokens: entry?.maxTokens ?? config.maxTokens,
    }
  }

  async *stream(options) {
    const config = this._options()
    // 防封②：会话标题本地生成。每个新会话省一次上游请求，标题质量无损。
    if (options.purpose === 'session-title') {
      const title = (lastUserText(options.messages) || '新会话').replace(/\s+/g, ' ').slice(0, 24)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const release = await this._gateFor(config.maxConcurrent).acquire(options.signal)
    try {
      yield* this._streamLocked(options, config)
    } finally {
      release()
    }
  }

  async *_streamLocked(options, config) {
    this._finishReason = undefined // 上一请求的 finish_reason 不允许漏进这一轮
    const { baseURL, key } = this._endpoint()

    const messages = await this._toOpenAiMessages(options)
    const body = { model: options.model, messages, stream: true, stream_options: { include_usage: true } }
    if (Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0) body.max_tokens = options.maxTokens
    if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) body.temperature = options.temperature
    const tools = (Array.isArray(options.tools) ? options.tools : [])
      .filter((tool) => tool !== null && typeof tool === 'object' && typeof tool.name === 'string' && tool.name !== '' && tool.deferLoading !== true)
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          parameters: tool.parameters !== null && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
        },
      }))
    // 只有真的会发起 functionCall 的通道才带 tools。
    //
    // 网页通道（gemini-web）拿到 tools 也不会调用：它是把整个对话发给
    // 网页端的 StreamGenerate，拿回来的是成品文本。实测一次「用 get_weather
    // 查天气」：finish=stop、tool_calls 为空、正文直接编了个天气答案，还夹带
    // 一个 http://googleusercontent.com/card_content/0 注入标记。把工具声明
    // 发过去不会让它变强，只会让模型以为自己在调工具而实际没调。
    //
    // 更糟的是：声明了 tools 的模型会被宿主当作可调用工具，于是 DSH 的 skill
    // 和工具链挂到它上面，再因为永远等不到 tool_calls 而整轮卡住/空转。
    // 所以这里必须按「这条模型到底支不支持工具」来决定，而不是无条件转发。
    if (tools.length > 0 && this._supportsTools(options.model)) body.tools = tools

    const headers = { 'content-type': 'application/json', accept: 'text/event-stream', ...attributionHeadersSafe() }
    if (key !== '') headers.authorization = `Bearer ${key}`

    // 中止链 + 空闲看门狗：options.signal 或空闲超时都会掐断 fetch，最后统一归因。
    const controller = new AbortController()
    let idleFired = false
    const onOuterAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onOuterAbort, { once: true })
    let lastData = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > config.idleTimeoutMs) {
        idleFired = true
        controller.abort()
      }
    }, 5000)

    let resp
    try {
      resp = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('请求被调用方中止', 'ABORTED')
      if (idleFired) throw new LlmError(`Gemini Bridge 连接空闲超时（${config.idleTimeoutMs}ms 无数据）`, 'TIMEOUT')
      throw new LlmError(`Gemini Bridge 连接失败（${error?.cause?.code ?? error?.message ?? error}）；请确认本地网关在跑（GET ${baseURL.replace(/\/v1$/, '')}/health）`, 'TRANSPORT')
    }

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '')
      let detail = raw
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed?.error?.message === 'string' && parsed.error.message !== '') detail = parsed.error.message
      } catch { /* 非 JSON 错误体，原样展示 */ }
      // 防封④：bridge 的 429（预算/冷却/park）与 503（账号 parked，带
      // retry-after）原样上抛；是否重试由 providerRetryPolicy 决定
      // （默认 maxRetries=0 —— 冷却窗口内不撞门）。
      const kind = resp.status === 429 || resp.status === 503 ? 'RATE_LIMITED' : 'PROVIDER'
      const retryAfter = resp.headers?.get?.('retry-after')
      const suffix = retryAfter ? `（建议 ${retryAfter}s 后重试）` : ''
      throw new LlmError(`Gemini Bridge HTTP ${resp.status}：${detail !== '' ? detail : resp.statusText}${suffix}`, kind)
    }

    // 流式状态机。
    const toolCalls = new Map()
    let textIndex = -1
    let reasoningIndex = -1
    let blockCounter = 0
    let textEmitted = ''

    const ctype = String(resp.headers?.get?.('content-type') ?? '')
    if (ctype.includes('text/event-stream') === false) {
      // bridge 的 stream:true 恒为 SSE；走到这里说明配置或版本错配。按非流式
      // chat completion 解析兜底，合成同样的事件序列。
      const raw = await resp.text().catch(() => '')
      clearInterval(watchdog)
      options.signal?.removeEventListener('abort', onOuterAbort)
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new LlmError(`Gemini Bridge 返回了非流式、非 JSON 的 200 响应（${raw.slice(0, 120)}）`, 'PROVIDER')
      }
      const message = parsed?.choices?.[0]?.message ?? {}
      const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content !== '' ? message.reasoning_content : ''
      if (reasoning !== '') {
        reasoningIndex = blockCounter
        blockCounter += 1
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
      }
      if (typeof message.content === 'string' && message.content !== '') {
        if (textIndex < 0) {
          textIndex = blockCounter
          blockCounter += 1
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textEmitted = message.content
        yield { type: 'text-delta', index: textIndex, text: message.content }
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const entry = { id: typeof call?.id === 'string' && call.id !== '' ? call.id : `call_${blockCounter}`, name: call?.function?.name ?? '', args: typeof call?.function?.arguments === 'string' ? call.function.arguments : '', ourIndex: blockCounter }
        blockCounter += 1
        toolCalls.set(entry.ourIndex, entry)
        yield { type: 'block-start', index: entry.ourIndex, blockType: 'tool-call' }
        yield { type: 'block-end', index: entry.ourIndex, block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.args } }
      }
      for (const closing of this._finishEvents({ toolCalls, textIndex, textEmitted, usage: parsed?.usage })) {
        yield closing
      }
      return
    }

    let usage = undefined
    let finishReason = undefined

    /** 一条 SSE data 行 → 0..n 个 DSH 事件（纯同步，靠数组逐个推）。 */
    const handleSseLine = (line) => {
      const events = []
      if (line === '' || line.startsWith(':')) return events
      if (line.startsWith('data:') === false) return events
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') return events
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch {
        return events
      }
      // 流中错误（bridge 在 SSE 头之后遇到上游失败时会发 error 事件）：
      // 归因上抛，绝不静默当正文。
      if (parsed?.error?.message) {
        throw new LlmError(`Gemini Bridge 流中错误：${parsed.error.message}`, 'PROVIDER')
      }
      if (parsed !== null && typeof parsed === 'object' && parsed.usage !== undefined) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
          ...(parsed.usage.prompt_tokens_details?.cached_tokens > 0
            ? { cacheReadTokens: parsed.usage.prompt_tokens_details.cached_tokens }
            : {}),
        }
      }
      for (const choice of Array.isArray(parsed?.choices) ? parsed.choices : []) {
        const delta = choice?.delta ?? {}
        const reasoning = typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
          ? delta.reasoning_content
          : (typeof delta.reasoning === 'string' && delta.reasoning !== '' ? delta.reasoning : '')
        if (reasoning !== '') {
          if (reasoningIndex < 0) {
            reasoningIndex = blockCounter
            blockCounter += 1
            events.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' })
          }
          events.push({ type: 'reasoning-delta', index: reasoningIndex, text: reasoning })
        }
        if (typeof delta.content === 'string' && delta.content !== '') {
          if (textIndex < 0) {
            textIndex = blockCounter
            blockCounter += 1
            events.push({ type: 'block-start', index: textIndex, blockType: 'text' })
          }
          textEmitted += delta.content
          events.push({ type: 'text-delta', index: textIndex, text: delta.content })
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            const upstreamIndex = Number.isFinite(call?.index) ? call.index : 0
            let entry = toolCalls.get(upstreamIndex)
            if (entry === undefined) {
              entry = { id: '', name: '', args: '', ourIndex: blockCounter }
              blockCounter += 1
              toolCalls.set(upstreamIndex, entry)
              events.push({ type: 'block-start', index: entry.ourIndex, blockType: 'tool-call' })
            }
            // 防封⑦：id 原样保留 —— agy 通道的 thoughtSignature 走私在 id
            // 里（`__thought__<sig>`），任何清洗都会拆掉多轮工具链。
            if (typeof call?.id === 'string' && call.id !== '' && entry.id === '') entry.id = call.id
            if (typeof call?.function?.name === 'string' && call.function.name !== '') {
              if (entry.name === '') entry.name = call.function.name
              else if (entry.name !== call.function.name) entry.name += call.function.name
            }
            const argumentsDelta = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
            if (argumentsDelta !== '') {
              entry.args += argumentsDelta
              events.push({
                type: 'tool-call-delta',
                index: entry.ourIndex,
                id: entry.id !== '' ? entry.id : `call-${upstreamIndex}`,
                ...(entry.name !== '' ? { name: entry.name } : {}),
                argumentsDelta,
              })
            }
          }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason !== '') {
          finishReason = choice.finish_reason
          this._finishReason = finishReason
        }
      }
      return events
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done === true) break
        lastData = Date.now()
        buffer += decoder.decode(value, { stream: true })
        let newlineAt = buffer.indexOf('\n')
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt).replace(/\r$/, '')
          buffer = buffer.slice(newlineAt + 1)
          for (const event of handleSseLine(line)) yield event
          newlineAt = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      for (const line of buffer.split('\n')) {
        for (const event of handleSseLine(line.replace(/\r$/, ''))) yield event
      }
    } catch (error) {
      if (error instanceof LlmError) throw error
      if (options.signal?.aborted === true) throw new LlmError('请求被调用方中止', 'ABORTED')
      if (idleFired === true) throw new LlmError(`Gemini Bridge 流空闲超时（${config.idleTimeoutMs}ms 无数据），本轮中止`, 'TIMEOUT')
      throw new LlmError(`Gemini Bridge 流中断（${error?.message ?? error}）`, 'TRANSPORT')
    } finally {
      clearInterval(watchdog)
      options.signal?.removeEventListener('abort', onOuterAbort)
      if (reader !== undefined) reader.cancel().catch(() => {})
    }

    for (const event of this._finishEvents({ toolCalls, textIndex, textEmitted, usage })) {
      yield event
    }
  }

  /** 收尾事件：块终结、usage 与 finish。SSE 与非流式两路共用。 */
  _finishEvents({ toolCalls, textIndex, textEmitted, usage }) {
    const events = []
    if (textIndex >= 0) {
      events.push({ type: 'block-end', index: textIndex, block: { type: 'text', text: textEmitted } })
    }
    for (const [upstreamIndex, entry] of toolCalls) {
      events.push({
        type: 'block-end',
        index: entry.ourIndex,
        block: {
          type: 'tool-call',
          id: entry.id !== '' ? entry.id : `call-${upstreamIndex}`,
          name: entry.name,
          arguments: entry.args,
        },
      })
    }
    const resolvedUsage = usage !== undefined
      ? {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          ...(usage.prompt_tokens_details?.cached_tokens > 0 ? { cacheReadTokens: usage.prompt_tokens_details.cached_tokens } : {}),
        }
      : { inputTokens: 0, outputTokens: 0 }
    events.push({ type: 'usage', usage: resolvedUsage })
    if (this._finishReason === 'length') {
      events.push({ type: 'finish', reason: { kind: 'max-tokens' } })
    } else if (this._finishReason === 'content_filter') {
      events.push({ type: 'finish', reason: { kind: 'content-filter' } })
    } else {
      events.push({ type: 'finish', reason: { kind: 'stop' } })
    }
    return events
  }

  /** DSH 消息词表 → OpenAI chat messages。 */
  async _toOpenAiMessages(options) {
    const config = this._options()
    const attachments = typeof this._resolveAttachments === 'function' ? this._resolveAttachments() : undefined
    const configured = Array.isArray(config.models) ? config.models : []
    const modality = configured.find((entry) => entry.id === options.model)?.inputModalities
      ?? this._modelCache?.list?.find((entry) => entry.id === options.model)?.inputModalities
      ?? ['text']
    const supportsImages = modality.includes('image')

    const out = []
    const systemParts = []
    if (typeof options.system === 'string' && options.system.trim() !== '') systemParts.push(options.system)
    const list = Array.isArray(options.messages) ? options.messages : []
    let index = 0
    // 开头的 system/developer 消息折进 system 提示（与 pi-ai 的 splitSystemPrompt 同语义）
    while (index < list.length && (list[index]?.role === 'system' || list[index]?.role === 'developer')) {
      const text = textOf(list[index]?.content)
      if (text.trim() !== '') systemParts.push(text)
      index += 1
    }
    if (systemParts.length > 0) out.push({ role: 'system', content: systemParts.join('\n\n') })

    for (; index < list.length; index += 1) {
      const message = list[index]
      const role = message?.role
      const content = message?.content
      if (role === 'system' || role === 'developer') {
        const text = textOf(content)
        if (text.trim() !== '') out.push({ role: 'system', content: text })
        continue
      }
      if (role === 'tool') {
        out.push({
          role: 'tool',
          tool_call_id: typeof message.toolCallId === 'string' ? message.toolCallId : '',
          content: textOf(content),
        })
        continue
      }
      if (role === 'assistant') {
        const blocks = Array.isArray(content) ? content : []
        const text = typeof content === 'string' ? content : textOf(blocks)
        const calls = blocks
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
          .map((block, position) => ({
            id: typeof block.id === 'string' && block.id !== '' ? block.id : `call_hist_${index}_${position}`,
            type: 'function',
            function: {
              name: block.name ?? '',
              arguments: typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {}),
            },
          }))
        if (calls.length > 0) out.push({ role: 'assistant', content: text !== '' ? text : null, tool_calls: calls })
        else if (text !== '') out.push({ role: 'assistant', content: text })
        continue
      }
      if (role === 'user') {
        const parts = []
        const toolResults = []
        const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : [])
        for (const block of blocks) {
          if (block === null || typeof block !== 'object') continue
          if (block.type === 'text') {
            if ((block.text ?? '') !== '') parts.push({ type: 'text', text: block.text })
            continue
          }
          if (block.type === 'image') {
            if (supportsImages === true && attachments !== undefined) parts.push(await this._imagePart(block, attachments))
            else parts.push({ type: 'text', text: block.offloaded === true ? offloadedImageText(block.attachment) : '[图片]' })
            continue
          }
          if (block.type === 'tool-result') {
            toolResults.push(block)
            continue
          }
          // reasoning / tool-call 等块不出现在用户消息里，出现则忽略
        }
        // 工具结果先于正文（OpenAI 要求 role:'tool' 紧跟对应 assistant.tool_calls）
        for (const result of toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: typeof result.toolCallId === 'string' && result.toolCallId !== ''
              ? result.toolCallId
              : (typeof result.callId === 'string' ? result.callId : ''),
            content: textOf(result.content),
          })
        }
        if (parts.length === 1 && parts[0].type === 'text') out.push({ role: 'user', content: parts[0].text })
        else if (parts.length > 1) out.push({ role: 'user', content: parts })
        else if (toolResults.length === 0) out.push({ role: 'user', content: '' })
        continue
      }
      const text = textOf(content)
      if (text !== '') out.push({ role: 'user', content: text })
    }
    return out
  }

  async _imagePart(block, attachments) {
    try {
      if (block.offloaded === true) return { type: 'text', text: offloadedImageText(block.attachment) }
      const stored = await attachments.readImage(block.attachment)
      const mediaType = stored?.ref?.mediaType ?? 'image/png'
      const base64 = Buffer.from(stored.data).toString('base64')
      return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }
    } catch (error) {
      this._logger.warn?.(`gemini-bridge: 图片附件读取失败（${error?.message ?? error}），降级为占位文本`)
      return { type: 'text', text: '[图片（读取失败）]' }
    }
  }
}

/**
 * attribution 头照 DSH 契约发给 bridge。bridge 只在本机回环消费它，不向上游
 * 透传任何 DSH 痕迹；异常时退回同值手写，契约不缺位。
 */
function attributionHeadersSafe() {
  if (typeof attributionHeaders === 'function') {
    try {
      return attributionHeaders()
    } catch {
      /* 落到兜底 */
    }
  }
  return { 'user-agent': 'deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)' }
}
