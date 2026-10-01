import { describe, it, expect } from 'vitest'
import { createTokenContextManager } from './token-context-manager.js'
import type { SessionMessage } from './contracts.js'

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

  it('forceCompress 返回压缩后的消息', async () => {
    const cm = createTokenContextManager({ model: 'm', limit: 200, highWatermark: 0.8, lowWatermark: 0.5 })
    const original = makeLongMessages(10)
    const compressed = await cm.forceCompress('s1', original)
    expect(compressed.length).toBeLessThan(original.length)
  })
})
