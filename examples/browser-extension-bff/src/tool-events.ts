import type { LlmTraceEvent } from '@agentkit-ai/core'
import type { EventBus } from './event-bus.js'

/**
 * 把 LlmTraceEvent 转成只含摘要的事件推给 bus。
 * 绝不推 body 与 responseBody：前者含 system prompt 全文与会话消息，
 * 后者是模型原文，二者都属敏感内容。
 */
export function llmTraceToBus(bus: EventBus): (event: LlmTraceEvent) => void {
  return (event) => {
    if (event.phase === 'request') {
      const body = (event.body ?? {}) as { model?: unknown; messages?: unknown; tools?: unknown }
      bus.emit({
        type: 'llm_request',
        model: typeof body.model === 'string' ? body.model : 'unknown',
        messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      })
      return
    }
    if (event.phase === 'response') {
      const choices = (event.responseBody as { choices?: unknown } | undefined)?.choices
      const first = Array.isArray(choices)
        ? (choices[0] as { finish_reason?: unknown; message?: { tool_calls?: unknown } } | undefined)
        : undefined
      bus.emit({
        type: 'llm_response',
        durationMs: event.durationMs,
        finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : 'unknown',
        toolCallCount: Array.isArray(first?.message?.tool_calls) ? first.message!.tool_calls!.length : 0,
      })
      return
    }
    bus.emit({
      type: 'llm_error',
      durationMs: event.durationMs,
      error: event.error instanceof Error ? event.error.message : String(event.error),
    })
  }
}
