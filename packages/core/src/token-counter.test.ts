import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessages, applyUsageCorrection } from './token-counter.js'
import type { SessionMessage } from './contracts.js'

describe('estimateTokens', () => {
  it('英文按字符/4 向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefghijkl')).toBe(3)
  })
  it('中文按字符/4 向上取整', () => {
    expect(estimateTokens('你好世界')).toBe(1)
    expect(estimateTokens('一二三四五六七八')).toBe(2)
  })
})

describe('estimateMessages', () => {
  it('汇总多条消息 JSON 长度', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ]
    expect(estimateMessages(messages)).toBe(Math.ceil(JSON.stringify(messages).length / 4))
  })
})

describe('applyUsageCorrection', () => {
  it('有 usage 时返回 total_tokens', () => {
    expect(applyUsageCorrection(100, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 })).toBe(30)
  })
  it('无 usage 时返回原估值', () => {
    expect(applyUsageCorrection(100, undefined)).toBe(100)
  })
})
