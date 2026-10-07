import type { SessionMessage } from './contracts.js'
import { estimateMessages } from './token-counter.js'

export interface CompressOptions {
  limit: number
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
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
  const recentUsers = new Set<SessionMessage>(messages.filter((message) => message.role === 'user').slice(-4))
  const recentAssistant = new Set<SessionMessage>(messages.filter((message) => message.role === 'assistant').slice(-8))
  const recentTools = new Set<SessionMessage>(messages.filter((message) => message.role === 'tool').slice(-12))
  const previousSummarySet = new Set(previousSummaries)
  const lines = [
    '自动摘要服务暂不可用，以下是按时间顺序提取的历史执行记录。继续当前任务时先确认最近进度，不要默认从头开始。',
  ]
  for (const message of messages) {
    if (previousSummarySet.has(message)) {
      lines.push(`此前任务状态：${summarizeValue(message.content, 900)}`)
    } else if (recentUsers.has(message) && message.role === 'user') {
      lines.push(`用户目标/补充：${summarizeValue(message.content, 700)}`)
    } else if (recentAssistant.has(message) && message.role === 'assistant') {
      if (message.content !== null && message.content !== undefined && message.content !== '') {
        lines.push(`助手记录：${summarizeValue(message.content, 500)}`)
      }
      if (message.toolCalls?.length) {
        lines.push(`助手请求工具：${message.toolCalls.map((call) => `${call.toolName}(${call.callId})`).join('、')}`)
      }
    } else if (recentTools.has(message) && message.role === 'tool') {
      lines.push(`工具 ${message.toolName ?? 'unknown'}(${message.callId}) 结果：${summarizeValue(message.content, 350)}`)
    }
  }
  return lines.join('\n').slice(0, 8_000)
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

function toUnits(messages: SessionMessage[]): SessionMessage[][] {
  const units: SessionMessage[][] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const expected = new Set(message.toolCalls.map((call) => call.callId))
      const unit: SessionMessage[] = [message]
      let cursor = index + 1
      while (cursor < messages.length) {
        const next = messages[cursor]
        if (!next || next.role !== 'tool' || !expected.has(next.callId)) break
        unit.push(next)
        cursor += 1
      }
      units.push(unit)
      index = cursor
      continue
    }
    units.push([message])
    index += 1
  }
  return units
}

export async function compressMessages(
  messages: SessionMessage[],
  options: CompressOptions,
  summarizer?: Summarizer,
  /** 当前压缩所属会话；旧调用不传时保持摘要器兼容。 */
  sessionId?: string,
): Promise<CompressResult> {
  const limit = options.limit
  const high = options.highWatermark ?? 0.8
  const low = options.lowWatermark ?? 0.5
  const preserve = options.preserveRecentUnits ?? 2

  const used = estimateMessages(messages)
  if (limit <= 0 || used / limit < high) return { messages, compressedCount: 0 }

  const units = toUnits(messages)
  // 旧摘要会并入新摘要，避免后续压缩只保留最新几轮工具活动而丢失原始目标。
  const previousSummaryUnits = units.filter((unit) => unit.some(isContextSummary))
  const previousSummarySet = new Set(previousSummaryUnits)
  const protectedUnits = units.slice(-preserve).filter((unit) => !previousSummarySet.has(unit))
  let compressible = units.slice(0, -preserve).filter((unit) => !previousSummarySet.has(unit))
  if (compressible.length === 0) return { messages, compressedCount: 0 }

  // Phase 1: 从模型上下文移除旧工具轮次，但仍把它们纳入执行摘要，保留已经完成的工作。
  const kept: SessionMessage[][] = []
  const removedUnits = new Set<SessionMessage[]>(previousSummaryUnits)
  for (const unit of compressible) {
    const first = unit[0]
    if (first && first.role === 'assistant' && first.toolCalls && first.toolCalls.length > 0) {
      removedUnits.add(unit)
      continue
    }
    kept.push(unit)
  }
  compressible = kept
  let result = [...compressible, ...protectedUnits].flat()

  // Phase 2: summarize the oldest remaining units until we hit low watermark.
  while (estimateMessages(result) / limit > low && compressible.length > 0) {
    const oldest = compressible.shift()
    if (!oldest) break
    removedUnits.add(oldest)
    result = [...compressible, ...protectedUnits].flat()
  }

  // 同时提供最近用户目标和近期结果，让摘要器能概括任务进度，而非只列出被移除的旧工具。
  const summaryContextUnits = new Set<SessionMessage[]>(removedUnits)
  for (const unit of protectedUnits) summaryContextUnits.add(unit)
  const recentUserMessages = messages.filter((message) => message.role === 'user').slice(-4)
  for (const userMessage of recentUserMessages) {
    const unit = units.find((candidate) => candidate.includes(userMessage))
    if (unit) summaryContextUnits.add(unit)
  }
  // 按原始对话顺序交给摘要器，避免工具轮次与更早普通消息时序颠倒。
  const toSummarize = units.filter((unit) => summaryContextUnits.has(unit)).flat()
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

  if (summary) {
    result = [{ role: 'system', content: `Earlier conversation summary: ${summary}` }, ...result]
  }

  const compressedCount = [...removedUnits].flat().filter((message) => !isContextSummary(message)).length
  return { messages: result, ...(summary ? { summary } : {}), compressedCount }
}
