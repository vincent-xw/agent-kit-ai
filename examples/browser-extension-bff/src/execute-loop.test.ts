import { describe, expect, it } from 'vitest'
import { createEventBus } from './event-bus.js'
import { createExecuteLoop } from './execute-loop.js'

function collect(bus: ReturnType<typeof createEventBus>) {
  const events: Array<Record<string, unknown>> = []
  bus.subscribe((e) => events.push({ ...e }))
  return events
}

describe('dispatchResult', () => {
  it('pending_tool_calls emits a tool_call event per call', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult(
      {
        type: 'pending_tool_calls',
        calls: [
          { callId: 'c1', toolName: 'browser_click', input: { ref: 1 } },
          { callId: 'c2', toolName: 'browser_press_key', input: { key: 'Enter' } },
        ],
      },
      'sess-1',
    )

    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'tool_call', callId: 'c1', toolName: 'browser_click', sessionId: 'sess-1' })
    expect(events[1]).toMatchObject({ type: 'tool_call', callId: 'c2', toolName: 'browser_press_key', sessionId: 'sess-1' })
  })

  it('final emits a final event with output and sessionId', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult({ type: 'final', output: '任务完成', reasoning: '思考过程' }, 'sess-2')

    expect(events[0]).toMatchObject({ type: 'final', output: '任务完成', reasoning: '思考过程', sessionId: 'sess-2' })
  })

  it('final without reasoning omits the field', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult({ type: 'final', output: 'done' }, 's-1')

    expect(events[0]!.reasoning).toBeUndefined()
  })

  it('step_done is ignored', () => {
    const bus = createEventBus()
    const loop = createExecuteLoop(bus)
    const events = collect(bus)

    loop.dispatchResult({ type: 'step_done' }, 's-1')

    expect(events).toHaveLength(0)
  })
})
