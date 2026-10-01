import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'
import { llmTraceToBus } from './tool-events.js'

function collect(bus: ReturnType<typeof createEventBus>) {
  const events: Array<Record<string, unknown>> = []
  bus.subscribe((e) => events.push({ ...e }))
  return events
}

describe('llmTraceToBus', () => {
  it('request phase emits llm_request with summary only', () => {
    const bus = createEventBus()
    const trace = llmTraceToBus(bus)
    const events = collect(bus)

    trace({
      requestId: 'req-1',
      phase: 'request',
      durationMs: 0,
      body: {
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: '绝密提示词' }, { role: 'user', content: '你好' }],
        tools: [{ name: 't1' }],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('llm_request')
    expect(events[0]!.model).toBe('deepseek-chat')
    expect(events[0]!.messageCount).toBe(2)
    expect(events[0]!.toolCount).toBe(1)
    expect(JSON.stringify(events[0])).not.toContain('绝密提示词')
  })

  it('response phase emits llm_response with summary only', () => {
    const bus = createEventBus()
    const trace = llmTraceToBus(bus)
    const events = collect(bus)

    trace({
      requestId: 'req-2',
      phase: 'response',
      durationMs: 1200,
      responseBody: {
        choices: [{ message: { content: '模型完整回复' }, finish_reason: 'tool_calls' }],
      },
    })

    expect(events[0]!.type).toBe('llm_response')
    expect(events[0]!.durationMs).toBe(1200)
    expect(events[0]!.finishReason).toBe('tool_calls')
    expect(JSON.stringify(events[0])).not.toContain('模型完整回复')
  })

  it('error phase emits llm_error', () => {
    const bus = createEventBus()
    const trace = llmTraceToBus(bus)
    const events = collect(bus)

    trace({
      requestId: 'req-3',
      phase: 'error',
      durationMs: 500,
      error: new Error('超时'),
    })

    expect(events[0]!.type).toBe('llm_error')
    expect(String(events[0]!.error)).toContain('超时')
  })
})
