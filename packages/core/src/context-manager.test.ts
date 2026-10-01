import { describe, expect, it } from 'vitest'

import { createContextManager } from './index.js'
import type { SessionMessage } from './index.js'

/** 构造一次工具往返：assistant 发起调用 + 对应的 tool 结果。 */
function toolRound(callId: string): SessionMessage[] {
  return [
    { role: 'assistant', content: null, toolCalls: [{ callId, toolName: 'browser_click', input: {} }] },
    { role: 'tool', content: { ok: true }, callId },
  ]
}

/** 找出没有对应 assistant 调用的 tool 消息。真实 OpenAI 端点会以 400 拒绝这些。 */
function orphanToolMessages(messages: SessionMessage[]): SessionMessage[] {
  const declared = new Set(
    messages.flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.callId) : [])),
  )
  return messages.filter((message) => message.role === 'tool' && !declared.has(message.callId))
}

/** 找出声明了调用但结果被裁掉的 assistant 消息。 */
function unresolvedCalls(messages: SessionMessage[]): string[] {
  const filled = new Set(messages.filter((message) => message.role === 'tool').map((message) => (message as { callId: string }).callId))
  return messages
    .flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []))
    .filter((call) => !filled.has(call.callId))
    .map((call) => call.callId)
}

describe('ContextManager', () => {
  it('保存与追加消息', () => {
    const manager = createContextManager({ maxMessages: 5 })
    manager.save('s-1', [{ role: 'user', content: '你好' }])
    manager.append('s-1', { role: 'tool', content: { ok: true }, callId: 'call-1' })
    expect(manager.load('s-1')).toHaveLength(2)
  })

  it('超过窗口时裁剪最旧消息并记录摘要', () => {
    const manager = createContextManager({ maxMessages: 3 })
    manager.save('s-1', [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
      { role: 'user', content: '4' },
    ])
    const loaded = manager.load('s-1')
    expect(loaded).toHaveLength(3)
    expect(loaded[0]).toEqual({ role: 'user', content: '2' })
    expect(manager.getSummary('s-1')).toBe('已裁剪 1 条历史消息')
  })

  it('未发生裁剪时摘要为空', () => {
    const manager = createContextManager({ maxMessages: 5 })
    manager.save('s-1', [{ role: 'user', content: '1' }])
    expect(manager.getSummary('s-1')).toBeUndefined()
  })
})

describe('裁剪不得切断 assistant/tool 配对', () => {
  it('裁剪点落在配对中间时不产生孤立 tool 消息', () => {
    // 朴素的 slice(-1) 会只留下 tool 消息，其 tool_call_id 找不到对应调用 → 端点 400。
    const manager = createContextManager({ maxMessages: 1 })
    manager.save('s-1', [{ role: 'user', content: '指令' }, ...toolRound('c1')])
    expect(orphanToolMessages(manager.load('s-1'))).toHaveLength(0)
  })

  it('裁剪点落在配对中间时不留下无结果的调用', () => {
    const manager = createContextManager({ maxMessages: 2 })
    manager.save('s-1', [...toolRound('c1'), { role: 'user', content: '下一条指令' }])
    expect(unresolvedCalls(manager.load('s-1'))).toHaveLength(0)
  })

  it('单元本身超过窗口时保持配对完整而非截断', () => {
    // 宁可超窗也要保持配对：截断的配对必然被端点拒绝，超窗只是多花 token。
    const manager = createContextManager({ maxMessages: 1 })
    manager.save('s-1', toolRound('c1'))
    const loaded = manager.load('s-1')
    expect(orphanToolMessages(loaded)).toHaveLength(0)
    expect(unresolvedCalls(loaded)).toHaveLength(0)
  })

  it('一次 assistant 的多个并行调用同去同留', () => {
    const manager = createContextManager({ maxMessages: 2 })
    manager.save('s-1', [
      { role: 'user', content: '并行' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { callId: 'c1', toolName: 'a', input: {} },
          { callId: 'c2', toolName: 'b', input: {} },
        ],
      },
      { role: 'tool', content: { ok: true }, callId: 'c1' },
      { role: 'tool', content: { ok: true }, callId: 'c2' },
    ])
    const loaded = manager.load('s-1')
    expect(orphanToolMessages(loaded)).toHaveLength(0)
    expect(unresolvedCalls(loaded)).toHaveLength(0)
  })

  it('多轮工具往返只丢弃最旧的完整单元', () => {
    const manager = createContextManager({ maxMessages: 4 })
    manager.save('s-1', [...toolRound('c1'), ...toolRound('c2'), ...toolRound('c3')])
    const loaded = manager.load('s-1')
    expect(orphanToolMessages(loaded)).toHaveLength(0)
    expect(unresolvedCalls(loaded)).toHaveLength(0)
    // 最新的两轮应完整保留。
    expect(loaded.filter((message) => message.role === 'tool').map((message) => (message as { callId: string }).callId)).toEqual(['c2', 'c3'])
  })

  it('不带工具调用的 assistant 消息可独立裁剪', () => {
    const manager = createContextManager({ maxMessages: 2 })
    manager.save('s-1', [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好啊' },
      { role: 'user', content: '再见' },
    ])
    expect(manager.load('s-1')).toHaveLength(2)
  })
})
