import type { ToolDefinition } from './contracts.js'

/** 工具注册表：只接受显式注册的工具，阻止模型调用任意名称。 */
export interface ToolRegistry {
  register(definition: ToolDefinition): void
  /** 注销工具，使后续模型请求不再看到或调用该工具。 */
  unregister(name: string): void
  get(name: string): ToolDefinition | undefined
  /** 枚举已注册工具，供构造发给模型的 tools 声明使用。 */
  list(): ToolDefinition[]
}

/** 内存实现：同名工具后注册会覆盖先注册项，业务方应避免重名。 */
export function createToolRegistry(): ToolRegistry {
  const definitions = new Map<string, ToolDefinition>()
  return {
    register(definition) {
      definitions.set(definition.name, definition)
    },
    unregister(name) {
      definitions.delete(name)
    },
    get(name) {
      return definitions.get(name)
    },
    list() {
      return [...definitions.values()]
    },
  }
}
