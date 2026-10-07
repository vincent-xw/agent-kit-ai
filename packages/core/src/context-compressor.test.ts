import { describe, it, expect } from 'vitest'
import { compressMessages } from './context-compressor.js'
import type { SessionMessage } from './contracts.js'

function makeMessages(count: number): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({ role: 'user', content: `question ${i}` })
    out.push({ role: 'assistant', content: `answer ${i}` })
  }
  return out
}

describe('compressMessages', () => {
  it('未超阈值时不压缩', async () => {
    const messages = makeMessages(2)
    const result = await compressMessages(messages, { limit: 1_000_000, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 })
    expect(result.messages).toEqual(messages)
    expect(result.compressedCount).toBe(0)
  })

  it('超阈值时丢弃旧工具轮次', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old a', toolCalls: [{ callId: 'c1', toolName: 't', input: {} }] },
      { role: 'tool', content: 'tool out', callId: 'c1', toolName: 't' },
      { role: 'user', content: 'new q' },
      { role: 'assistant', content: 'new a' },
    ]
    const result = await compressMessages(messages, { limit: 40, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 })
    // 保护区外旧的 assistant + tool 单元被整组移除
    expect(result.messages.some((m) => m.role === 'tool')).toBe(false)
    expect(result.messages.find((m) => m.role === 'assistant' && m.content === 'old a')).toBeUndefined()
    expect(result.messages.find((m) => m.role === 'assistant' && m.content === 'new a')).toBeDefined()
  })

  it('移除旧工具轮次已经降到低水位以下时仍生成包含目标和进度的摘要', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: `目标：完成收货地址填写后核对总价，不要重复提交。${'旧目标上下文 '.repeat(500)}` },
      { role: 'assistant', content: null, toolCalls: [{ callId: 'fill-address', toolName: 'mobile_set_text', input: { field: '收货地址' } }] },
      { role: 'tool', callId: 'fill-address', toolName: 'mobile_set_text', content: `已填写收货地址，订单尚未提交。${'大页面快照 '.repeat(2_000)}` },
      { role: 'user', content: '继续核对订单，不要从头开始。' },
      { role: 'assistant', content: '我会先确认收货地址和总价。' },
    ]

    const result = await compressMessages(messages, {
      limit: 1_000,
      highWatermark: 0.8,
      lowWatermark: 0.5,
      preserveRecentUnits: 2,
    })

    expect(result.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Earlier conversation summary:'),
    })
    expect(result.summary).toContain('不要重复提交')
    expect(result.summary).toContain('已填写收货地址，订单尚未提交')
    expect(result.messages.some((message) => message.role === 'tool')).toBe(false)
  })

  it('丢弃后仍超阈值则摘要旧轮次', async () => {
    let summarizerSessionId: string | undefined
    const summarizer = async (_messages: SessionMessage[], sessionId?: string) => {
      summarizerSessionId = sessionId
      return 'summary'
    }
    const messages: SessionMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
    ]
    const result = await compressMessages(messages, { limit: 60, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 }, summarizer)
    expect(result.messages[0]).toMatchObject({ role: 'system', content: 'Earlier conversation summary: summary' })
    expect(summarizerSessionId).toBeUndefined()

    await compressMessages(messages, { limit: 60, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 }, summarizer, 'session-1')
    expect(summarizerSessionId).toBe('session-1')
  })
})
