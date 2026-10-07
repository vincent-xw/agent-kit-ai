import { describe, it, expect } from 'vitest'
import { compressMessages } from './context-compressor.js'
import type { SessionMessage } from './contracts.js'
import { estimateMessages } from './token-counter.js'

function makeMessages(count: number): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({ role: 'user', content: `question ${i}` })
    out.push({ role: 'assistant', content: `answer ${i}` })
  }
  return out
}

function makeToolHistory(callCount: number, outputLength = 300): SessionMessage[] {
  const messages: SessionMessage[] = [{ role: 'user', content: '目标：完成所有步骤并保留已确认的进度。' }]
  for (let index = 0; index < callCount; index += 1) {
    const callId = `call-${index}`
    messages.push({
      role: 'assistant',
      content: `工具调用前的说明 ${index}`,
      toolCalls: [{ callId, toolName: 'read_state', input: { index } }],
    })
    messages.push({ role: 'tool', callId, toolName: 'read_state', content: `结果 ${index} ${'x'.repeat(outputLength)}` })
    messages.push({ role: 'assistant', content: `已核对步骤 ${index}` })
  }
  return messages
}

function limitAtRatio(messages: SessionMessage[], ratio: number): number {
  return Math.floor(estimateMessages(messages) / ratio)
}

describe('compressMessages', () => {
  it('未超阈值时不压缩', async () => {
    const messages = makeMessages(2)
    const result = await compressMessages(messages, { limit: 1_000_000, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 })
    expect(result.messages).toEqual(messages)
    expect(result.compressedCount).toBe(0)
  })

  it('摘要压缩时保留最近完整工具轮次和最近对话', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'old q' },
      { role: 'assistant', content: 'old a', toolCalls: [{ callId: 'c1', toolName: 't', input: {} }] },
      { role: 'tool', content: 'tool out', callId: 'c1', toolName: 't' },
      { role: 'user', content: 'new q' },
      { role: 'assistant', content: 'new a' },
    ]
    const result = await compressMessages(messages, { limit: 40, highWatermark: 0.8, lowWatermark: 0.5, preserveRecentUnits: 2 })
    // Tool Call 与 Result 按 callId 成对保留；旧目标会进入摘要，近期对话继续留在模型上下文。
    expect(result.summary).toBeDefined()
    expect(result.messages.some((m) => m.role === 'tool' && m.callId === 'c1')).toBe(true)
    expect(result.messages.some((m) => m.role === 'assistant' && m.content === 'old a')).toBe(true)
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
    expect(result.messages.some((message) => message.role === 'tool' && message.callId === 'fill-address')).toBe(true)
    expect(result.messages.some((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.callId === 'fill-address'))).toBe(true)
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

  it('default 模式在 90% 前保留完整工具历史', async () => {
    const messages = makeToolHistory(24)
    const result = await compressMessages(messages, {
      limit: limitAtRatio(messages, 0.85),
      mode: 'default',
    })

    expect(result.messages).toEqual(messages)
    expect(result.compressedCount).toBe(0)
  })

  it('fast 模式在 50% 只保留最近 20 个完整工具调用且保留对话正文', async () => {
    const messages = makeToolHistory(24)
    const result = await compressMessages(messages, {
      limit: limitAtRatio(messages, 0.6),
      mode: 'fast',
    })

    const retainedCalls = result.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    const retainedResults = result.messages.filter((message) => message.role === 'tool')
    expect(retainedCalls.map((call) => call.callId)).toEqual(Array.from({ length: 20 }, (_, index) => `call-${index + 4}`))
    expect(retainedResults.map((message) => message.callId)).toEqual(retainedCalls.map((call) => call.callId))
    expect(result.messages.find((message) => message.role === 'assistant' && message.content === '工具调用前的说明 0')).toBeDefined()
    expect(result.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls ?? [] : []).some((call) => call.callId === 'call-0')).toBe(false)
    expect(result.messages.some((message) => message.role === 'user' && message.content === '目标：完成所有步骤并保留已确认的进度。')).toBe(true)
    expect(result.summary).toBeUndefined()
  })

  it('fast 模式在 80% 只保留最近 10 个完整工具调用', async () => {
    const messages = makeToolHistory(24)
    const result = await compressMessages(messages, {
      limit: limitAtRatio(messages, 0.85),
      mode: 'fast',
    })

    const retainedCalls = result.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    expect(retainedCalls.map((call) => call.callId)).toEqual(Array.from({ length: 10 }, (_, index) => `call-${index + 14}`))
  })

  it('90% 时生成 handoff 摘要并保留最近三条消息', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: '原始目标：提交前核对金额，不能重复提交。' },
      ...makeToolHistory(12, 500),
      { role: 'user', content: '继续刚才的任务。' },
      { role: 'assistant', content: '我会先核对金额。' },
      { role: 'user', content: '不要从头开始。' },
    ]
    const original = structuredClone(messages)
    let summarized: SessionMessage[] = []
    const result = await compressMessages(messages, {
      limit: limitAtRatio(messages, 0.95),
      mode: 'default',
      preserveRecentTokens: 100,
      minimumRecentMessages: 3,
    }, async (olderMessages) => {
      summarized = olderMessages
      return '任务交接：已读取页面，下一步核对金额。'
    })

    expect(result.summary).toContain('任务交接')
    expect(summarized.some((message) => message.role === 'user' && String(message.content).includes('原始目标'))).toBe(true)
    expect(result.messages.slice(-3)).toEqual(messages.slice(-3))
    expect(result.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('任务交接') })
    expect(messages).toEqual(original)
  })

  it('Tier 3 默认保留约三万 token 的最近上下文', async () => {
    const messages: SessionMessage[] = Array.from({ length: 80 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `历史消息 ${index} ${'x'.repeat(3_900)}`,
    }))
    const result = await compressMessages(messages, { limit: limitAtRatio(messages, 0.95), mode: 'default' })
    const retainedContext = result.messages.filter((message) => message.role !== 'system')
    const retainedTokens = estimateMessages(retainedContext)

    expect(result.summary).toBeDefined()
    expect(retainedTokens).toBeGreaterThanOrEqual(30_000)
    expect(retainedTokens).toBeLessThan(31_000)
  })

  it('摘要服务失败时本地摘要仍保留最初目标和近期进度', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: '原始目标：完成地址填写后核对金额，不能重复提交。' },
      ...makeMessages(20),
      { role: 'assistant', content: '已填写地址，正在核对金额。' },
    ]
    const result = await compressMessages(messages, { limit: limitAtRatio(messages, 0.95) }, async () => {
      throw new Error('summary unavailable')
    })

    expect(result.summary).toContain('原始目标：完成地址填写后核对金额')
    expect(result.summary).toContain('已填写地址，正在核对金额')
  })

  it('Tier 3 保留普通 System 消息和最近的图片消息', async () => {
    const systemMessage: SessionMessage = { role: 'system', content: '遵守用户确认的操作范围。' }
    const imageMessage: SessionMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    }
    const messages = [systemMessage, ...makeMessages(20), imageMessage]
    const result = await compressMessages(messages, { limit: limitAtRatio(messages, 0.95) })

    expect(result.messages).toContainEqual(systemMessage)
    expect(result.messages).toContainEqual(imageMessage)
  })

  it('Tier 1 不裁剪尚未收到结果的工具调用', async () => {
    const messages = makeToolHistory(22)
    messages.push({ role: 'assistant', content: null, toolCalls: [{ callId: 'pending-call', toolName: 'wait_for_result', input: {} }] })
    const result = await compressMessages(messages, {
      limit: limitAtRatio(messages, 0.6),
      mode: 'fast',
    })

    const retainedCalls = result.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    expect(retainedCalls.some((call) => call.callId === 'pending-call')).toBe(true)
  })

  it('裁剪批量工具调用时按 callId 成对保留结果，并保留助手正文', async () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: '批量操作' },
      {
        role: 'assistant',
        content: '先读取三个页面。',
        toolCalls: [
          { callId: 'batch-1', toolName: 'snapshot', input: {} },
          { callId: 'batch-2', toolName: 'snapshot', input: {} },
          { callId: 'batch-3', toolName: 'snapshot', input: {} },
        ],
      },
      ...['batch-1', 'batch-2', 'batch-3'].map((callId) => ({ role: 'tool' as const, callId, toolName: 'snapshot', content: '页面结果' })),
      ...makeToolHistory(19).slice(1),
    ]
    const result = await compressMessages(messages, { limit: limitAtRatio(messages, 0.6), mode: 'fast' })

    const retainedCalls = result.messages.flatMap((message) => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    const retainedResults = result.messages.filter((message) => message.role === 'tool')
    expect(result.messages[1]).toMatchObject({ role: 'assistant', content: '先读取三个页面。' })
    expect(retainedCalls.some((call) => call.callId === 'batch-3')).toBe(true)
    expect(retainedResults.some((message) => message.callId === 'batch-3')).toBe(true)
    expect(retainedCalls.map((call) => call.callId)).toEqual(retainedResults.map((message) => message.callId))
  })
})
