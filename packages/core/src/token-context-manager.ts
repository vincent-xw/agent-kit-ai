import type { SessionMessage } from './contracts.js'
import type { ContextManager } from './context-manager.js'
import type { LlmTraceEvent } from './llm-client.js'
import { compressMessages, type CompressResult, type Summarizer } from './context-compressor.js'
import { applyUsageCorrection, estimateMessages } from './token-counter.js'

export interface ContextStatus {
  model: string
  limit: number
  used: number
  remaining: number
  ratio: number
  compressedCount: number
  /** 最近一次 LLM 请求的 prompt 缓存命中/未命中 token（提供方上报时才有）。 */
  cacheHit?: number
  cacheMiss?: number
  lastUpdatedAt?: string
}

export interface TokenContextManagerOptions {
  model: string
  limit: number
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
  summarizer?: Summarizer
}

export interface TokenContextManager extends ContextManager {
  onLlmTrace(event: LlmTraceEvent): void
  getStatus(sessionId: string): ContextStatus
  sync(sessionId: string, messages: SessionMessage[]): void
  forceCompress(sessionId: string, messages: SessionMessage[]): Promise<SessionMessage[]>
  setSummarizer(summarizer: Summarizer): void
  /**
   * 切换当前模型与上下文上限。
   * 就地更新而不是重建实例：会话的压缩计数、裁剪摘要与 usage 校准都存在实例内存里。
   */
  setModel(model: string, limit: number): void
}

interface SessionState {
  raw: SessionMessage[]
  trimmed: SessionMessage[]
  summary?: string
  compressedCount: number
  lastUsageTotal?: number
  lastUsageHit?: number
  lastUsageMiss?: number
  lastUpdatedAt?: string
}

export function createTokenContextManager(options: TokenContextManagerOptions): TokenContextManager {
  const sessions = new Map<string, SessionState>()
  const high = options.highWatermark ?? 0.8
  const low = options.lowWatermark ?? 0.5
  const preserve = options.preserveRecentUnits ?? 2
  // 模型与上限可随全局默认切换：模块内所有读取都走这两个变量。
  let currentModel = options.model
  let currentLimit = options.limit

  function getState(sessionId: string): SessionState {
    return sessions.get(sessionId) ?? { raw: [], trimmed: [], compressedCount: 0 }
  }

  function setState(sessionId: string, state: SessionState) {
    sessions.set(sessionId, state)
  }

  function computeUsed(state: SessionState): number {
    return applyUsageCorrection(estimateMessages(state.trimmed), state.lastUsageTotal ? { total_tokens: state.lastUsageTotal } : undefined)
  }

  function buildStatus(sessionId: string): ContextStatus {
    const state = getState(sessionId)
    const used = computeUsed(state)
    const limit = currentLimit
    const status: ContextStatus = {
      model: currentModel,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      ratio: limit > 0 ? used / limit : 0,
      compressedCount: state.compressedCount,
    }
    if (state.lastUpdatedAt !== undefined) status.lastUpdatedAt = state.lastUpdatedAt
    if (state.lastUsageHit !== undefined) status.cacheHit = state.lastUsageHit
    if (state.lastUsageMiss !== undefined) status.cacheMiss = state.lastUsageMiss
    return status
  }

  async function runCompress(messages: SessionMessage[], sessionId?: string): Promise<CompressResult> {
    return compressMessages(
      messages,
      { limit: currentLimit, highWatermark: high, lowWatermark: low, preserveRecentUnits: preserve },
      options.summarizer,
      sessionId,
    )
  }

  async function saveImpl(sessionId: string, messages: SessionMessage[]): Promise<void> {
    const compressed = await runCompress(messages, sessionId)
    const state: SessionState = {
      ...getState(sessionId),
      raw: messages,
      trimmed: compressed.messages,
      compressedCount: getState(sessionId).compressedCount + (compressed.compressedCount > 0 ? 1 : 0),
      lastUpdatedAt: new Date().toISOString(),
    }
    if (compressed.summary !== undefined) state.summary = compressed.summary
    setState(sessionId, state)
  }

  return {
    async save(sessionId, messages) {
      await saveImpl(sessionId, messages)
    },
    async load(sessionId) {
      return getState(sessionId).trimmed
    },
    async append(sessionId, message) {
      // 直接调用内部 saveImpl，避免依赖 this，方法被解构后仍可用。
      await saveImpl(sessionId, [...getState(sessionId).raw, message])
    },
    async getSummary(sessionId) {
      return getState(sessionId).summary
    },
    onLlmTrace(event) {
      if (!event.sessionId) return
      // 只在 manager 见过该会话时才记录 usage，避免为未知 sessionId 物化幽灵状态。
      if (!sessions.has(event.sessionId)) return
      if (event.totalTokens && event.totalTokens > 0) {
        const state = getState(event.sessionId)
        state.lastUsageTotal = event.totalTokens
        state.lastUpdatedAt = new Date().toISOString()
        if (event.cacheHitTokens !== undefined) state.lastUsageHit = event.cacheHitTokens
        if (event.cacheMissTokens !== undefined) state.lastUsageMiss = event.cacheMissTokens
        setState(event.sessionId, state)
      }
    },
    getStatus(sessionId) {
      return buildStatus(sessionId)
    },
    sync(sessionId, messages) {
      const state = getState(sessionId)
      state.raw = messages
      state.trimmed = messages
      state.lastUpdatedAt = new Date().toISOString()
      setState(sessionId, state)
    },
    async forceCompress(sessionId, messages) {
      const compressed = await runCompress(messages, sessionId)
      const state: SessionState = {
        ...getState(sessionId),
        raw: compressed.messages,
        trimmed: compressed.messages,
        compressedCount: getState(sessionId).compressedCount + (compressed.compressedCount > 0 ? 1 : 0),
        lastUpdatedAt: new Date().toISOString(),
      }
      if (compressed.summary !== undefined) state.summary = compressed.summary
      setState(sessionId, state)
      return compressed.messages
    },
    setSummarizer(summarizer) {
      options.summarizer = summarizer
    },
    setModel(model, limit) {
      currentModel = model
      currentLimit = limit
    },
  }
}
