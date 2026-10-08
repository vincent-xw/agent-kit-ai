import { describe, it, expect } from 'vitest'
import { createTokenContextManager } from './token-context-manager.js'
import type { SessionMessage } from './contracts.js'
import { estimateMessages } from './token-counter.js'

function makeLongMessages(n: number): SessionMessage[] {
  const out: SessionMessage[] = []
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', content: 'q '.repeat(100) })
    out.push({ role: 'assistant', content: 'a '.repeat(100) })
  }
  return out
}

describe('createTokenContextManager', () => {
  it('未超阈值时 load 返回原消息', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000 })
    const messages = makeLongMessages(2)
    await cm.save('s1', messages)
    expect(await cm.load('s1')).toEqual(messages)
    const status = cm.getStatus('s1')
    expect(status.ratio).toBeLessThan(0.1)
  })

  it('超阈值自动压缩', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 200, highWatermark: 0.8, lowWatermark: 0.5 })
    await cm.save('s1', makeLongMessages(10))
    const loaded = await cm.load('s1')
    expect(loaded.length).toBeLessThan(20)
    expect(cm.getStatus('s1').compressedCount).toBeGreaterThan(0)
  })

  it('setModel 更新模型与阈值，同时保留已压缩状态', async () => {
    const cm = createTokenContextManager({ model: 'model-a', limit: 200, highWatermark: 0.8, lowWatermark: 0.5 })
    await cm.save('s1', makeLongMessages(10))
    const before = cm.getStatus('s1')
    expect(before.compressedCount).toBeGreaterThan(0)

    cm.setModel('model-b', 1_000_000)
    const after = cm.getStatus('s1')
    expect(after.model).toBe('model-b')
    expect(after.limit).toBe(1_000_000)
    // 重建实例会丢失压缩计数与摘要，因此切换必须是就地更新。
    expect(after.compressedCount).toBe(before.compressedCount)
    expect(cm.getSummary('s1')).toBeDefined()
  })

  it('onLlmTrace 用 usage 校准 used', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000 })
    await cm.save('s1', [{ role: 'user', content: 'hi' }])
    cm.onLlmTrace({ requestId: 'r1', phase: 'response', durationMs: 1, sessionId: 's1', totalTokens: 42 })
    expect(cm.getStatus('s1').used).toBe(42)
  })

  it('手动压缩会绕过自动水位并压缩低于 80% 的历史', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000, highWatermark: 0.8, lowWatermark: 0.5 })
    const original = makeLongMessages(10)
    const compressed = await cm.forceCompress('s1', original)
    expect(compressed.length).toBeLessThan(original.length)
  })

  it('手动压缩后不再用压缩前的 Provider usage 覆盖新估算值', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000 })
    const original = makeLongMessages(10)
    await cm.save('s1', original)
    cm.onLlmTrace({ requestId: 'r1', phase: 'response', durationMs: 1, sessionId: 's1', totalTokens: 900_000 })

    const compressed = await cm.forceCompress('s1', original)

    expect(compressed.length).toBeLessThan(original.length)
    expect(cm.getStatus('s1').used).toBeLessThan(900_000)
  })

  it('手动压缩后追加新消息沿用压缩 projection，不重新摘要完整历史', async () => {
    const summaries: SessionMessage[][] = []
    const cm = createTokenContextManager({
      model: 'm',
      limit: Math.floor(estimateMessages(makeLongMessages(10)) * 0.95),
      summarizer: async (messages) => {
        summaries.push(messages)
        return '保留了原任务与当前进度。'
      },
    })
    const original = makeLongMessages(10)
    await cm.forceCompress('s1', original)
    const projection = await cm.load('s1')

    await cm.save('s1', [...original, { role: 'user', content: '继续刚才的任务。' }])

    expect(summaries).toHaveLength(1)
    expect(await cm.load('s1')).toContainEqual({ role: 'user', content: '继续刚才的任务。' })
    expect((await cm.load('s1')).length).toBeGreaterThanOrEqual(projection.length)
  })

  it('sync 会保留恢复历史的快照，不受调用方后续追加影响', async () => {
    const messages: SessionMessage[] = [{ role: 'user', content: '恢复历史' }]
    const cm = createTokenContextManager({ model: 'm', limit: 100_000 })
    cm.sync('s1', messages)

    messages.push({ role: 'assistant', content: '后续新消息' })

    expect(await cm.load('s1')).toEqual([{ role: 'user', content: '恢复历史' }])
  })

  it('load 返回的数组不能被调用方原地追加污染内部 projection', async () => {
    const messages: SessionMessage[] = [{ role: 'user', content: '历史消息' }]
    const original = [...messages]
    const cm = createTokenContextManager({ model: 'm', limit: 100_000 })
    cm.sync('s1', messages)

    const loaded = await cm.load('s1')
    loaded.push({ role: 'assistant', content: '只属于调用方的消息' })

    expect(await cm.load('s1')).toEqual(original)
  })

  it('forceCompress 后调用方追加到原始历史仍会被后续 save 识别', async () => {
    const messages = makeLongMessages(10)
    const cm = createTokenContextManager({ model: 'm', limit: 1_000_000 })
    await cm.forceCompress('s1', messages)

    const nextMessage: SessionMessage = { role: 'user', content: '手动压缩后的新消息' }
    messages.push(nextMessage)
    await cm.save('s1', messages)

    expect(await cm.load('s1')).toContainEqual(nextMessage)
  })

  it('Provider prompt usage 校准后，新增消息按增量更新上下文用量', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 100_000 })
    const history: SessionMessage[] = [{ role: 'user', content: '已有历史' }]
    const currentInput: SessionMessage = { role: 'user', content: '本轮输入' }
    const assistantOutput: SessionMessage = { role: 'assistant', content: '新回复' }
    const requestMessages = [...history, currentInput]
    await cm.save('s1', history)
    cm.onLlmTrace({
      requestId: 'r1', phase: 'request', durationMs: 0, sessionId: 's1', body: { messages: requestMessages },
    })
    cm.onLlmTrace({ requestId: 'r1', phase: 'response', durationMs: 1, sessionId: 's1', promptTokens: 1_000 })
    expect(cm.getStatus('s1').used).toBe(1_000)

    await cm.save('s1', [...requestMessages, assistantOutput])

    expect(cm.getStatus('s1').used).toBe(1_000 + estimateMessages([assistantOutput]))
  })

  it('Provider 校准用量达到水位时，即使本地估算偏低也会在下一次请求前摘要', async () => {
    const summarizedInputs: SessionMessage[][] = []
    const history: SessionMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `历史事实 ${index} ${'x'.repeat(3_900)}`,
    }))
    const nextUserMessage: SessionMessage = { role: 'user', content: '继续任务' }
    const nextAssistantMessage: SessionMessage = { role: 'assistant', content: 'a'.repeat(400) }
    const requestMessages = [...history, nextUserMessage]
    const cm = createTokenContextManager({
      model: 'm',
      limit: 10_000,
      highWatermark: 0.9,
      lowWatermark: 0.5,
      summarizer: async (messages) => {
        summarizedInputs.push(messages)
        return '保留了已完成步骤和当前进度。'
      },
    })
    await cm.save('s1', history)
    cm.onLlmTrace({
      requestId: 'r1', phase: 'request', durationMs: 0, sessionId: 's1', body: { messages: requestMessages },
    })
    cm.onLlmTrace({ requestId: 'r1', phase: 'response', durationMs: 1, sessionId: 's1', promptTokens: 9_700 })
    expect(cm.getStatus('s1').used).toBeGreaterThan(9_000)

    await cm.save('s1', [...requestMessages, nextAssistantMessage])

    expect(estimateMessages([...requestMessages, nextAssistantMessage])).toBeLessThan(9_000)
    expect(summarizedInputs).toHaveLength(1)
    expect(summarizedInputs[0]).toEqual([...requestMessages, nextAssistantMessage])
    expect(await cm.getSummary('s1')).toBe('保留了已完成步骤和当前进度。')
  })

  it('高用量自动压缩后仍保留下一次工具调用与结果', async () => {
    const history: SessionMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `历史消息 ${index} ${'x'.repeat(1_000)}`,
    }))
    const liveHistory = [...history]
    const cm = createTokenContextManager({
      model: 'm', limit: Math.floor(estimateMessages(history) / 2), highWatermark: 0.8, lowWatermark: 0.2,
      preserveRecentTokens: 100,
      summarizer: async () => '保留任务状态。',
    })
    await cm.save('s1', liveHistory)
    const projection = await cm.load('s1')
    expect(projection.some((message) => message.role === 'system' && String(message.content).includes('Earlier conversation summary:'))).toBe(true)
    cm.onLlmTrace({ requestId: 'compressed-request', phase: 'request', durationMs: 0, sessionId: 's1', body: { messages: projection } })
    cm.onLlmTrace({ requestId: 'compressed-request', phase: 'response', durationMs: 1, sessionId: 's1', promptTokens: 4_500 })

    const assistant: SessionMessage = {
      role: 'assistant', content: null,
      toolCalls: [{ callId: 'new-after-compression', toolName: 'update_todo', input: { action: 'finish' } }],
    }
    const tool: SessionMessage = {
      role: 'tool', callId: 'new-after-compression', toolName: 'update_todo', content: { ok: true, ended: 'completed' },
    }
    liveHistory.push({ role: 'user', content: '继续' }, assistant, tool)
    await cm.save('s1', liveHistory)

    const nextProjection = await cm.load('s1')
    expect(nextProjection).toContainEqual(expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ callId: 'new-after-compression' })] }))
    expect(nextProjection).toContainEqual(expect.objectContaining({ role: 'tool', callId: 'new-after-compression' }))
  })

  it('同一 Session 请求交错时按 requestId 使用对应的 prompt 估算基线', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 100_000 })
    const history: SessionMessage[] = [{ role: 'user', content: '已有历史' }]
    const firstInput: SessionMessage = { role: 'user', content: `第一条输入 ${'a'.repeat(400)}` }
    const secondInput: SessionMessage = { role: 'user', content: '第二条输入' }
    const assistantOutput: SessionMessage = { role: 'assistant', content: '第一条回复' }
    const firstRequest = [...history, firstInput]
    await cm.save('s1', history)
    cm.onLlmTrace({
      requestId: 'r1', phase: 'request', durationMs: 0, sessionId: 's1', body: { messages: firstRequest },
    })
    cm.onLlmTrace({
      requestId: 'r2', phase: 'request', durationMs: 0, sessionId: 's1', body: { messages: [...history, secondInput] },
    })
    cm.onLlmTrace({ requestId: 'r1', phase: 'response', durationMs: 1, sessionId: 's1', promptTokens: 1_000 })

    await cm.save('s1', [...firstRequest, assistantOutput])

    expect(cm.getStatus('s1').used).toBe(1_000 + estimateMessages([assistantOutput]))
  })
})
