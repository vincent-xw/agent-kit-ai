import { describe, expect, it } from 'vitest'
import { createToolRegistry } from './tool-registry.js'

describe('ToolRegistry', () => {
  it('注销工具后不再出现在列表且不能被获取', () => {
    const registry = createToolRegistry()
    const definition = { name: 'optional_tool', execution: 'server' as const, input: {} as never, output: {} as never }
    registry.register(definition)

    registry.unregister('optional_tool')

    expect(registry.get('optional_tool')).toBeUndefined()
    expect(registry.list()).toEqual([])
  })
})
