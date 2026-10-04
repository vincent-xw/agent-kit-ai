import type { z } from 'zod'

import type { LlmProvider } from './llm-client.js'

/** 模型输出的单个工具调用。callId 用于回填时关联，并作为 OpenAI 的 tool_call_id 回传。 */
export type ToolCall = { callId: string; toolName: string; input: unknown }

/**
 * LLM 单次完成的输出：最终文本，或本轮全部工具调用。
 * 复数形态是必需的——模型可以在一轮内发起多个调用，只取第一个会静默丢弃其余调用。
 */
export type LlmResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  // 模型可能在发起工具调用前先输出说明文字；不能因本轮有 tool_calls 就丢掉这段正文。
  | { type: 'tool_calls'; calls: ToolCall[]; content?: string; reasoning?: string }

export type HarnessNotice = {
  toolName: string
  code: 'TOOL_INPUT_INVALID' | 'TOOL_OUTPUT_INVALID' | 'TOOL_EXECUTION_FAILED' | 'TOOL_EXECUTION_ABORTED' | 'TOOL_EXECUTION_TIMEOUT'
  message: string
  attempt: number
  retryable: boolean
}
/** Harness 对外结果：最终输出，或需要远端 Tool Host 执行的挂起调用集合。 */
export type HarnessResult =
  | { type: 'final'; output: unknown; reasoning?: string }
  | { type: 'pending_tool_calls'; calls: Array<{ callId: string; toolName: string; input: unknown }> }
  | { type: 'step_done'; notices?: HarnessNotice[] }

/**
 * 会话消息。assistant 角色是必需的：缺少它模型看不到自己的上一轮输出与已发起的工具调用，
 * 多轮对话实际不成立。toolCalls 仅在 assistant 消息上出现；callId 仅在 tool 消息上出现。
 */
export type SessionMessage =
  | { role: 'user'; content: unknown; createdAt?: string }
  | { role: 'assistant'; content: unknown; toolCalls?: ToolCall[]; reasoning?: string; createdAt?: string }
  | { role: 'tool'; content: unknown; callId: string; toolName?: string; createdAt?: string }
  /** 运行期注入的系统消息（例如上下文裁剪摘要）。不落库，只在发给模型时前置。 */
  | { role: 'system'; content: unknown }

/** LLM 密钥配置，适配器从受信任来源读取后注入。 */
export interface LlmSecret {
  apiKey: string
  baseUrl: string
  model: string
  /**
   * 服务商协议。档案级取值优先于进程级兜底。
   * 历史密文与 browser-extension-bff 不带该字段，此时由进程级参数决定，行为与改造前一致。
   */
  provider?: LlmProvider
  /** 模型允许的思考强度；为空时沿用服务端默认行为，不发送 reasoning_effort。 */
  reasoningEffort?: string
  /** 同一凭据的请求最小开始间隔；未配置时为 0，保持历史行为。 */
  minRequestIntervalMs?: number
  /** 同一接入点与凭据共享限速状态的不可逆标识，不包含 API Key 明文。 */
  rateLimitKey?: string
}

/** 密钥提供者，浏览器/H5 侧永远不应有可调用的实现。 */
export interface SecretProvider {
  get(): Promise<LlmSecret>
}

/** 会话存储，按 sessionId 读写消息。 */
export interface SessionStore {
  load(sessionId: string): SessionMessage[] | Promise<SessionMessage[]>
  save(sessionId: string, messages: SessionMessage[]): void | Promise<void>
}

/** 挂起的远端工具调用记录，用于 resume 时校验 callId 归属。 */
export interface PendingCall {
  sessionId: string
  toolName: string
  /**
   * 发起本次调用时所用的提示词名称。
   * 必须随挂起状态一起保存：resume 要用同一个提示词继续，否则一次工具循环的
   * 前后两半会用不同提示词（甚至不同输出协议），行为将不可预测。
   */
  promptName?: string
}

/**
 * 挂起调用存储。抽成接口是因为进程内 Map 在两种场景都会丢：
 * BFF 进程重启，以及 MV3 Service Worker 空闲挂起。宿主可注入持久化实现。
 */
export interface PendingCallStore {
  get(callId: string): PendingCall | undefined | Promise<PendingCall | undefined>
  set(callId: string, call: PendingCall): void | Promise<void>
  delete(callId: string): void | Promise<void>
}

/** 审计事件只含非敏感字段：requestId、模型、耗时、HTTP 状态、工具名与错误码。 */
export interface AuditEvent {
  requestId: string
  /** 当前 Core Control Flow Decision 标识；与 Provider Event 使用同一值关联诊断。 */
  decisionId?: string
  sessionId?: string
  model?: string
  durationMs: number
  httpStatus?: number
  toolName?: string
  errorCode?: string
}

/** 审计记录器接口，禁止记录密钥、Prompt 正文、模型原文或业务上下文。 */
export interface AuditLogger {
  log(event: AuditEvent): void | Promise<void>
}

/**
 * 服务端工具的阶段性进度。
 *
 * 进度只用于宿主界面和诊断日志，不会自动进入 LLM 上下文；因此这里不应放入
 * 完整节点树、Prompt、模型原文或其他敏感业务数据。
 */
export interface ToolProgress {
  /** 稳定的机器可读阶段名，例如 root_acquisition、tree_dump。 */
  phase: string
  /** 面向用户的简短进度说明。 */
  message: string
  /** 可选的阶段耗时；未提供时由工具包装层按调用开始时间补齐。 */
  elapsedMs?: number
}

/**
 * 工具执行上下文：透传取消信号，使长时间运行的工具可被中止；progress 用于向
 * 宿主报告中间阶段，不能替代最终 Tool Result。
 */
export interface ToolExecutionContext {
  signal: AbortSignal
  /** 本次调用所属会话，由 harness 注入；包装层可据此给事件标注会话。 */
  sessionId?: string
  /** 关联的调用 ID（与 tool 消息的 callId 对应），由 harness 注入。 */
  callId?: string
  /** 可选的阶段性进度回调；宿主未提供时工具必须仍能正常完成。 */
  reportProgress?: (progress: ToolProgress) => void
}

/** Harness 把服务端 Tool 交给宿主时的统一请求；宿主可在此注入 Workflow 能力边界和租约。 */
export interface HarnessToolExecutionRequest {
  tool: ToolDefinition
  input: unknown
  sessionId: string
  callId: string
  signal: AbortSignal
}

/** 工具定义：Zod 输入/输出 Schema 与执行方式（服务端或远端 Tool Host）。 */
export interface ToolDefinition<I = unknown, O = unknown> {
  name: string
  execution: 'server' | 'remote'
  /** 供模型理解用途的说明，会随 JSON Schema 一并发给模型。 */
  description?: string
  input: z.ZodType<I>
  output: z.ZodType<O>
  /** 单次执行超时毫秒数；未设置时使用 harness 的默认值。 */
  timeoutMs?: number
  execute?: (input: I, context: ToolExecutionContext) => Promise<O>
}

/** 发送给模型的工具声明，input schema 已转换为 JSON Schema。 */
export interface ToolSchema {
  name: string
  description?: string
  parameters: Record<string, unknown>
}
