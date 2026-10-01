import { describe, it, expect } from 'vitest'
import { resolveContextLimit } from './model-context-limits.js'

describe('resolveContextLimit', () => {
  it('内置表命中', () => {
    expect(resolveContextLimit('gpt-4o')).toBe(128_000)
    expect(resolveContextLimit('deepseek-chat')).toBe(64_000)
  })
  it('env 覆盖内置表', () => {
    expect(resolveContextLimit('deepseek-chat', '32000')).toBe(32_000)
  })
  it('未知模型默认 256K', () => {
    expect(resolveContextLimit('unknown-model')).toBe(256_000)
  })
})
