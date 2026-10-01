/** Agent Kit 统一的稳定错误码，调用方据此判断分支，不依赖错误文案。 */
export type AgentKitErrorCode =
  | 'SECRET_NOT_CONFIGURED'
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_EXECUTOR_MISSING'
  | 'HARNESS_STEP_LIMIT'
  | 'CONTROL_FLOW_GENERATION_MISMATCH'
  | 'TOOL_INPUT_INVALID'
  | 'TOOL_OUTPUT_INVALID'
  | 'TOOL_EXECUTION_TIMEOUT'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_EXECUTION_ABORTED'
  | 'TOOL_EXECUTION_UNCERTAIN'
  | 'TOOL_SCHEMA_UNSUPPORTED'
  | 'LLM_RESPONSE_INVALID'
  | 'LLM_OUTPUT_PROTOCOL_INVALID'
  | 'PENDING_CALL_NOT_FOUND'
  | 'PROMPT_ALREADY_REGISTERED'
  | 'PROMPT_NOT_FOUND'

/** 所有可预期失败统一抛出带 code 的 AgentKitError。 */
export class AgentKitError extends Error {
  constructor(
    readonly code: AgentKitErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'AgentKitError'
  }
}
