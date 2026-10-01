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
  const protectedUnits = units.slice(-preserve)
  let compressible = units.slice(0, -preserve)
  if (compressible.length === 0) return { messages, compressedCount: 0 }

  // Phase 1: drop old tool-call rounds (assistant + its tool results) as a whole.
  const kept: SessionMessage[][] = []
  let droppedCount = 0
  for (const unit of compressible) {
    const first = unit[0]
    if (first && first.role === 'assistant' && first.toolCalls && first.toolCalls.length > 0) {
      droppedCount += unit.length
      continue
    }
    kept.push(unit)
  }
  compressible = kept
  let result = [...compressible, ...protectedUnits].flat()
  if (estimateMessages(result) / limit <= low) {
    return { messages: result, compressedCount: droppedCount }
  }

  // Phase 2: summarize the oldest remaining units until we hit low watermark.
  const toSummarize: SessionMessage[][] = []
  while (estimateMessages(result) / limit > low && compressible.length > 0) {
    const oldest = compressible.shift()
    if (!oldest) break
    toSummarize.push(oldest)
    result = [...compressible, ...protectedUnits].flat()
  }

  let summary: string | undefined
  if (toSummarize.length > 0 && summarizer) {
    try {
      summary = await summarizer(toSummarize.flat(), sessionId)
    } catch {
      // Fallback: leave the dropped units gone; no summary added.
    }
  }

  if (summary) {
    result = [{ role: 'system', content: `Earlier conversation summary: ${summary}` }, ...result]
  }

  return { messages: result, ...(summary ? { summary } : {}), compressedCount: droppedCount + toSummarize.flat().length }
}
