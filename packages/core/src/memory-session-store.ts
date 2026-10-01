import type { SessionMessage, SessionStore } from './contracts.js'

/** 内存会话存储，仅用于测试与无持久化场景；生产环境由适配器实现替换。 */
export function createMemorySessionStore(): SessionStore {
  const sessions = new Map<string, SessionMessage[]>()
  return {
    load(sessionId) {
      return sessions.get(sessionId) ?? []
    },
    save(sessionId, messages) {
      sessions.set(sessionId, messages)
    },
  }
}
