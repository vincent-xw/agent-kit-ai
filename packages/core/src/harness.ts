import type { z } from 'zod'

import { AgentKitError } from './errors.js'
import { toToolSchemas } from './json-schema.js'
import type {
  AuditLogger,
  HarnessToolExecutionRequest,
  HarnessNotice,
  HarnessResult,
  LlmResult,
  PendingCall,
  PendingCallStore,
  SessionMessage,
  SessionStore,
  ToolCall,
  ToolDefinition,
} from './contracts.js'
import type { ContextManager } from './context-manager.js'
import type { LlmClient, LlmClientRequest } from './llm-client.js'
import type { PromptRegistry } from './prompt-registry.js'

import type { ToolRegistry } from './tool-registry.js'

/**
 * 模型把工具调用语法当正文输出时的标记（DeepSeek/GLM 的 DSML 或通用 XML 工具语法）。
 *
 * provider 只把它当普通内容返回，没有结构化 tool_calls；这类文本一旦当作最终答复或
 * 收口说明落库，用户看到的就是原始标记而不是解释。判定要求同时出现 invoke 名与结束标签，
 * 避免把正文里正常讨论 `<invoke>` 的文本误判。
 */
export function looksLikeToolCallMarkup(output: unknown): boolean {
  if (typeof output !== 'string') return false
  if (/｜｜\s*DSML\s*｜｜/.test(output)) return true
  if (!/\binvoke\s+name\s*=/i.test(output)) return false
  return /<\s*tool_calls/i.test(output) || /<\/\s*(invoke|tool_calls|parameter)\s*>/i.test(output)
}

/** 工具调用标记泄漏的纠正重试上限：只补一次，避免把偶发抽风放大成连续消耗。 */
const MAX_TOOL_MARKUP_RETRIES = 1

/** harness 依赖：LLM 客户端、会话存储、工具注册表与可选的提示词/审计/上下文/挂起存储。 */
export interface AgentHarnessDependencies {
  llm: LlmClient
  sessions: SessionStore
  tools: ToolRegistry
  maxSteps: number
  prompts?: PromptRegistry
  audit?: AuditLogger
  /** 上下文管理器：提供历史裁剪。未注入时发送完整历史。 */
  context?: ContextManager
  /** 挂起调用存储。未注入时使用进程内实现（进程重启即丢）。 */
  pendingCalls?: PendingCallStore
  /** 所有符合条件的 Harness Control Flow Decision 默认使用的 Provider。 */
  controlFlowDecisionProvider?: ControlFlowDecisionProvider
  /** 服务端工具的默认执行超时毫秒数，默认 30 秒。 */
  toolTimeoutMs?: number
}

/** Core 对控制流决策的 Provider-neutral 结果，不包含模型或业务场景概念。 */
export type ControlFlowDecision =
  | { type: 'finish' }
  | { type: 'call_tool'; toolName: string }

/** 单次 Core 控制流决策的安全输入；不包含 Prompt、History、工具参数或结果。 */
export interface ControlFlowDecisionInput {
  decisionId: string
  sessionId: string
  /** 宿主建立的当前 Harness Run Scope；缺失时 Provider 应按 State ineligible 处理。 */
  runInstanceId?: string
  availableToolNames: readonly string[]
  signal?: AbortSignal
}

/** Core 控制流决策接口；Provider 不可用时返回 null，由 Harness 按既有路径继续。 */
export interface ControlFlowDecisionProvider {
  decide(input: ControlFlowDecisionInput): Promise<ControlFlowDecision | null>
}

/** 最大步数受限的 模型 -> 工具调用 -> 工具结果 -> 模型 循环。 */
export interface AgentHarness {
  run(request: {
    sessionId: string
    input: string
    context: Record<string, unknown>
    /** BFF 提供的当前 Run Scope 身份，供默认决策 Provider 读取安全 State。 */
    runInstanceId?: string
    /** 可信 Harness 调用可覆盖默认 Provider；显式 null 关闭本次调用的 Provider。 */
    controlFlowDecisionProvider?: ControlFlowDecisionProvider | null
    /** 由宿主运行边界注入，用于取消正在等待的模型请求。 */
    signal?: AbortSignal
    /** 指定使用哪个已注册提示词；省略时用默认（首个注册）提示词。 */
    promptName?: string
    /** 跳过工具声明：不发 tools 字段，模型只能输出文本。用于计划阶段。 */
    skipTools?: boolean
    /** 请求级工具白名单；传入空数组表示本次请求不允许调用任何工具。 */
    allowedToolNames?: string[]
    /** 请求级步数预算；正整数收紧宿主上限，0 表示不设步数上限（仍受超时和取消控制）。 */
    maxSteps?: number
    /** 可选的宿主执行桥；用于 Workflow Agent Task 接管本地 Tool 的能力边界。 */
    toolExecution?: { execute(request: HarnessToolExecutionRequest): Promise<unknown> }
    /** 分步模式：每执行完一轮 server 工具即返回 step_done，由调用方推进。 */
    stepMode?: boolean
    /**
     * 收口补全（让模型写失败说明）自身失败时使用的兜底输出。
     * 声明了输出协议的调用方（例如 Workflow Agent Task）传入协议合法的失败结论，
     * 避免模型写不出说明时整个任务退化成协议错误。
     */
    failureFallback?: unknown
  }): Promise<HarnessResult>
  /** 回填远端 Tool Host 执行结果并继续循环。 */
  resume(request: {
    sessionId: string
    callId: string
    output: unknown
    /** 继续远端工具所在的同一 Run Scope。 */
    runInstanceId?: string
    /** 可信 Harness 调用可覆盖默认 Provider；显式 null 关闭本次调用的 Provider。 */
    controlFlowDecisionProvider?: ControlFlowDecisionProvider | null
    signal?: AbortSignal
    /** 同 run：收口补全失败时的兜底输出。 */
    failureFallback?: unknown
  }): Promise<HarnessResult>
  /**
   * 分步模式下推进下一步。不要求 callId（区别于 resume）。
   * input 可选：提供时作为中途注入的用户消息（steering）。
   */
  continue(request: {
    sessionId: string
    context?: Record<string, unknown>
    input?: string
    /** 继续当前 stepMode Run Scope。 */
    runInstanceId?: string
    /** 可信 Harness 调用可覆盖默认 Provider；显式 null 关闭本次调用的 Provider。 */
    controlFlowDecisionProvider?: ControlFlowDecisionProvider | null
    promptName?: string
    /** 与首轮 run 保持一致的请求级工具白名单。 */
    allowedToolNames?: string[]
    signal?: AbortSignal
    /** 同 run：收口补全失败时的兜底输出。 */
    failureFallback?: unknown
  }): Promise<HarnessResult>
}

/** 校验 Zod Schema，失败时统一抛出带稳定错误码的 AgentKitError。 */
function parseWithCode(schema: z.ZodType, value: unknown, code: 'TOOL_INPUT_INVALID' | 'TOOL_OUTPUT_INVALID'): unknown {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new AgentKitError(code, '工具数据校验失败')
  return parsed.data
}

/** 宿主执行桥可能使用普通 Error 携带稳定 code；不能只依赖 AgentKitError 的 instanceof。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

/** 进程内挂起调用存储；宿主可注入持久化实现替换。 */
function createMemoryPendingCallStore(): PendingCallStore {
  const calls = new Map<string, PendingCall>()
  return {
    get: (callId) => calls.get(callId),
    set: (callId, call) => void calls.set(callId, call),
    delete: (callId) => void calls.delete(callId),
  }
}

/** 只在当前 Harness 请求内过滤可见工具，不改动全局注册表或其他并发会话。 */
function toolsAllowedForRequest(tools: ToolDefinition[], allowedToolNames?: string[]): ToolDefinition[] {
  if (allowedToolNames === undefined) return tools
  const allowed = new Set(allowedToolNames)
  return tools.filter((tool) => allowed.has(tool.name))
}

/**
 * 在超时约束下执行服务端工具。
 * 没有超时的话，一个挂住的工具会永久挂住整个 harness 循环——调用方连失败都收不到。
 */
async function executeWithTimeout(
  tool: ToolDefinition,
  input: unknown,
  timeoutMs: number,
  sessionId: string,
  callId: string,
  parentSignal?: AbortSignal,
  executeOverride?: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> {
  if (!tool.execute && !executeOverride) throw new AgentKitError('TOOL_EXECUTOR_MISSING', `服务端工具缺少执行器：${tool.name}`)
  const controller = new AbortController()
  let removeParentAbortListener: (() => void) | undefined
  let rejectAbort!: (reason?: unknown) => void
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject })
  const onParentAbort = () => {
    controller.abort(parentSignal?.reason)
    rejectAbort(new AgentKitError('TOOL_EXECUTION_ABORTED', `工具执行已取消：${tool.name}`))
  }
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort()
    else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true })
      removeParentAbortListener = () => parentSignal.removeEventListener('abort', onParentAbort)
    }
  }
  let timedOut = false
  let timeoutError: AgentKitError | undefined
  let rejectTimeout!: (reason?: unknown) => void
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
  // Promise 可能忽略 AbortSignal，因此除了发出取消信号，还必须让 Harness 自身竞争一个硬超时。
  const timer = timeoutMs === 0 ? undefined : setTimeout(() => {
      timedOut = true
      controller.abort()
      timeoutError = new AgentKitError('TOOL_EXECUTION_TIMEOUT', `工具执行超时：${tool.name}`)
      rejectTimeout(timeoutError)
    }, timeoutMs)
  try {
    const execution = Promise.resolve().then(() => executeOverride
      ? executeOverride(controller.signal)
      : tool.execute!(input, { signal: controller.signal, sessionId, callId }))
    // timeoutMs=0 只关闭硬超时，不关闭父级取消；ask_user 等工具仍必须响应停止操作。
    return await Promise.race(timeoutMs === 0
      ? [execution, abortPromise]
      : [execution, timeoutPromise, abortPromise])
  } catch (error) {
    if (timedOut) {
      throw timeoutError ?? new AgentKitError('TOOL_EXECUTION_TIMEOUT', `工具执行超时：${tool.name}`, { cause: error })
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    removeParentAbortListener?.()
  }
}

/** 执行模型与工具循环；有限请求受步数约束，maxSteps=0 时由超时/取消作为边界。 */
export function createAgentHarness(deps: AgentHarnessDependencies): AgentHarness {
  const pendingCalls = deps.pendingCalls ?? createMemoryPendingCallStore()
  const toolTimeoutMs = deps.toolTimeoutMs ?? 30_000

  /**
   * 按名解析提示词；未指定名称时回退到默认（首个注册）提示词。
   * 之前这里死取 getDefault()，导致第二个注册的提示词及其输出协议永远无法生效。
   */
  function resolvePrompt(promptName?: string) {
    if (!deps.prompts) return undefined
    if (!promptName) return deps.prompts.getDefault()
    const found = deps.prompts.getByName(promptName)
    if (!found) throw new AgentKitError('PROMPT_NOT_FOUND', `提示词未注册：${promptName}`)
    return found
  }

  /**
   * 应用上下文裁剪，并把裁剪摘要作为 system 消息前置。
   * 不注入摘要的话模型不知道自己丢了上下文——它会以为看到的就是完整历史。
   */
  async function trimHistory(sessionId: string, history: SessionMessage[]): Promise<SessionMessage[]> {
    if (!deps.context) return history
    await deps.context.save(sessionId, history)
    const trimmed = await deps.context.load(sessionId)
    const summary = await deps.context.getSummary(sessionId)
    if (!summary) return trimmed
    // TokenContextManager 把摘要放进请求 projection；已存在时不再重复注入同一段摘要。
    if (trimmed.some((message) => message.role === 'system'
      && typeof message.content === 'string'
      && message.content === `Earlier conversation summary: ${summary}`)) return trimmed
    return [{ role: 'system', content: summary }, ...trimmed]
  }

  /**
   * 统计自最近一条用户消息/同工具成功结果以来，该工具指定错误码的连续失败次数。
   * stepMode 每次 continue 都会重新进入 runLoop，因此失败次数必须从持久化历史推导，不能只放局部变量。
   */
  function recentToolFailureCount(history: SessionMessage[], toolName: string, codes: string[]): number {
    let count = 0
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const message = history[i]!
      if (message.role === 'user') break
      if (message.role !== 'tool' || message.toolName !== toolName) continue
      const content = message.content as { code?: unknown } | null
      if (typeof content?.code === 'string' && codes.includes(content.code)) count += 1
      else break
    }
    return count
  }

  /** 校验模型最终输出是否符合 prompt 声明的输出协议。 */
  function applyOutputProtocol(output: unknown, promptName?: string): unknown {
    const protocol = resolvePrompt(promptName)?.protocol
    if (!protocol) return output
    // 声明了 JSON 协议时模型返回的是 JSON 文本，先解析再校验。
    let candidate = output
    if (typeof output === 'string') {
      try {
        candidate = JSON.parse(output)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new AgentKitError('LLM_OUTPUT_PROTOCOL_INVALID', `模型输出不是有效 JSON，不符合已声明的输出协议：${reason}`)
      }
    }
    const parsed = protocol.safeParse(candidate)
    if (!parsed.success) {
      // 保留 Zod 的字段路径和约束信息，避免 Workflow 运行日志只能显示无法定位的泛化错误。
      const details = parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '根对象'
        return `${path}：${issue.message}`
      }).join('；')
      throw new AgentKitError('LLM_OUTPUT_PROTOCOL_INVALID', `模型输出不符合已声明的输出协议：${details}`)
    }
    return parsed.data
  }

  /**
   * 最终输出收口：先按声明协议校验，失败时再要一次纯 JSON。
   *
   * 模型在带工具的轮次里偶尔会用自然语言收尾（真机样本：拿到 ask_user 的回答后直接写说明，
   * 整段不是 JSON）。Workflow Agent Task 把协议违规当作不可重试的致命错误，一次口误就会
   * 丢掉整轮结果并终止整个 Run；这里补一次不含工具的补正机会，仍不合法才抛出原错误。
   */
  async function finalizeProtocolOutput(options: {
    requestId: string
    sessionId: string
    context: Record<string, unknown>
    history: SessionMessage[]
    promptName?: string
    output: unknown
    reasoning?: string
    signal?: AbortSignal
  }): Promise<unknown> {
    const prompt = resolvePrompt(options.promptName)
    // 纯 Chat（无输出协议）下，模型把工具调用当正文输出时不能作为最终答复落库：
    // 否则用户看到的是原始 DSML/XML 标记，而不是解释或下一步建议。
    if (!prompt?.protocol && looksLikeToolCallMarkup(options.output)) {
      const markupFallback = '本轮模型返回了无法解析的工具调用格式，已停止执行；你可以直接发消息让我重试刚才的步骤。'
      options.history.push({ role: 'assistant', content: markupFallback, createdAt: new Date().toISOString() })
      await deps.sessions.save(options.sessionId, options.history)
      await deps.audit?.log({
        requestId: options.requestId,
        sessionId: options.sessionId,
        durationMs: 0,
        errorCode: 'LLM_TOOL_CALL_MARKUP_IN_OUTPUT',
      })
      return markupFallback
    }
    let parsed: unknown
    try {
      parsed = applyOutputProtocol(options.output, options.promptName)
    } catch (error) {
      if (!(error instanceof AgentKitError) || error.code !== 'LLM_OUTPUT_PROTOCOL_INVALID'
        || !prompt?.protocol || options.signal?.aborted) throw error
      // 这段不合协议的输出必须先留在会话里，模型才看得到自己写错了什么。
      options.history.push({ role: 'assistant', content: options.output, createdAt: new Date().toISOString() })
      // 只补一次，所以必须把「具体哪里不合法」原样告诉模型。真机样本：第一次补正只说
      // 「不符合协议」，模型第二次仍然漏掉同一个必填字段（error：Required），整轮 Run 照样失败。
      // applyOutputProtocol 抛出的 message 已经带了 Zod 的字段路径与约束，直接复用它。
      const instruction = [
        '你刚才的输出不符合本次任务的 JSON 输出协议。校验器给出的具体问题：',
        error.message,
        '',
        '请针对上面列出的问题修正，只输出符合该协议的完整 JSON：不要解释、不要输出 Markdown 代码围栏、不要复述原文、不要调用任何工具。',
      ].join('\n')
      const repaired = await deps.llm.complete({
        context: { ...options.context, outputProtocolRepair: true },
        sessionId: options.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        messages: await trimHistory(options.sessionId, options.history),
        systemPrompt: [prompt.prompt, instruction].filter((part) => part.length > 0).join('\n\n'),
        // 补正就是「只要一段 JSON」的场景：没有工具、没有后续步骤，正是 JSON 模式最该开的时候。
        // 主路径只在无工具时才开，补正原先漏了这一个开关，模型可能再吐一段带未转义引号的
        // 非法 JSON（真机样本：summary 里嵌了裸双引号），补正机会白白浪费。
        responseFormatJson: true,
      })
      if (repaired.type !== 'final') throw error
      const repairedOutput = applyOutputProtocol(repaired.output, options.promptName)
      options.history.push({ role: 'assistant', content: repaired.output, createdAt: new Date().toISOString() })
      await deps.sessions.save(options.sessionId, options.history)
      await deps.audit?.log({
        requestId: options.requestId,
        sessionId: options.sessionId,
        durationMs: 0,
        errorCode: 'LLM_OUTPUT_PROTOCOL_REPAIRED',
      })
      return repairedOutput
    }
    options.history.push({
      role: 'assistant',
      content: options.output,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      createdAt: new Date().toISOString(),
    })
    await deps.sessions.save(options.sessionId, options.history)
    return parsed
  }

  /**
   * 失败收口：把「写用户可见说明」交给模型，而不是由 Harness 输出套话。
   * 必须禁用工具：模型若再调一次刚失败的工具，会把副作用或失败循环重复一遍。
   */
  async function wrapUpWithModel(options: {
    requestId: string
    sessionId: string
    context: Record<string, unknown>
    history: SessionMessage[]
    promptName?: string
    failureSummary: string
    signal?: AbortSignal
    failureFallback?: unknown
  }): Promise<HarnessResult> {
    const prompt = resolvePrompt(options.promptName)
    const instruction = [
      '本轮执行已终止。失败事实：',
      options.failureSummary,
      '',
      prompt?.protocol
        ? '请按本次任务的输出协议返回 JSON：status 用 failed 或 blocked，summary 说明哪个工具失败、当前流程受到什么影响、用户可以怎么继续。'
        : '请用中文向用户说明：哪个工具失败、当前流程受到什么影响、用户可以怎么继续（例如直接发消息让你重试）。',
      '不要调用任何工具，不要假装任务成功，不要罗列内部错误码。',
    ].join('\n')
    const systemPrompt = [prompt?.prompt, instruction]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('\n\n')
    try {
      const result = await deps.llm.complete({
        context: options.context,
        sessionId: options.sessionId,
        ...(options.signal ? { signal: options.signal } : {}),
        messages: await trimHistory(options.sessionId, options.history),
        systemPrompt,
      })
      // 模型把工具调用当正文返回（无结构化 tool_calls）时不能当成收口说明：
      // 落到下面的兜底分支，给用户可行动的说明而不是原始标记。
      if (result.type === 'final' && !looksLikeToolCallMarkup(result.output)) {
        // 声明了协议时同样要过协议校验；不合法会抛错并落到下面的兜底分支。
        const output = applyOutputProtocol(result.output, options.promptName)
        options.history.push({ role: 'assistant', content: result.output, createdAt: new Date().toISOString() })
        await deps.sessions.save(options.sessionId, options.history)
        return { type: 'final', output }
      }
    } catch (error) {
      // 用户主动停止优先于「补一条说明」：取消必须原样抛出，不能伪装成正常收口。
      if (options.signal?.aborted) {
        throw new AgentKitError('TOOL_EXECUTION_ABORTED', '收口说明生成期间任务被取消', { cause: error })
      }
      await deps.audit?.log({
        requestId: options.requestId,
        sessionId: options.sessionId,
        durationMs: 0,
        errorCode: 'TOOL_FAILURE_WRAPUP_FAILED',
      })
    }
    const fallback = options.failureFallback
      ?? `本次执行未完成：${options.failureSummary}\n这可能是临时故障；你可以直接发消息让我继续，例如「继续尝试刚才的操作」。`
    options.history.push({ role: 'assistant', content: fallback, createdAt: new Date().toISOString() })
    await deps.sessions.save(options.sessionId, options.history)
    return { type: 'final', output: fallback }
  }

  async function runLoop(
    sessionId: string,
    input: string,
    context: Record<string, unknown>,
    history: SessionMessage[],
    promptName?: string,
    skipTools?: boolean,
    stepMode?: boolean,
    allowedToolNames?: string[],
    signal?: AbortSignal,
    requestedMaxSteps?: number,
    toolExecution?: { execute(request: HarnessToolExecutionRequest): Promise<unknown> },
    failureFallback?: unknown,
    runInstanceId?: string,
    controlFlowDecisionProvider?: ControlFlowDecisionProvider | null,
  ): Promise<HarnessResult> {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    // 请求级 maxSteps=0 是 Workflow Agent 的显式无限预算；循环仍受 Task timeoutMs 和 AbortSignal 控制。
    // 其他请求继续只能收紧宿主预算，避免普通 Chat 意外变成无限循环。
    const effectiveMaxSteps = requestedMaxSteps === 0
      ? Number.POSITIVE_INFINITY
      : Math.min(requestedMaxSteps ?? deps.maxSteps, deps.maxSteps)
    // 本次用户输入在首轮发出后即并入历史，避免后续轮次重复追加。
    let pendingInput = input
    // 泄漏的工具调用标记只纠正一次：多补只会把失败循环放大成无上限消耗。
    let pendingSystemNotice: string | undefined
    let toolMarkupRetries = 0
    const notices: HarnessNotice[] = []
    for (let step = 0; step < effectiveMaxSteps; step += 1) {
      const prompt = resolvePrompt(promptName)
      const visibleTools = toolsAllowedForRequest(deps.tools.list(), allowedToolNames)
      const visibleToolNames = visibleTools.map((tool) => tool.name)
      const toolSchemas = skipTools ? [] : toToolSchemas(visibleTools)
      // 每轮只从当前 Harness 状态构造一次普通请求快照；候选与 fallback 各自建新 Request，
      // 在 Jev 约束结果通过类型检查前不提交 pending input、提示词通知或会话消息。
      const requestMessages = await trimHistory(sessionId, history)
      const ordinarySystemPrompt = prompt?.prompt || pendingSystemNotice
        ? [prompt?.prompt, pendingSystemNotice].filter((part): part is string => Boolean(part)).join('\n\n')
        : undefined
      const ordinaryResponseFormatJson = prompt?.protocol && !toolExecution ? true : undefined

      function buildLlmRequest(decision: ControlFlowDecision | null): LlmClientRequest {
        const finishes = decision?.type === 'finish'
        const selectedTool = decision?.type === 'call_tool'
          ? visibleTools.find((tool) => tool.name === decision.toolName)
          : undefined
        const controlInstruction = finishes
          ? '本轮控制决策为 finish。请只输出最终结果，不要调用任何工具。'
          : decision?.type === 'call_tool'
            ? `本轮控制决策为 call_tool。必须调用工具 ${decision.toolName}，不要直接输出最终结果。`
            : undefined
        const systemPrompt = [ordinarySystemPrompt, controlInstruction]
          .filter((part): part is string => Boolean(part))
          .join('\n\n')
        return {
          ...(pendingInput ? { input: pendingInput } : {}),
          // 只新建请求级对象，不做通用深拷贝；Harness 自身只在 candidate 确认后提交状态。
          context: { ...context },
          sessionId,
          ...(signal ? { signal } : {}),
          messages: requestMessages.map((message) => message.role === 'assistant' && message.toolCalls
            ? { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) }
            : { ...message }),
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(finishes
            ? {}
            : selectedTool
              ? {
                  // 保留当前可见工具全集，避免历史 assistant tool_calls 引用的工具不在本轮声明中。
                  tools: toToolSchemas(visibleTools),
                }
              : decision === null && toolSchemas.length > 0
                // 根据未暴露给调用方的 ToolDefinition 重新生成 Schema，确保每次 Completion 使用独立对象。
                ? { tools: toToolSchemas(visibleTools) }
                : {}),
          ...(finishes
            // finish 只有在当前 Prompt 声明了输出协议时才能进入 JSON mode。
            ? (prompt?.protocol ? { responseFormatJson: true } : {})
            : (decision?.type === 'call_tool' ? {} : ordinaryResponseFormatJson ? { responseFormatJson: true } : {})),
          ...(decision?.type === 'finish'
            ? { toolChoice: { type: 'none' } as const }
            : decision?.type === 'call_tool'
              ? { toolChoice: { type: 'tool', toolName: decision.toolName } as const, parallelToolCalls: false }
              : {}),
        }
      }

      async function completeWithAudit(request: LlmClientRequest): Promise<LlmResult> {
        const startedAt = Date.now()
        try {
          const completion = await deps.llm.complete(request)
          await deps.audit?.log({ requestId, sessionId, durationMs: Date.now() - startedAt })
          return completion
        } catch (error) {
          await deps.audit?.log({
            requestId,
            sessionId,
            durationMs: Date.now() - startedAt,
            errorCode: error instanceof AgentKitError ? error.code : 'LLM_CALL_FAILED',
          })
          throw error
        }
      }

      // 每个有可见工具的决策轮次都有独立 ID；无工具轮次不进入 Provider 决策。
      const decisionId = toolSchemas.length > 0 ? `${requestId}-decision-${step + 1}` : undefined
      let decision: ControlFlowDecision | null = null
      if (toolSchemas.length > 0 && controlFlowDecisionProvider && decisionId) {
        try {
          const candidate = await controlFlowDecisionProvider.decide({
            decisionId,
            sessionId,
            ...(runInstanceId !== undefined ? { runInstanceId } : {}),
            availableToolNames: Object.freeze([...visibleToolNames]),
            ...(signal ? { signal } : {}),
          })
          if (candidate?.type === 'finish') decision = candidate
          else if (candidate?.type === 'call_tool' && visibleToolNames.includes(candidate.toolName)) decision = candidate
        } catch (error) {
          if (signal?.aborted) {
            throw new AgentKitError('TOOL_EXECUTION_ABORTED', '控制流决策期间任务已取消', { cause: error })
          }
          // Provider 未形成合法 Decision 时 fail-open 到本轮原始 LLM 请求。
        }
        if (signal?.aborted) throw new AgentKitError('TOOL_EXECUTION_ABORTED', '控制流决策期间任务已取消')
      }

      let result = await completeWithAudit(buildLlmRequest(decision))
      const generationMatchesDecision = decision === null
        || decision.type === 'finish' && result.type === 'final'
        || decision.type === 'call_tool'
          && result.type === 'tool_calls'
          && result.calls.length === 1
          && result.calls[0]?.toolName === decision.toolName
          && Boolean(visibleTools.find((tool) => tool.name === decision.toolName)?.input.safeParse(result.calls[0]?.input).success)
      if (decision && !generationMatchesDecision) {
        // 成功 Decision 后只能拒绝协议违约候选，不能让 Main LLM 重新夺回工具选择权。
        if (signal?.aborted) throw new AgentKitError('TOOL_EXECUTION_ABORTED', '控制流生成校验期间任务已取消')
        await deps.audit?.log({
          requestId,
          ...(decisionId ? { decisionId } : {}),
          sessionId,
          durationMs: 0,
          errorCode: 'CONTROL_FLOW_GENERATION_MISMATCH',
        })
        throw new AgentKitError('CONTROL_FLOW_GENERATION_MISMATCH', 'Main LLM generation 与 Core Control Flow Decision 不一致')
      }
      if (decision?.type === 'call_tool' && result.type === 'tool_calls' && result.content?.length) {
        // 工具选择 Decision 不授权正文；即便 provider 同时返回正文也不能显示或写入 History。
        result = {
          type: 'tool_calls',
          calls: result.calls,
          ...(result.reasoning !== undefined ? { reasoning: result.reasoning } : {}),
        }
      }
      if (pendingInput) {
        history.push({ role: 'user', content: pendingInput, createdAt: new Date().toISOString() })
        pendingInput = ''
      }
      // 纠正指令只作用于紧接着的一次模型调用。
      pendingSystemNotice = undefined

      if (result.type === 'final') {
        // 模型偶尔把工具调用写成正文标记，provider 不会把它解析成 tool_calls。
        // 这类"抽风"通常只差一次重发：给一次纠正机会，让它用工具协议重发或直接文本回答。
        if (!prompt?.protocol && looksLikeToolCallMarkup(result.output) && toolMarkupRetries < MAX_TOOL_MARKUP_RETRIES) {
          toolMarkupRetries += 1
          // 保留泄漏输出，模型才看得到自己写错了什么（与协议补正的处理一致）。
          history.push({
            role: 'assistant',
            content: result.output,
            ...(result.reasoning ? { reasoning: result.reasoning } : {}),
            createdAt: new Date().toISOString(),
          })
          await deps.sessions.save(sessionId, history)
          await deps.audit?.log({ requestId, sessionId, durationMs: 0, errorCode: 'LLM_TOOL_CALL_MARKUP_RETRY' })
          pendingSystemNotice = [
            '你上一条回复把工具调用写成了正文里的标记，provider 没有把它解析为工具调用。',
            '请二选一重新回复：需要继续操作时，用标准工具调用协议重新发起同一个工具；不需要工具时，直接用中文文本回答用户。',
            '不要输出任何调用标记、XML 标签或伪代码块。',
          ].join('\n')
          continue
        }
        // 收口自己负责写回会话：补正分支会把不合协议的那轮和补正结果都留在历史里，
        // 思考内容也一并落库，否则刷新页面后无法恢复。
        const output = await finalizeProtocolOutput({
          requestId, sessionId, context, history, output: result.output,
          ...(promptName ? { promptName } : {}),
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          ...(signal ? { signal } : {}),
        })
        return { type: 'final', output, ...(result.reasoning ? { reasoning: result.reasoning } : {}) }
      }

      // assistant 工具调用轮次先入库：执行前保存才能在工具阻塞或刷新时恢复完整上下文。
      // 工具调用轮次同样保存 reasoning；否则工具执行期间产生的思考会在刷新后丢失。
      history.push({
        role: 'assistant',
        // 工具调用轮次也可能带正文；保留它才能让 WebUI 刷新后恢复完整回答。
        content: result.content ?? null,
        toolCalls: result.calls,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        createdAt: new Date().toISOString(),
      })
      await deps.sessions.save(sessionId, history)

      const remoteCalls: Array<{ callId: string; toolName: string; input: unknown }> = []
      for (const call of result.calls) {
        if (allowedToolNames !== undefined && !visibleToolNames.includes(call.toolName)) {
          await deps.audit?.log({ requestId, sessionId, durationMs: 0, toolName: call.toolName, errorCode: 'TOOL_NOT_ALLOWED' })
          history.push({
            role: 'tool',
            content: {
              ok: false,
              code: 'TOOL_NOT_ALLOWED',
              message: `工具 ${call.toolName} 不在本次请求允许列表中。可用工具：${visibleToolNames.join(', ') || '无'}`,
            },
            callId: call.callId,
            toolName: call.toolName,
            createdAt: new Date().toISOString(),
          })
          continue
        }
        const tool = deps.tools.get(call.toolName)
        // 未注册的工具名不中断整轮：模型偶发输出畸形函数名（上下文压力大时尤其常见），
        // 把可选工具列表回传让它自己纠正，比让整个任务猝死更有用。
        if (!tool) {
          const available = visibleToolNames.join(', ')
          await deps.audit?.log({ requestId, sessionId, durationMs: 0, toolName: call.toolName, errorCode: 'TOOL_NOT_REGISTERED' })
          history.push({
            role: 'tool',
            content: {
              ok: false,
              code: 'TOOL_NOT_REGISTERED',
              message: `工具未注册：${call.toolName}。可用工具：${available}。可以改用其中之一，也可以直接用文本向用户提问或说明后继续。`,
            },
            callId: call.callId,
            toolName: call.toolName,
            createdAt: new Date().toISOString(),
          })
          continue
        }
        let parsedInput: unknown
        try {
          parsedInput = parseWithCode(tool.input, call.input, 'TOOL_INPUT_INVALID')
        } catch (error) {
          const attempt = recentToolFailureCount(history, call.toolName, ['TOOL_INPUT_INVALID']) + 1
          const stopRetrying = attempt >= 2
          const failureMessage = stopRetrying
            ? `工具 ${call.toolName} 的参数已连续 ${attempt} 次校验失败。停止自动重试；请先向用户说明失败并询问是否继续排查。`
            : `工具 ${call.toolName} 的参数校验失败。请根据工具 schema 修正参数后重试一次。`
          const notice: HarnessNotice = {
            toolName: call.toolName,
            code: 'TOOL_INPUT_INVALID',
            retryable: !stopRetrying,
            attempt,
            message: failureMessage,
          }
          notices.push(notice)
          await deps.audit?.log({ requestId, sessionId, durationMs: 0, toolName: call.toolName, errorCode: 'TOOL_INPUT_INVALID' })
          history.push({
            role: 'tool',
            content: { ok: false, ...notice },
            callId: call.callId,
            toolName: call.toolName,
            createdAt: new Date().toISOString(),
          })
          if (stopRetrying) {
            return wrapUpWithModel({
              requestId,
              sessionId,
              context,
              history,
              ...(promptName ? { promptName } : {}),
              failureSummary: `工具 ${call.toolName} 的参数已连续 ${attempt} 次校验失败。`,
              ...(signal ? { signal } : {}),
              ...(failureFallback === undefined ? {} : { failureFallback }),
            })
          }
          continue
        }
        if (tool.execution === 'remote') {
          // promptName 随挂起状态保存：resume 要用同一个提示词继续。
          await pendingCalls.set(call.callId, {
            sessionId,
            toolName: call.toolName,
            ...(promptName ? { promptName } : {}),
          })
          remoteCalls.push({ callId: call.callId, toolName: call.toolName, input: parsedInput })
          continue
        }
        // 单个工具的执行失败不中断整轮：把失败结果一并回传，让模型自己决定如何补救。
        // 但 Schema 校验失败是契约违约（工具定义与模型输出不匹配），必须直接抛出而不是喂回模型。
        let rawOutput: unknown
        try {
          rawOutput = await executeWithTimeout(
            tool,
            parsedInput,
            tool.timeoutMs ?? toolTimeoutMs,
            sessionId,
            call.callId,
            signal,
            toolExecution
              ? (toolSignal) => toolExecution.execute({
                  tool,
                  input: parsedInput,
                  sessionId,
                  callId: call.callId,
                  signal: toolSignal,
                })
              : undefined,
          )
        } catch (error) {
          // 结果不确定：不重试、不继续循环，把事实写进历史后交给模型收口。
          // 直接抛回给调用方会让用户只看到「执行失败」，也拿不到一句解释。
          if (hasErrorCode(error, 'TOOL_EXECUTION_UNCERTAIN') || hasErrorCode(error, 'UNCERTAIN')) {
            history.push({
              role: 'tool',
              content: {
                ok: false,
                code: 'TOOL_EXECUTION_UNCERTAIN',
                uncertain: true,
                message: `工具 ${call.toolName} 执行结果不确定：${error instanceof Error ? error.message : '结果未知'}`,
              },
              callId: call.callId,
              toolName: call.toolName,
              createdAt: new Date().toISOString(),
            })
            await deps.sessions.save(sessionId, history)
            await deps.audit?.log({ requestId, sessionId, durationMs: 0, toolName: call.toolName, errorCode: 'TOOL_EXECUTION_UNCERTAIN' })
            return wrapUpWithModel({
              requestId,
              sessionId,
              context,
              history,
              ...(promptName ? { promptName } : {}),
              failureSummary: `工具 ${call.toolName} 的执行结果不确定（可能已产生副作用），已停止重试。`,
              ...(signal ? { signal } : {}),
              ...(failureFallback === undefined ? {} : { failureFallback }),
            })
          }
          // 父级取消不能喂回模型形成自动重试，避免副作用被重复发起。
          if (signal?.aborted) throw new AgentKitError('TOOL_EXECUTION_ABORTED', `工具执行已取消：${tool.name}`, { cause: error })
          // 普通异常（HTTP 500、连接失败等）不是取消：必须与真正的 abort 区分开，
          // 否则下游 Workflow 会把一次工具失败判成「用户已取消」。
          const code = error instanceof AgentKitError ? error.code : 'TOOL_EXECUTION_FAILED'
          const attempt = recentToolFailureCount(
            history,
            call.toolName,
            ['TOOL_EXECUTION_FAILED', 'TOOL_EXECUTION_ABORTED', 'TOOL_EXECUTION_TIMEOUT'],
          ) + 1
          const stopRetrying = attempt >= 2
          const failureMessage = stopRetrying
            ? `工具 ${call.toolName} 已连续 ${attempt} 次执行失败：${error instanceof Error ? error.message : '工具执行失败'}。停止自动重试；请先向用户说明并询问是否继续排查。`
            : `${error instanceof Error ? error.message : '工具执行失败'}。可以修正状态后重试一次。`
          const notice: HarnessNotice = {
            toolName: call.toolName,
            code: code as HarnessNotice['code'],
            retryable: !stopRetrying,
            attempt,
            message: failureMessage,
          }
          notices.push(notice)
          await deps.audit?.log({ requestId, sessionId, durationMs: 0, toolName: call.toolName, errorCode: code })
          history.push({
            role: 'tool',
            content: { ok: false, ...notice },
            callId: call.callId,
            toolName: call.toolName,
            createdAt: new Date().toISOString(),
          })
          if (stopRetrying) {
            return wrapUpWithModel({
              requestId,
              sessionId,
              context,
              history,
              ...(promptName ? { promptName } : {}),
              failureSummary: `工具 ${call.toolName} 已连续 ${attempt} 次执行失败：${error instanceof Error ? error.message : '工具执行失败'}。`,
              ...(signal ? { signal } : {}),
              ...(failureFallback === undefined ? {} : { failureFallback }),
            })
          }
          continue
        }
        let parsedOutput: unknown
        try {
          parsedOutput = parseWithCode(tool.output, rawOutput, 'TOOL_OUTPUT_INVALID')
        } catch (error) {
          const attempt = recentToolFailureCount(history, call.toolName, ['TOOL_OUTPUT_INVALID']) + 1
          const stopRetrying = attempt >= 2
          const notice: HarnessNotice = {
            toolName: call.toolName,
            code: 'TOOL_OUTPUT_INVALID',
            retryable: !stopRetrying,
            attempt,
            message: stopRetrying
              ? `工具 ${call.toolName} 的输出已连续 ${attempt} 次不符合 schema。停止自动重试；请向用户说明并排查工具实现。`
              : `工具 ${call.toolName} 的输出不符合 schema。请修正调用状态后重试一次。`,
          }
          notices.push(notice)
          await deps.audit?.log({ requestId, sessionId, durationMs: 0, toolName: call.toolName, errorCode: 'TOOL_OUTPUT_INVALID' })
          history.push({
            role: 'tool', content: { ok: false, ...notice }, callId: call.callId,
            toolName: call.toolName, createdAt: new Date().toISOString(),
          })
          if (stopRetrying) {
            return wrapUpWithModel({
              requestId,
              sessionId,
              context,
              history,
              ...(promptName ? { promptName } : {}),
              failureSummary: `工具 ${call.toolName} 的输出已连续 ${attempt} 次不符合 schema。`,
              ...(signal ? { signal } : {}),
              ...(failureFallback === undefined ? {} : { failureFallback }),
            })
          }
          continue
        }
        history.push({ role: 'tool', content: parsedOutput, callId: call.callId, toolName: call.toolName, createdAt: new Date().toISOString() })
      }

      // 工具执行完毕后立即存盘：即使全部失败或 throw，历史也不丢失。
      await deps.sessions.save(sessionId, history)

      // 本轮存在远端调用时整轮挂起：全部 callId 回填完毕后才继续。
      if (remoteCalls.length > 0) {
        await deps.sessions.save(sessionId, history)
        return { type: 'pending_tool_calls', calls: remoteCalls }
      }
      if (stepMode) {
        // 当前 server 路径执行完工具后不存盘即进入下一轮；stepMode 在此返回，
        // 不存盘会导致 continue 从 store 读到旧历史，丢失这一步的工具结果。
        await deps.sessions.save(sessionId, history)
        return notices.length > 0 ? { type: 'step_done', notices: [...notices] } : { type: 'step_done' }
      }
    }
    throw new AgentKitError('HARNESS_STEP_LIMIT', `工具调用超过最大步数：${effectiveMaxSteps}`)
  }

  /** 判断本轮 assistant 发起的调用是否已全部回填。 */
  function hasUnfilledCalls(history: SessionMessage[]): boolean {
    const expected = new Set<string>()
    for (const message of history) {
      if (message.role === 'assistant' && message.toolCalls) {
        for (const call of message.toolCalls) expected.add(call.callId)
      }
      if (message.role === 'tool') expected.delete(message.callId)
    }
    return expected.size > 0
  }

  /**
   * 清除历史中「只发起了工具调用、没有对应结果」的残破轮次。
   *
   * 这类残破历史是任务中止的产物：一轮含远端调用时，harness 先持久化了带 toolCalls 的
   * assistant 消息，结果没回来任务就停了（用户停止、断连、sidepanel 关闭）。
   * 之后同一会话再发新指令，`run()` 会把这条残破历史原样发给模型，
   * 而 OpenAI 兼容端点要求每个 tool_call_id 都有对应结果，于是直接 400。
   *
   * 修复策略：新指令意味着上一轮已被放弃，把那些没有结果的 assistant 消息连同
   * 它们后面悬空的 tool 消息一起裁掉，只保留完整往返。
   */
  function sanitizeIncompleteRounds(history: SessionMessage[]): SessionMessage[] {
    const filledCallIds = new Set(history.filter((m) => m.role === 'tool').map((m) => (m as { callId: string }).callId))
    const keptAssistantCallIds = new Set<string>()
    const result: SessionMessage[] = []
    for (const message of history) {
      if (message.role === 'assistant' && message.toolCalls?.length) {
        // 只要有一个调用没回填，整条 assistant 连同它的未回填调用都丢弃。
        if (!message.toolCalls.every((call) => filledCallIds.has(call.callId))) continue
        for (const call of message.toolCalls) keptAssistantCallIds.add(call.callId)
      }
      if (message.role === 'tool') {
        // 它的 assistant 已被丢弃，这条 tool 结果也无主，一并丢弃。
        if (!keptAssistantCallIds.has(message.callId)) continue
      }
      result.push(message)
    }
    return result
  }

  return {
    async run(request) {
      let history = [...(await deps.sessions.load(request.sessionId))]
      const sanitized = sanitizeIncompleteRounds(history)
      if (sanitized.length !== history.length) {
        // 残破历史被裁掉后写回，避免下次再踩同一个 400。
        await deps.sessions.save(request.sessionId, sanitized)
        history = sanitized
      }
      return runLoop(
        request.sessionId,
        request.input,
        request.context,
        history,
        request.promptName,
        request.skipTools,
        request.stepMode,
        request.allowedToolNames,
        request.signal,
        request.maxSteps,
        request.toolExecution,
        request.failureFallback,
        request.runInstanceId,
        request.controlFlowDecisionProvider === undefined ? deps.controlFlowDecisionProvider : request.controlFlowDecisionProvider,
      )
    },
    async continue(request) {
      const history: SessionMessage[] = [...(await deps.sessions.load(request.sessionId))]
      // 不调用 sanitizeIncompleteRounds：stepMode 落库的是完整 server 工具轮次，
      // 不存在残破 assistant 消息；裁剪反而会误删上一步的工具结果。
      return runLoop(
        request.sessionId,
        request.input ?? '',
        request.context ?? {},
        history,
        request.promptName,
        undefined,
        true,
        request.allowedToolNames,
        request.signal,
        undefined,
        undefined,
        request.failureFallback,
        request.runInstanceId,
        request.controlFlowDecisionProvider === undefined ? deps.controlFlowDecisionProvider : request.controlFlowDecisionProvider,
      )
    },
    async resume(request) {
      const pending = await pendingCalls.get(request.callId)
      if (!pending || pending.sessionId !== request.sessionId) {
        throw new AgentKitError('PENDING_CALL_NOT_FOUND', `未找到可回填的工具调用：${request.callId}`)
      }
      const tool = deps.tools.get(pending.toolName)
      if (!tool) throw new AgentKitError('TOOL_NOT_REGISTERED', `工具未注册：${pending.toolName}`)

      // 远端回填的 output 可能不符合 schema（扩展侧 bug、版本不同步等）。
      // 不能让一次校验失败硬崩整个会话 —— 把校验失败作为工具错误结果喂回模型，
      // 与本地工具执行失败的处理保持一致。
      let parsedOutput: unknown
      try {
        parsedOutput = parseWithCode(tool.output, request.output, 'TOOL_OUTPUT_INVALID')
      } catch (error) {
        const code = error instanceof AgentKitError ? error.code : 'TOOL_OUTPUT_INVALID'
        const message = error instanceof Error ? error.message : '工具输出校验失败'
        await deps.audit?.log({ requestId: request.callId, sessionId: request.sessionId, durationMs: 0, toolName: pending.toolName, errorCode: code })
        parsedOutput = { ok: false, code, message }
      }

      await pendingCalls.delete(request.callId)
      const history: SessionMessage[] = [
        ...(await deps.sessions.load(request.sessionId)),
        { role: 'tool', content: parsedOutput, callId: request.callId, toolName: pending.toolName, createdAt: new Date().toISOString() },
      ]
      // 同轮还有未回填的调用时不推进模型，只落库并回报剩余待办。
      if (hasUnfilledCalls(history)) {
        await deps.sessions.save(request.sessionId, history)
        return { type: 'pending_tool_calls', calls: await remainingCalls(history) }
      }
      // 回填后继续模型循环，沿用发起调用时的提示词，无需再附加新的用户输入。
      return runLoop(
        request.sessionId,
        '',
        {},
        history,
        pending.promptName,
        undefined,
        undefined,
        undefined,
        request.signal,
        undefined,
        undefined,
        request.failureFallback,
        request.runInstanceId,
        request.controlFlowDecisionProvider === undefined ? deps.controlFlowDecisionProvider : request.controlFlowDecisionProvider,
      )
    },
  }

  /** 收集历史中尚未回填的远端调用，供 resume 回报。 */
  async function remainingCalls(history: SessionMessage[]): Promise<Array<{ callId: string; toolName: string; input: unknown }>> {
    const filled = new Set(history.filter((message) => message.role === 'tool').map((message) => (message as { callId: string }).callId))
    const remaining: Array<{ callId: string; toolName: string; input: unknown }> = []
    for (const message of history) {
      if (message.role !== 'assistant' || !message.toolCalls) continue
      for (const call of message.toolCalls) {
        if (!filled.has(call.callId)) remaining.push({ callId: call.callId, toolName: call.toolName, input: call.input })
      }
    }
    return remaining
  }
}
