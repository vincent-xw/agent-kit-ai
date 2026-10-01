import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createPromptRegistry } from './index.js'

describe('PromptRegistry', () => {
  it('以 name@version 注册并可查询', () => {
    const registry = createPromptRegistry()
    registry.register({ name: 'default', version: '1', prompt: '你是助手', protocol: z.object({ answer: z.string() }) })
    expect(registry.get('default', '1')?.prompt).toBe('你是助手')
    expect(registry.get('default', '2')).toBeUndefined()
  })

  it('首个注册作为默认提示词', () => {
    const registry = createPromptRegistry()
    registry.register({ name: 'a', version: '1', prompt: 'A' })
    registry.register({ name: 'b', version: '1', prompt: 'B' })
    expect(registry.getDefault()?.prompt).toBe('A')
  })

  it('同名同版本重复注册报错', () => {
    const registry = createPromptRegistry()
    registry.register({ name: 'default', version: '1', prompt: 'A' })
    expect(() => registry.register({ name: 'default', version: '1', prompt: 'B' })).toThrowError(/已注册/)
  })
})
