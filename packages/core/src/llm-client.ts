import { AgentKitError } from './errors.js'
import type { LlmResult, SessionMessage, ToolCall, ToolSchema } from './contracts.js'

/** 支持的 LLM 服务商协议；默认值保持 OpenAI 兼容端点的现有行为。 */
export type LlmProvider = 'openai-compatible' | 'opencode-go'

/** 流式增量回调的载荷。 */
export interface LlmDelta {
  content?: string
  reasoning?: string
  /** 由运行时注入：本次补全所属会话，供事件流按会话路由。 */
  sessionId?: string
  /** 由运行时注入：同一次补全内相同、跨次不同，前端据此分轮渲染。 */
  turnId?: string
}

/** LlmClient 配置：密钥、Base URL 与模型名来自受信任来源。 */
export interface LlmClientConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** 服务商协议；仅 opencode-go 会增加其专用会话请求头。 */
  provider?: LlmProvider
  /** 模型允许的思考强度；未配置时不向服务端发送该字段。 */
  reasoningEffort?: string
  /** 请求超时毫秒数，默认 30 秒。 */
  timeoutMs?: number
  /** 最大重试次数（0-5），默认 3。重试网络错误、5xx/429 和服务端带 trace_id 的模糊 invalid_request_error；普通 4xx 参数错误不重试。 */
  maxRetries?: number
  /**
   * 调试钩子。仅用于 verbose 排障：打印发给 LLM 的完整请求体与收到的原始响应。
   * 默认不注入。开启时会输出 Prompt 正文与模型原文 —— 这是有意为之的调试模式，
   * 生产环境不应开启。
   */
  trace?: (event: LlmTraceEvent) => void
  /**
   * 流式回调。提供时使用 stream:true 调用端点，每收到文本/reasoning 增量时回调。
   * 最终结果仍通过 complete() 返回值交付，回调仅用于实时展示。
   */
  onDelta?: (delta: LlmDelta) => void
}

/** 一次 LLM 调用的跟踪事件。 */
export interface LlmTraceEvent {
  requestId: string
  phase: 'request' | 'response' | 'error'
  /** 发给端点的 HTTP 请求体。request 阶段有值。 */
  body?: Record<string, unknown>
  /** 端点返回的原始响应。response 阶段有值。 */
  responseBody?: unknown
  durationMs: number
  error?: unknown
  /** Runtime-injected session id. */
  sessionId?: string
  /** From response.usage when available. */
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Prompt 缓存命中/未命中 token（DeepSeek prompt_cache_* 或 OpenAI cached_tokens）。 */
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/** 一次补全请求：input 为最新用户输入，messages 为会话历史，tools 为可调用工具声明。 */
export interface LlmClientRequest {
  input?: string
  context: Record<string, unknown>
  /** 发起本次补全的会话标识，由 harness 注入；运行时据此给流式回调标注会话。 */
  sessionId?: string
  /** 由宿主运行边界注入；停止会话时取消正在等待的 HTTP 请求。 */
  signal?: AbortSignal
  messages: SessionMessage[]
  systemPrompt?: string
  /** 已注册工具的 JSON Schema 声明；为空或省略时不发送 tools 字段。 */
  tools?: ToolSchema[]
  /** Core 已作出控制决策时约束模型输出为最终回答或指定工具。 */
  toolChoice?: { type: 'none' } | { type: 'tool'; toolName: string }
  /** Core 已选工具时关闭并行工具调用；省略时保持既有 Provider 默认行为。 */
  parallelToolCalls?: boolean
  /** 期望模型返回 JSON 对象；由 prompt 的输出协议声明驱动。 */
  responseFormatJson?: boolean
}

/** OpenAI Chat Completions 兼容客户端接口。 */
export interface LlmClient {
  complete(request: LlmClientRequest): Promise<LlmResult>
}

/** OpenAI 协议消息。tool 角色必须带 tool_call_id，否则真实端点返回 400。 */
type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; content: string; tool_call_id: string }

/** 统一序列化消息内容：字符串原样，其余 JSON 化。 */
function serialize(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/** 把会话消息转换为 OpenAI 协议消息。 */
function toOpenAiMessages(request: LlmClientRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = []
  if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt })
  if (Object.keys(request.context).length > 0) {
    messages.push({ role: 'system', content: `context: ${JSON.stringify(request.context)}` })
  }
  for (const message of request.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'system', content: serialize(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      const content = message.content === null || message.content === undefined ? null : serialize(message.content)
      messages.push({
        role: 'assistant',
        content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.callId,
                type: 'function' as const,
                function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
              })),
            }
          : {}),
      })
      continue
    }
    if (message.role === 'tool') {
      messages.push({ role: 'tool', content: serialize(message.content), tool_call_id: message.callId })
      continue
    }
    messages.push({ role: 'user', content: serialize(message.content) })
  }
  if (request.input) messages.push({ role: 'user', content: request.input })
  return messages
}

/** 解析单个 tool_call 条目；结构不合法时返回 null。 */
function parseToolCall(raw: unknown, index: number): ToolCall | null {
  const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
  const functionCall = call.function
  if (!functionCall || typeof functionCall.name !== 'string') return null
  let input: unknown = {}
  if (typeof functionCall.arguments === 'string' && functionCall.arguments.length > 0) {
    try {
      input = JSON.parse(functionCall.arguments)
    } catch {
      return null
    }
  }
  // 少数端点不回 id；用索引兜一个稳定值，避免多调用共用同一 callId。
  const callId = typeof call.id === 'string' && call.id.length > 0 ? call.id : `call-${index}-${Math.random().toString(36).slice(2)}`
  return { callId, toolName: functionCall.name, input }
}

/** 从 OpenAI 响应中提取最终文本或本轮全部工具调用；结构不合法时返回 null。 */
function extractResult(payload: unknown): LlmResult | null {
  if (typeof payload !== 'object' || payload === null) return null
  const record = payload as { choices?: unknown }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return null
  const message = (record.choices[0] as { message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown } } | undefined)?.message
  if (!message) return null
  // DeepSeek 等模型在 message.reasoning_content 里返回思考链，透传给 UI 展示。
  const reasoning = typeof message.reasoning_content === 'string' && message.reasoning_content.trim()
    ? message.reasoning_content
    : undefined
  const toolCalls = message.tool_calls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const calls: ToolCall[] = []
    for (const [index, raw] of toolCalls.entries()) {
      const parsed = parseToolCall(raw, index)
      if (!parsed) return null
      calls.push(parsed)
    }
    return {
      type: 'tool_calls',
      calls,
      // OpenAI 兼容接口允许同一轮同时返回 content 和 tool_calls，正文需要与调用一起透传。
      ...(typeof message.content === 'string' && message.content ? { content: message.content } : {}),
      ...(reasoning ? { reasoning } : {}),
    }
  }
  return { type: 'final', output: typeof message.content === 'string' ? message.content : '', ...(reasoning ? { reasoning } : {}) }
}

function parseUsage(payload: unknown): Pick<LlmTraceEvent, 'promptTokens' | 'completionTokens' | 'totalTokens' | 'cacheHitTokens' | 'cacheMissTokens'> {
  const result: Pick<LlmTraceEvent, 'promptTokens' | 'completionTokens' | 'totalTokens' | 'cacheHitTokens' | 'cacheMissTokens'> = {}
  if (typeof payload !== 'object' || payload === null) return result
  const usage = (payload as {
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  }).usage
  if (!usage) return result
  if (typeof usage.prompt_tokens === 'number') result.promptTokens = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') result.completionTokens = usage.completion_tokens
  if (typeof usage.total_tokens === 'number') result.totalTokens = usage.total_tokens
  // DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens
  if (typeof usage.prompt_cache_hit_tokens === 'number') result.cacheHitTokens = usage.prompt_cache_hit_tokens
  if (typeof usage.prompt_cache_miss_tokens === 'number') result.cacheMissTokens = usage.prompt_cache_miss_tokens
  // OpenAI：prompt_tokens_details.cached_tokens（命中即算缓存，其余 prompt 为未命中）
  if (typeof usage.prompt_tokens_details?.cached_tokens === 'number') {
    result.cacheHitTokens = usage.prompt_tokens_details.cached_tokens
    if (typeof usage.prompt_tokens === 'number') {
      result.cacheMissTokens = Math.max(0, usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens)
    }
  }
  return result
}

/**
 * 提取端点错误正文里的可读原因。
 *
 * OpenAI 兼容端点的错误形如 { error: { message, code, type } }，但各家不完全一致，
 * 所以逐层降级：结构化 message → code → 原始文本截断。
 * 只取错误描述，不回显整个正文 —— 那里可能带上请求回显。
 */
async function readErrorResponse(response: { status: number; text(): Promise<string> }): Promise<{ detail: string; retryableOpaque400: boolean }> {
  let raw: string
  try {
    raw = await response.text()
  } catch {
    return { detail: '', retryableOpaque400: false }
  }
  if (!raw.trim()) return { detail: '', retryableOpaque400: false }
  try {
    const payload = JSON.parse(raw) as {
      error?: { message?: unknown; code?: unknown; type?: unknown }
      message?: unknown
      code?: unknown
      type?: unknown
    }
    const nested = payload.error ?? payload
    const message = typeof nested.message === 'string' ? nested.message.trim() : ''
    const type = typeof nested.type === 'string' ? nested.type.trim() : ''
    const detail = message
      || (typeof nested.code === 'string' && nested.code.trim() ? `code=${nested.code}` : '')
      || (typeof nested.type === 'string' && nested.type.trim() ? `type=${nested.type}` : '')
      || (typeof payload.message === 'string' && payload.message.trim() ? payload.message.trim() : '')
    // 仅对服务端返回的无具体原因 trace_id 拒绝重试；其它 400 通常是稳定的请求参数错误。
    const retryableOpaque400 = response.status === 400
      && type === 'invalid_request_error'
      && /^invalid request error\s+trace_id:\s*[a-z0-9_-]+$/i.test(message)
    return { detail: detail || (raw.length > 300 ? `${raw.slice(0, 300)}…` : raw), retryableOpaque400 }
  } catch {
    // 不是 JSON，退回原始文本。
  }
  return { detail: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw, retryableOpaque400: false }
}

/** 创建 OpenAI Chat Completions 兼容 HTTP 客户端，统一错误标准化为 AgentKitError。 */
export function createLlmClient(config: LlmClientConfig): LlmClient {
  const timeoutMs = config.timeoutMs ?? 30_000
  const maxRetries = Math.max(0, Math.min(5, config.maxRetries ?? 3))
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const trace = config.trace

  return {
    async complete(request) {
      const requestId = `llm-${Math.random().toString(36).slice(2, 9)}`
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toOpenAiMessages(request),
        // 不发 tools 模型就不知道有哪些工具可调，工具调用链路整体不可达。
        ...(request.tools && request.tools.length > 0
          ? { tools: request.tools.map((tool) => ({ type: 'function', function: tool })) }
          : {}),
        // 保持旧请求体不变；仅 Core 明确授予工具或最终回答权限时发送约束字段。
        ...(request.toolChoice
          ? {
              tool_choice: request.toolChoice.type === 'none'
                ? 'none'
                : { type: 'function', function: { name: request.toolChoice.toolName } },
            }
          : {}),
        ...(request.parallelToolCalls !== undefined ? { parallel_tool_calls: request.parallelToolCalls } : {}),
        ...(request.responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
        ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        ...(config.onDelta ? { stream: true } : {}),
      }
      trace?.({ requestId, phase: 'request', body, durationMs: 0, ...(request.sessionId ? { sessionId: request.sessionId } : {}) })

      if (config.onDelta) {
        return completeStream(endpoint, config, body, requestId, trace, request, timeoutMs, maxRetries)
      }
      return completeJson(endpoint, config, body, requestId, trace, request.sessionId, request.signal, timeoutMs, maxRetries)
    },
  }
}

/** 构造所有 LLM 请求共用的 Header，避免流式与非流式路径行为不一致。 */
function buildRequestHeaders(config: LlmClientConfig, sessionId: string | undefined): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    ...(config.provider === 'opencode-go' && sessionId ? { 'x-opencode-session': sessionId } : {}),
  }
}

async function completeJson(
  endpoint: string,
  config: LlmClientConfig,
  body: Record<string, unknown>,
  requestId: string,
  trace: ((event: LlmTraceEvent) => void) | undefined,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  maxRetries: number,
): Promise<LlmResult> {
  let lastError: AgentKitError | null = null
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: buildRequestHeaders(config, sessionId),
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        trace?.({ requestId, ...(sessionId ? { sessionId } : {}), phase: 'error', durationMs: Date.now() - startedAt, error })
        lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 请求失败', { cause: error })
        if (attempt < maxRetries) continue
        throw lastError
      }
      if (!response.ok) {
        const errorResponse = await readErrorResponse(response)
        trace?.({ requestId, ...(sessionId ? { sessionId } : {}), phase: 'error', durationMs: Date.now() - startedAt, responseBody: { status: response.status, detail: errorResponse.detail } })
        lastError = new AgentKitError(
          'LLM_RESPONSE_INVALID',
          `LLM 返回 HTTP ${response.status}${errorResponse.detail ? `：${errorResponse.detail}` : ''}`,
        )
        if ((!isRetryableStatus(response.status) && !errorResponse.retryableOpaque400) || attempt >= maxRetries) throw lastError
        continue
      }
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 响应不是有效 JSON')
        if (attempt < maxRetries) continue
        throw lastError
      }
      trace?.({ requestId, ...(sessionId ? { sessionId } : {}), phase: 'response', responseBody: payload, durationMs: Date.now() - startedAt, ...parseUsage(payload) })
      const result = extractResult(payload)
      if (!result) {
        lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 响应缺少合法 choices 或 tool_calls')
        if (attempt < maxRetries) continue
        throw lastError
      }
      return result
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  throw lastError ?? new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 请求失败（重试耗尽）')
}

interface StreamAccumulator {
  content: string
  reasoning: string
  toolCalls: Map<number, { id: string; name: string; arguments: string }>
  finishReason: string | null
  /** 流式过程中遇到的 usage（末尾独立 usage chunk），用于 trace 上报。 */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

async function completeStream(
  endpoint: string,
  config: LlmClientConfig,
  body: Record<string, unknown>,
  requestId: string,
  trace: ((event: LlmTraceEvent) => void) | undefined,
  request: LlmClientRequest,
  timeoutMs: number,
  maxRetries: number,
): Promise<LlmResult> {
  const sessionId = request.sessionId
  const onDelta = config.onDelta!
  let lastError: AgentKitError | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const startedAt = Date.now()
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (request.signal?.aborted) controller.abort()
    else request.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: buildRequestHeaders(config, sessionId),
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (request.signal?.aborted) throw error
        trace?.({ requestId, ...(sessionId ? { sessionId } : {}), phase: 'error', durationMs: Date.now() - startedAt, error })
        lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 请求失败', { cause: error })
        if (attempt < maxRetries) continue
        throw lastError
      }

      if (!response.ok) {
        const errorResponse = await readErrorResponse(response)
        trace?.({ requestId, ...(sessionId ? { sessionId } : {}), phase: 'error', durationMs: Date.now() - startedAt, responseBody: { status: response.status, detail: errorResponse.detail } })
        lastError = new AgentKitError('LLM_RESPONSE_INVALID', `LLM 返回 HTTP ${response.status}${errorResponse.detail ? `：${errorResponse.detail}` : ''}`)
        if ((!isRetryableStatus(response.status) && !errorResponse.retryableOpaque400) || attempt >= maxRetries) throw lastError
        continue
      }

      // 端点可能忽略 stream:true 返回普通 JSON（某些代理或不支持流式的端点），
      // 或测试 mock 不提供 body/headers。检测 content-type 做 fallback。
      const contentType = response.headers?.get?.('content-type') ?? ''
      if (!contentType.includes('text/event-stream')) {
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          // response.json() 不可用（例如 mock 没提供），尝试读 text 再解析。
          try {
            const text = await (response as { text(): Promise<string> }).text()
            payload = JSON.parse(text)
          } catch {
            lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 响应不是有效 JSON 也不是 SSE 流')
            if (attempt < maxRetries) continue
            throw lastError
          }
        }
        trace?.({ requestId, ...(sessionId ? { sessionId } : {}), phase: 'response', responseBody: payload, durationMs: Date.now() - startedAt, ...parseUsage(payload) })
        const result = extractResult(payload)
        if (!result) {
          lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 响应缺少合法 choices 或 tool_calls')
          if (attempt < maxRetries) continue
          throw lastError
        }
        if (result.type === 'final' && typeof result.output === 'string') {
          onDelta({ content: result.output, ...(result.reasoning ? { reasoning: result.reasoning } : {}) })
        }
        return result
      }

      if (!response.body) {
        lastError = new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 流式响应没有 body')
        if (attempt < maxRetries) continue
        throw lastError
      }

      const acc: StreamAccumulator = { content: '', reasoning: '', toolCalls: new Map(), finishReason: null }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamEnded = false

      try {
        while (!streamEnded) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const data = trimmed.slice(5).trim()
            if (data === '[DONE]') {
              // [DONE] 是 SSE 协议的响应终止标记；不能依赖上游随后主动关闭连接。
              streamEnded = true
              break
            }
            let chunk: unknown
            try {
              chunk = JSON.parse(data)
            } catch {
              continue
            }
            processStreamChunk(chunk as StreamChunk, acc, onDelta)
          }
        }
      } finally {
        reader.releaseLock()
      }

      trace?.({
        requestId,
        ...(sessionId ? { sessionId } : {}),
        phase: 'response',
        responseBody: { content_length: acc.content.length, tool_calls: acc.toolCalls.size, finish_reason: acc.finishReason },
        durationMs: Date.now() - startedAt,
        // 流式路径的 usage 以末尾独立 chunk 到达，须单独解析并随 trace 上报。
        ...parseUsage({ usage: acc.usage }),
      })

      return assembleStreamResult(acc)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', abort)
    }
  }
  throw lastError ?? new AgentKitError('LLM_RESPONSE_INVALID', 'LLM 请求失败（重试耗尽）')
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      /** OpenCode Go 在流式响应中使用的思考文本字段。 */
      reasoning?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  /** 流式末尾的独立 usage chunk（无 choices）。 */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

function processStreamChunk(
  chunk: StreamChunk,
  acc: StreamAccumulator,
  onDelta: (delta: { content?: string; reasoning?: string }) => void,
): void {
  // usage 以末尾独立 chunk 到达，先于 choices 判断捕获，避免被 early return 跳过。
  if (chunk.usage) {
    acc.usage = chunk.usage
  }
  const choice = chunk.choices?.[0]
  if (!choice) return
  if (choice.finish_reason) acc.finishReason = choice.finish_reason

  const delta = choice.delta
  if (!delta) return

  if (delta.reasoning_content) {
    acc.reasoning += delta.reasoning_content
    onDelta({ reasoning: delta.reasoning_content })
  }
  if (delta.reasoning) {
    acc.reasoning += delta.reasoning
    onDelta({ reasoning: delta.reasoning })
  }
  if (delta.content) {
    acc.content += delta.content
    onDelta({ content: delta.content })
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const existing = acc.toolCalls.get(tc.index) ?? { id: '', name: '', arguments: '' }
      if (tc.id) existing.id = tc.id
      if (tc.function?.name) existing.name = tc.function.name
      if (tc.function?.arguments) existing.arguments += tc.function.arguments
      acc.toolCalls.set(tc.index, existing)
    }
  }
}

function assembleStreamResult(acc: StreamAccumulator): LlmResult {
  if (acc.toolCalls.size > 0) {
    const calls: ToolCall[] = []
    for (const [index, tc] of acc.toolCalls) {
      let input: unknown = {}
      if (tc.arguments.trim()) {
        try {
          input = JSON.parse(tc.arguments)
        } catch {
          input = {}
        }
      }
      calls.push({ callId: tc.id || `call-${index}`, toolName: tc.name, input })
    }
    return {
      type: 'tool_calls',
      calls,
      // 流式响应中可能先产生正文再产生工具调用，保留已累计的正文供历史恢复。
      ...(acc.content ? { content: acc.content } : {}),
      ...(acc.reasoning ? { reasoning: acc.reasoning } : {}),
    }
  }
  return {
    type: 'final',
    output: acc.content,
    ...(acc.reasoning ? { reasoning: acc.reasoning } : {}),
  }
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true
  return status >= 500 || status === 429
}
