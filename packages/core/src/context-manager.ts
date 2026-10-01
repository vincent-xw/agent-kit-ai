import type { SessionMessage } from './contracts.js'

/** 会话上下文管理器：按 session 保存消息并执行窗口裁剪。 */
export interface ContextManager {
  load(sessionId: string): SessionMessage[] | Promise<SessionMessage[]>
  save(sessionId: string, messages: SessionMessage[]): void | Promise<void>
  append(sessionId: string, message: SessionMessage): void | Promise<void>
  /** 返回窗口裁剪产生的摘要文本；未发生过裁剪时返回 undefined。 */
  getSummary(sessionId: string): string | undefined | Promise<string | undefined>
}

/**
 * 把历史切成不可分割的单元。
 *
 * 一条 assistant 消息与它发起的全部 tool 结果必须同去同留：
 * 单独留下 tool 消息会让 OpenAI 兼容端点返回 400（tool_call_id 找不到对应的调用），
 * 单独留下带 toolCalls 的 assistant 也会让模型看到一个永远没有结果的调用。
 */
function toUnits(messages: SessionMessage[]): SessionMessage[][] {
  const units: SessionMessage[][] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (!message) break
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const expected = new Set(message.toolCalls.map((call) => call.callId))
      const unit: SessionMessage[] = [message]
      let cursor = index + 1
      // 收拢紧随其后、属于本次调用的 tool 结果。
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

/**
 * 内存实现：超过 maxMessages 时按单元边界丢弃最旧内容并记录裁剪摘要。
 *
 * 摘要只描述被裁剪的数量，不包含业务上下文与敏感内容。
 */
export function createContextManager(options: { maxMessages: number }): ContextManager {
  const sessions = new Map<string, SessionMessage[]>()
  const summaries = new Map<string, string>()

  function trim(sessionId: string, messages: SessionMessage[]): SessionMessage[] {
    if (messages.length <= options.maxMessages) return messages

    // 从最新的单元往前收，直到再加一个单元就会超出窗口。
    const units = toUnits(messages)
    const kept: SessionMessage[][] = []
    let count = 0
    for (let index = units.length - 1; index >= 0; index -= 1) {
      const unit = units[index]
      if (!unit) continue
      if (count + unit.length > options.maxMessages) break
      kept.unshift(unit)
      count += unit.length
    }

    const result = kept.flat()
    const dropped = messages.length - result.length
    if (dropped > 0) summaries.set(sessionId, `已裁剪 ${dropped} 条历史消息`)
    // 单个单元本身就超过窗口时上面会一个都留不下。留最后一个单元并接受超限，
    // 因为发送截断的调用/结果配对必然被端点拒绝，宁可超窗也要保持配对完整。
    if (result.length === 0) {
      const last = units[units.length - 1] ?? []
      summaries.set(sessionId, `已裁剪 ${messages.length - last.length} 条历史消息`)
      return last
    }
    return result
  }

  return {
    load(sessionId) {
      return sessions.get(sessionId) ?? []
    },
    save(sessionId, messages) {
      sessions.set(sessionId, trim(sessionId, messages))
    },
    append(sessionId, message) {
      const next = [...(sessions.get(sessionId) ?? []), message]
      sessions.set(sessionId, trim(sessionId, next))
    },
    getSummary(sessionId) {
      return summaries.get(sessionId)
    },
  }
}
