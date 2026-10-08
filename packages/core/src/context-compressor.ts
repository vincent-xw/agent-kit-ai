import type { SessionMessage } from './contracts.js'
import { estimateMessages } from './token-counter.js'

export interface CompressOptions {
  limit: number
  /** 可用 Provider 实际 prompt usage 校准自动压缩门槛；消息保留预算仍按本地估算计算。 */
  usedTokens?: number
  mode?: 'default' | 'fast'
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
  preserveRecentTokens?: number
  minimumRecentMessages?: number
}

export interface CompressResult {
  messages: SessionMessage[]
  summary?: string
  compressedCount: number
}

/** 摘要器可接收所属会话 ID，供需要会话路由的 LLM 服务商使用。 */
export type Summarizer = (messages: SessionMessage[], sessionId?: string) => Promise<string>

const SUMMARY_TOOL_OUTPUT_MAX_CHARS = 2_000

/** 摘要请求只保留工具结果的首尾片段，避免大快照挤占压缩请求本身的上下文。 */
function compactSummaryInput(messages: SessionMessage[]): SessionMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message

    let content: string
    try {
      content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content) ?? String(message.content)
    } catch {
      content = String(message.content)
    }
    if (content.length <= SUMMARY_TOOL_OUTPUT_MAX_CHARS) return message

    const headLength = SUMMARY_TOOL_OUTPUT_MAX_CHARS - 500
    const omittedLength = content.length - SUMMARY_TOOL_OUTPUT_MAX_CHARS
    return {
      ...message,
      content: `${content.slice(0, headLength)}\n[…工具输出省略 ${omittedLength} 字符…]\n${content.slice(-500)}`,
    }
  })
}

/** 摘要服务不可用时保留一份有边界的本地执行记录，避免静默丢掉所有旧工具进度。 */
function buildFallbackSummary(messages: SessionMessage[]): string {
  const previousSummaries = messages.filter(isContextSummary).slice(-2)
  const userMessages = messages.filter((message) => message.role === 'user')
  const firstUser = userMessages[0]
  const recentUsers = new Set<SessionMessage>([...(firstUser ? [firstUser] : []), ...userMessages.slice(-2)])
  const recentAssistant = new Set<SessionMessage>(messages.filter((message) => message.role === 'assistant').slice(-4))
  const recentTools = new Set<SessionMessage>(messages.filter((message) => message.role === 'tool').slice(-3))
  const previousSummarySet = new Set(previousSummaries)
  const lines = [
    '自动摘要服务暂不可用，以下是按时间顺序提取的历史执行记录。继续当前任务时先确认最近进度，不要默认从头开始。',
  ]
  for (const message of messages) {
    if (previousSummarySet.has(message)) {
      lines.push(`此前任务状态：${summarizeValue(message.content, 500)}`)
    } else if (recentUsers.has(message) && message.role === 'user') {
      lines.push(`${message === firstUser ? '用户原始目标/约束' : '用户补充'}：${summarizeValue(message.content, 280)}`)
    } else if (recentAssistant.has(message) && message.role === 'assistant') {
      if (message.content !== null && message.content !== undefined && message.content !== '') {
        lines.push(`助手记录：${summarizeValue(message.content, 220)}`)
      }
      if (message.toolCalls?.length) {
        lines.push(`助手请求工具：${message.toolCalls.map((call) => `${call.toolName}(${call.callId})`).join('、')}`)
      }
    } else if (recentTools.has(message) && message.role === 'tool') {
      lines.push(`工具 ${message.toolName ?? 'unknown'}(${message.callId}) 结果：${summarizeValue(message.content, 180)}`)
    }
  }
  return lines.join('\n').slice(0, 1_800)
}

function summarizeValue(value: unknown, maxChars: number): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 40)}…[省略 ${text.length - maxChars} 字符]`
}

function isContextSummary(message: SessionMessage): boolean {
  return message.role === 'system'
    && typeof message.content === 'string'
    && message.content.startsWith('Earlier conversation summary: ')
}

interface MessageUnit {
  messages: SessionMessage[]
  pendingToolCall: boolean
}

/** 把 assistant Tool Call 与相邻结果合成完整单元，避免摘要裁剪拆散 call/result。 */
function toUnits(messages: SessionMessage[]): MessageUnit[] {
  const units: MessageUnit[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const expected = new Set(message.toolCalls.map((call) => call.callId))
      const unit: SessionMessage[] = [message]
      const received = new Set<string>()
      let cursor = index + 1
      while (cursor < messages.length) {
        const next = messages[cursor]
        if (!next || next.role !== 'tool' || !expected.has(next.callId)) break
        unit.push(next)
        received.add(next.callId)
        cursor += 1
      }
      units.push({ messages: unit, pendingToolCall: [...expected].some((callId) => !received.has(callId)) })
      index = cursor
      continue
    }
    units.push({ messages: [message], pendingToolCall: false })
    index += 1
  }
  return units
}

/** fast Tier 1/2 只裁掉较早的完整 Tool Call/Result，其他对话事实保持原样。 */
function trimCompletedToolCalls(messages: SessionMessage[], keepRecentCount: number): CompressResult {
  const resultIds = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.callId))
  const orderedCallIds: string[] = []
  const seenCallIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue
    for (const call of message.toolCalls) {
      if (resultIds.has(call.callId) && !seenCallIds.has(call.callId)) {
        seenCallIds.add(call.callId)
        orderedCallIds.push(call.callId)
      }
    }
  }
  const removeIds = new Set(orderedCallIds.slice(0, Math.max(0, orderedCallIds.length - keepRecentCount)))
  if (removeIds.size === 0) return { messages, compressedCount: 0 }

  let compressedCount = 0
  const trimmed: SessionMessage[] = []
  for (const message of messages) {
    if (message.role === 'tool' && removeIds.has(message.callId)) {
      compressedCount += 1
      continue
    }
    if (message.role === 'assistant' && message.toolCalls) {
      const toolCalls = message.toolCalls.filter((call) => !removeIds.has(call.callId))
      compressedCount += message.toolCalls.length - toolCalls.length
      if (toolCalls.length !== message.toolCalls.length) {
        const hasBody = message.content !== null && message.content !== undefined && message.content !== ''
        if (!hasBody && !message.reasoning && toolCalls.length === 0) continue
        const { toolCalls: _removedCalls, ...messageWithoutCalls } = message
        trimmed.push(toolCalls.length > 0 ? { ...message, toolCalls } : messageWithoutCalls)
        continue
      }
    }
    trimmed.push(message)
  }
  return { messages: trimmed, compressedCount }
}

export async function compressMessages(
  messages: SessionMessage[],
  options: CompressOptions,
  summarizer?: Summarizer,
  /** 当前压缩所属会话；旧调用不传时保持摘要器兼容。 */
  sessionId?: string,
): Promise<CompressResult> {
  const limit = options.limit
  const mode = options.mode ?? 'default'
  const high = options.highWatermark ?? 0.9
  const low = options.lowWatermark ?? 0.5

  const used = options.usedTokens ?? estimateMessages(messages)
  if (limit <= 0) return { messages, compressedCount: 0 }
  const ratio = used / limit
  if (mode === 'fast' && ratio >= 0.5 && ratio < Math.min(0.8, high)) {
    return trimCompletedToolCalls(messages, 20)
  }
  if (mode === 'fast' && ratio >= 0.8 && ratio < high) {
    return trimCompletedToolCalls(messages, 10)
  }
  if (ratio < high) return { messages, compressedCount: 0 }

  const units = toUnits(messages)
  const minimumRecentMessages = Math.max(options.minimumRecentMessages ?? 3, options.preserveRecentUnits ?? 0)
  const recentTokenBudget = options.preserveRecentTokens ?? Math.min(30_000, Math.floor(limit * low))
  const firstUserUnit = units.find((unit) => unit.messages.some((message) => message.role === 'user'))
  const protectedUnits = new Set<MessageUnit>([
    ...units.filter((unit) => unit.messages.some((message) => message.role === 'system') && !unit.messages.some(isContextSummary)),
    ...units.filter((unit) => unit.pendingToolCall),
    // 首条用户消息承载本轮原始目标、约束和输出格式；摘要遗漏时仍需完整保留。
    ...(firstUserUnit ? [firstUserUnit] : []),
  ])

  // 从尾部保留完整的最近轮次，直到达到 token 预算和最少消息数；Tool Pair 不会被拆开。
  let recentMessages = 0
  let recentTokens = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]
    if (!unit || protectedUnits.has(unit) || unit.messages.some(isContextSummary)) continue
    if (recentMessages >= minimumRecentMessages && recentTokens >= recentTokenBudget) break
    protectedUnits.add(unit)
    recentMessages += unit.messages.length
    recentTokens += estimateMessages(unit.messages)
  }

  const removedUnits = units.filter((unit) => !protectedUnits.has(unit) && !unit.messages.some(isContextSummary))
  if (removedUnits.length === 0) return { messages, compressedCount: 0 }

  // 用完整输入生成摘要，使之前 Tier 1/2 暂时移出 projection 的工具进度仍可在 Tier 3 汇总。
  const toSummarize = units.flatMap((unit) => unit.messages)
  let summary: string | undefined
  if (toSummarize.length > 0) {
    try {
      if (summarizer) {
        summary = await summarizer(compactSummaryInput(toSummarize), sessionId)
        if (!summary.trim()) summary = buildFallbackSummary(toSummarize)
      } else {
        summary = buildFallbackSummary(toSummarize)
      }
    } catch {
      // 摘要接口故障时用本地执行记录兜底，避免旧工具轮次被无声丢弃。
      summary = buildFallbackSummary(toSummarize)
    }
  }

  const preservedMessages = units
    .filter((unit) => protectedUnits.has(unit))
    .flatMap((unit) => unit.messages)
  const systemMessages = preservedMessages.filter((message) => message.role === 'system')
  const recentMessagesInOrder = preservedMessages.filter((message) => message.role !== 'system')
  const result = summary
    ? [{ role: 'system' as const, content: `Earlier conversation summary: ${summary}` }, ...systemMessages, ...recentMessagesInOrder]
    : [...systemMessages, ...recentMessagesInOrder]
  const compressedCount = removedUnits.flatMap((unit) => unit.messages).filter((message) => !isContextSummary(message)).length
  return { messages: result, ...(summary ? { summary } : {}), compressedCount }
}
