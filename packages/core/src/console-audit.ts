import type { AuditEvent, AuditLogger } from './contracts.js'
import type { LlmTraceEvent } from './llm-client.js'

/**
 * 控制台审计日志。
 *
 * `AuditLogger` 接口一直存在、harness 也一直在调，但此前没有任何实现被注入 ——
 * 结果是服务端完全没有可观测性，一个 LLM 400 只能看到扩展侧一句「LLM 返回 HTTP 400」。
 *
 * 红线（与 docs/security.md 一致）：不记录密钥、Prompt 正文、模型原文与业务上下文。
 * 只记 requestId、模型、耗时、HTTP 状态、工具名与错误码 —— 这些足够定位问题，
 * 又不会把业务数据写进日志文件。
 */

export interface ConsoleAuditOptions {
  /** 是否输出。默认开启；设为 false 可完全静音。 */
  enabled?: boolean
  /** 日志前缀，便于在混合输出里筛选。 */
  prefix?: string
  /** 输出目标，默认 console。测试时可注入。 */
  sink?: { log(message: string): void; error(message: string): void }
}

/** 把审计事件格式化为单行文本。字段缺失时省略而不是打印 undefined。 */
function formatEvent(event: AuditEvent): string {
  const parts = [`ts=${new Date().toISOString()}`, `req=${event.requestId}`]
  if (event.decisionId) parts.push(`decision=${event.decisionId}`)
  if (event.sessionId) parts.push(`sid=${event.sessionId}`)
  if (event.model) parts.push(`model=${event.model}`)
  if (event.toolName) parts.push(`tool=${event.toolName}`)
  if (event.httpStatus !== undefined) parts.push(`http=${event.httpStatus}`)
  if (event.durationMs > 0) parts.push(`${event.durationMs}ms`)
  if (event.errorCode) parts.push(`error=${event.errorCode}`)
  return parts.join(' ')
}

export function createConsoleAuditLogger(options: ConsoleAuditOptions = {}): AuditLogger {
  const enabled = options.enabled ?? true
  const prefix = options.prefix ?? '[agent-kit]'
  const sink = options.sink ?? { log: (message: string) => console.log(message), error: (message: string) => console.error(message) }
  return {
    log(event) {
      if (!enabled) return
      const line = `${prefix} ${formatEvent(event)}`
      // 带错误码的走 error 流，便于 `2>` 单独收集。
      if (event.errorCode) sink.error(line)
      else sink.log(line)
    },
  }
}

/**
 * 把 AgentKitError 之外的失败也记一笔。
 *
 * harness 的 audit 只覆盖它自己发起的调用；BFF 边界上抛出的异常需要单独记，
 * 否则「请求进来了但报错了」这件事在服务端不留痕迹。
 */
export function logBoundaryError(
  audit: AuditLogger | undefined,
  requestId: string,
  errorCode: string,
  durationMs = 0,
  sessionId?: string,
): void {
  void audit?.log({ requestId, durationMs, errorCode, ...(sessionId ? { sessionId } : {}) })
}

// ── verbose 日志 ──────────────────────────────────────────────────

export interface VerboseLogOptions {
  /** 是否输出。默认开启。 */
  enabled?: boolean
  /** 日志前缀。 */
  prefix?: string
  sink?: { log(message: string): void }
}

/**
 * 把一次 LLM 调用的完整输入输出打出来，供排障。
 *
 * 这是有意越界的调试模式：会输出 Prompt 正文与模型原文（含工具调用、会话历史），
 * 但**绝不会**输出 LLM API Key。生产环境不应开启 —— 需要 BFF 设置 LOG_LEVEL=verbose 才启用。
 */
export function createLlmVerboseLogger(options: VerboseLogOptions = {}): (event: LlmTraceEvent) => void {
  const enabled = options.enabled ?? true
  const prefix = options.prefix ?? '[bff:llm]'
  const sink = options.sink ?? { log: (message: string) => console.log(message) }
  return (event) => {
    if (!enabled) return
    const head = `ts=${new Date().toISOString()}${event.sessionId ? ` sid=${event.sessionId}` : ''}`
    if (event.phase === 'request') {
      const body = event.body ?? {}
      const messages = Array.isArray(body.messages) ? body.messages : []
      const roleCounts = new Map<string, number>()
      for (const message of messages as Array<{ role?: string }>) {
        roleCounts.set(message.role ?? '?', (roleCounts.get(message.role ?? '?') ?? 0) + 1)
      }
      const summary = [...roleCounts.entries()].map(([role, count]) => `${role}×${count}`).join(', ')
      sink.log(
        `${prefix} ${head} → ${event.requestId} model=${String(body.model ?? '?')} tools=${Array.isArray(body.tools) ? body.tools.length : 0} messages(${summary})\n` +
          `${JSON.stringify(body, null, 2)}`,
      )
      return
    }
    if (event.phase === 'response') {
      sink.log(`${prefix} ${head} ← ${event.requestId} ${event.durationMs}ms\n${JSON.stringify(event.responseBody, null, 2)}`)
      return
    }
    sink.log(`${prefix} ${head} ✗ ${event.requestId} ${event.durationMs}ms error=${JSON.stringify(event.error ?? event.responseBody ?? '')}`)
  }
}
