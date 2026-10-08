import type { SessionMessage } from './contracts.js'
import type { ContextManager } from './context-manager.js'
import type { LlmTraceEvent } from './llm-client.js'
import { compressMessages, type CompressResult, type Summarizer } from './context-compressor.js'
import { estimateMessages } from './token-counter.js'

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
  mode?: 'default' | 'fast'
  highWatermark?: number
  lowWatermark?: number
  preserveRecentUnits?: number
  preserveRecentTokens?: number
  minimumRecentMessages?: number
  summarizer?: Summarizer
}

export interface TokenContextManager extends ContextManager {
  onLlmTrace(event: LlmTraceEvent): void
  getStatus(sessionId: string): ContextStatus
  hasSession(sessionId: string): boolean
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
  /** Provider 最近一次成功请求的实际 prompt 用量与本地请求体估算基线。 */
  lastPromptTokens?: number
  lastPromptEstimate?: number
  /** 按 requestId 暂存请求体估算，避免同一 Session 的请求交错时串用校准值。 */
  requestEstimates?: Map<string, number>
  lastUsageHit?: number
  lastUsageMiss?: number
  lastUpdatedAt?: string
}

export function createTokenContextManager(options: TokenContextManagerOptions): TokenContextManager {
  const sessions = new Map<string, SessionState>()
  const high = options.highWatermark ?? 0.9
  const low = options.lowWatermark ?? 0.5
  const mode = options.mode ?? 'default'
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
    return computeUsedForMessages(state, state.trimmed)
  }

  /** 用 Provider 最近一次实际 usage 校准候选消息，并只叠加该请求之后新增的估算量。 */
  function computeUsedForMessages(state: SessionState, messages: SessionMessage[]): number {
    if (state.lastPromptTokens === undefined || state.lastPromptEstimate === undefined) {
      return estimateMessages(messages)
    }
    const appendedEstimate = Math.max(0, estimateMessages(messages) - state.lastPromptEstimate)
    return state.lastPromptTokens + appendedEstimate
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

  async function runCompress(messages: SessionMessage[], sessionId?: string, usedTokens?: number): Promise<CompressResult> {
    return compressMessages(
      messages,
      {
        limit: currentLimit,
        ...(usedTokens !== undefined ? { usedTokens } : {}),
        mode,
        highWatermark: high,
        lowWatermark: low,
        ...(options.preserveRecentUnits !== undefined ? { preserveRecentUnits: options.preserveRecentUnits } : {}),
        ...(options.preserveRecentTokens !== undefined ? { preserveRecentTokens: options.preserveRecentTokens } : {}),
        ...(options.minimumRecentMessages !== undefined ? { minimumRecentMessages: options.minimumRecentMessages } : {}),
      },
      options.summarizer,
      sessionId,
    )
  }

  /** 比较历史前缀，判断本次 SessionStore.save 是追加而非重写或清空。 */
  function isAppendOf(messages: SessionMessage[], previous: SessionMessage[]): boolean {
    if (messages.length < previous.length) return false
    for (let index = 0; index < previous.length; index += 1) {
      if (JSON.stringify(messages[index]) !== JSON.stringify(previous[index])) return false
    }
    return true
  }

  async function saveImpl(sessionId: string, messages: SessionMessage[]): Promise<void> {
    // 调用方可能在本次保存后继续原地追加会话消息；内部基线必须拥有独立数组。
    const snapshot = [...messages]
    const previous = getState(sessionId)
    const incremental = sessions.has(sessionId) && isAppendOf(snapshot, previous.raw)
    const appended = incremental ? snapshot.slice(previous.raw.length) : []
    const projection = incremental ? [...previous.trimmed, ...appended] : snapshot
    const usedTokens = incremental ? computeUsedForMessages(previous, projection) : estimateMessages(projection)
    // 首次进入 Tier 3 时用完整原始历史摘要，避免 Tier 1/2 先裁掉的工具事实永远进不了交接摘要。
    const summaryInputRequired = !previous.summary && usedTokens / currentLimit >= high
    const compressionInput = incremental && summaryInputRequired ? snapshot : projection
    const compressed = await runCompress(compressionInput, sessionId, usedTokens)
    const changedProjection = compressed.compressedCount > 0
    const state: SessionState = {
      ...previous,
      raw: snapshot,
      trimmed: [...compressed.messages],
      compressedCount: previous.compressedCount + (changedProjection ? 1 : 0),
      lastUpdatedAt: new Date().toISOString(),
    }
    if (!incremental) {
      delete state.summary
      delete state.lastPromptTokens
      delete state.lastPromptEstimate
      delete state.lastUsageHit
      delete state.lastUsageMiss
    }
    if (changedProjection) {
      delete state.lastPromptTokens
      delete state.lastPromptEstimate
    }
    if (compressed.summary !== undefined) state.summary = compressed.summary
    setState(sessionId, state)
  }

  return {
    async save(sessionId, messages) {
      await saveImpl(sessionId, messages)
    },
    async load(sessionId) {
      // 不把内部 projection 数组交给调用方，避免原地追加污染后续压缩基线。
      return [...getState(sessionId).trimmed]
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
      const state = getState(event.sessionId)
      if (event.phase === 'request') {
        const requestMessages = event.body?.messages
        // 记录实际发往 Provider 的消息估算，包含尚未写入 SessionStore 的本轮用户输入。
        if (Array.isArray(requestMessages)) {
          const requestEstimates = state.requestEstimates ?? new Map<string, number>()
          requestEstimates.set(event.requestId, estimateMessages(requestMessages as SessionMessage[]))
          state.requestEstimates = requestEstimates
        }
        setState(event.sessionId, state)
        return
      }
      if (event.phase === 'error') {
        state.requestEstimates?.delete(event.requestId)
        if (state.requestEstimates?.size === 0) delete state.requestEstimates
        setState(event.sessionId, state)
        return
      }
      const promptTokens = event.promptTokens && event.promptTokens > 0
        ? event.promptTokens
        : event.totalTokens && event.totalTokens > 0
          ? event.totalTokens
          : undefined
      const requestEstimate = state.requestEstimates?.get(event.requestId) ?? estimateMessages(state.trimmed)
      state.requestEstimates?.delete(event.requestId)
      if (state.requestEstimates?.size === 0) delete state.requestEstimates
      if (promptTokens !== undefined) {
        // 以对应 requestId 的请求体估算为基线，后续只增加该请求之后的新消息。
        state.lastPromptTokens = promptTokens
        state.lastPromptEstimate = requestEstimate
        state.lastUpdatedAt = new Date().toISOString()
        if (event.cacheHitTokens !== undefined) state.lastUsageHit = event.cacheHitTokens
        if (event.cacheMissTokens !== undefined) state.lastUsageMiss = event.cacheMissTokens
        setState(event.sessionId, state)
      } else {
        setState(event.sessionId, state)
      }
    },
    getStatus(sessionId) {
      return buildStatus(sessionId)
    },
    hasSession(sessionId) {
      return sessions.has(sessionId)
    },
    sync(sessionId, messages) {
      const previous = getState(sessionId)
      const state: SessionState = {
        raw: [...messages],
        trimmed: [...messages],
        compressedCount: previous.compressedCount,
        lastUpdatedAt: new Date().toISOString(),
      }
      setState(sessionId, state)
    },
    async forceCompress(sessionId, messages) {
      const snapshot = [...messages]
      const originalUsage = estimateMessages(snapshot)
      // 手动压缩以当前估算用量为基准压到一半，不受模型自动压缩水位影响。
      const compressed = await compressMessages(
        snapshot,
        {
          limit: Math.max(1, originalUsage),
          mode: 'default',
          highWatermark: 0,
          lowWatermark: low,
          ...(options.preserveRecentUnits !== undefined ? { preserveRecentUnits: options.preserveRecentUnits } : {}),
          preserveRecentTokens: options.preserveRecentTokens ?? Math.min(30_000, Math.floor(originalUsage * low)),
          ...(options.minimumRecentMessages !== undefined ? { minimumRecentMessages: options.minimumRecentMessages } : {}),
        },
        options.summarizer,
        sessionId,
      )
      const compressedUsage = estimateMessages(compressed.messages)
      const didCompress = compressed.compressedCount > 0 && compressedUsage < originalUsage
      const nextMessages = didCompress ? compressed.messages : snapshot
      const state: SessionState = {
        raw: snapshot,
        trimmed: [...nextMessages],
        compressedCount: getState(sessionId).compressedCount + (didCompress ? 1 : 0),
        lastUpdatedAt: new Date().toISOString(),
      }
      if (didCompress) {
        // 手动压缩后用压缩 projection 估算用量，避免继续显示压缩前的 Provider usage。
        if (compressed.summary !== undefined) state.summary = compressed.summary
      } else {
        // 压缩没有降低估算用量时不保留旧 projection 或旧 usage 校准。
        delete state.lastPromptTokens
        delete state.lastPromptEstimate
        delete state.lastUsageHit
        delete state.lastUsageMiss
      }
      setState(sessionId, state)
      return [...state.trimmed]
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
