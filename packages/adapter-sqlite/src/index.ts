import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { AgentKitError, createAgentHarness, createLlmClient, createToolRegistry } from '@agentkit-ai/core'
import type { AuditLogger, ContextManager, ControlFlowDecisionProvider, LlmDelta, LlmProvider, LlmSecret, LlmTraceEvent, PendingCall, PendingCallResultCommitter, PendingCallStore, PromptRegistry, SessionMessage } from '@agentkit-ai/core'

/** 由主密钥派生短密钥版本标识，轮换后旧密文无法通过版本校验。 */
function deriveKeyVersion(masterKey: string): string {
  return createHash('sha256').update(masterKey, 'utf8').digest('hex').slice(0, 16)
}

/** SQLite 中只保存 AES-GCM 密文与密钥版本；主密钥由 BFF 进程环境提供，不落库。 */
export function createSqliteSecretProvider(options: { database: DatabaseSync; masterKey: string; id?: string }) {
  const key = Buffer.from(options.masterKey, 'base64url')
  if (key.byteLength !== 32) throw new AgentKitError('SECRET_NOT_CONFIGURED', 'AGENT_KIT_MASTER_KEY 必须是 32 字节 base64url 值')
  const keyVersion = deriveKeyVersion(options.masterKey)
  // 槽位名在构造时固定：'default' 是历史默认槽，模型档案使用 'llm:<id>' / 'vision:<id>'。
  const secretId = options.id ?? 'default'
  // 表结构与 src/schema.sql 保持一致；key_version 用于主密钥轮换后拒绝旧密文。
  options.database.exec(`CREATE TABLE IF NOT EXISTS agent_secrets (
    id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    key_version TEXT NOT NULL
  )`)
  return {
    async put(secret: LlmSecret): Promise<void> {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      options.database
        .prepare('INSERT OR REPLACE INTO agent_secrets (id, ciphertext, iv, tag, key_version) VALUES (?, ?, ?, ?, ?)')
        .run(secretId, ciphertext.toString('base64url'), iv.toString('base64url'), tag.toString('base64url'), keyVersion)
    },
    async get(): Promise<LlmSecret> {
      const record = options.database.prepare('SELECT ciphertext, iv, tag, key_version FROM agent_secrets WHERE id = ?').get(secretId) as
        | { ciphertext?: string; iv?: string; tag?: string; key_version?: string }
        | undefined
      if (!record?.ciphertext || !record.iv || !record.tag || !record.key_version) {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite 中未配置 LLM Secret')
      }
      if (record.key_version !== keyVersion) {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite LLM Secret 的主密钥版本不匹配，请用当前主密钥重新写入')
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'))
        decipher.setAuthTag(Buffer.from(record.tag, 'base64url'))
        return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as LlmSecret
      } catch {
        throw new AgentKitError('SECRET_NOT_CONFIGURED', 'SQLite LLM Secret 无法解密')
      }
    },
    /** 删除该槽位的密文；槽位不存在时静默返回，便于删除模型档案时幂等清理。 */
    delete(): void {
      options.database.prepare('DELETE FROM agent_secrets WHERE id = ?').run(secretId)
    },
  }
}

/** SQLite session 表与密钥表分离，避免业务上下文与密钥混存。 */
export function createSqliteSessionStore(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    messages TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`)
  return {
    async save(sessionId: string, messages: SessionMessage[]) {
      database
        .prepare('INSERT OR REPLACE INTO agent_sessions (session_id, messages, updated_at) VALUES (?, ?, ?)')
        .run(sessionId, JSON.stringify(messages), new Date().toISOString())
    },
    async load(sessionId: string): Promise<SessionMessage[]> {
      const row = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?').get(sessionId) as { messages?: string } | undefined
      if (!row?.messages) return []
      try { return JSON.parse(row.messages) as SessionMessage[] } catch { return [] }
    },
  }
}

const SQLITE_ADAPTER_SCHEMA_VERSION = 2

/** Adapter 层稳定错误码；业务层只需要检查 code，不依赖错误文案。 */
export class SqliteAdapterError extends Error {
  constructor(
    readonly code:
      | 'SQLITE_ADAPTER_SCHEMA_FUTURE'
      | 'SQLITE_ADAPTER_SCHEMA_INVALID'
      | 'SQLITE_NESTED_TRANSACTION'
      | 'PENDING_CALL_SCOPE_MISMATCH'
      | 'TOOL_RESULT_CONFLICT',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'SqliteAdapterError'
  }
}

/** SQLite 同步事务只允许一个 writer；迁移与结果完成共用同一约束。 */
function withImmediateTransaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) {
    throw new SqliteAdapterError('SQLITE_NESTED_TRANSACTION', 'SQLite writer 中不能再次开启事务')
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    database.exec('COMMIT')
    return result
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK')
    throw error
  }
}

interface PendingCallRow {
  call_id: string
  session_id: string
  tool_name: string
  prompt_name: string | null
  run_instance_id: string | null
  execution_scope_id: string | null
  policy_digest: string | null
  input_digest: string | null
  policy_version: number
}

function tableColumnNames(database: DatabaseSync, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

/**
 * v2 只做 additive migration：旧行保持 policy_version=1，新 Runtime 写入 v2 身份字段。
 * user_version 高于当前二进制支持范围时 fail closed，不能继续写未知表结构。
 */
function migratePendingCallSchema(database: DatabaseSync): void {
  const currentVersion = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (currentVersion > SQLITE_ADAPTER_SCHEMA_VERSION) {
    throw new SqliteAdapterError(
      'SQLITE_ADAPTER_SCHEMA_FUTURE',
      `SQLite Adapter schema ${currentVersion} is newer than supported ${SQLITE_ADAPTER_SCHEMA_VERSION}`,
    )
  }
  withImmediateTransaction(database, () => {
    database.exec(`CREATE TABLE IF NOT EXISTS agent_pending_calls (
      call_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      prompt_name TEXT,
      run_instance_id TEXT,
      execution_scope_id TEXT,
      policy_digest TEXT,
      input_digest TEXT,
      policy_version INTEGER NOT NULL DEFAULT 2 CHECK (policy_version IN (1, 2)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`)
    const columns = tableColumnNames(database, 'agent_pending_calls')
    const additions: Array<[string, string]> = [
      ['prompt_name', 'TEXT'],
      ['run_instance_id', 'TEXT'],
      ['execution_scope_id', 'TEXT'],
      ['policy_digest', 'TEXT'],
      ['input_digest', 'TEXT'],
      ['policy_version', 'INTEGER NOT NULL DEFAULT 1'],
      ['created_at', "TEXT NOT NULL DEFAULT ''"],
    ]
    for (const [name, definition] of additions) {
      if (!columns.has(name)) database.exec(`ALTER TABLE agent_pending_calls ADD COLUMN ${name} ${definition}`)
    }
    // 旧行只补版本标记，不回填任何新的 Run/Policy 身份。
    database.exec('UPDATE agent_pending_calls SET policy_version = 1 WHERE policy_version IS NULL')
    database.exec(`PRAGMA user_version = ${SQLITE_ADAPTER_SCHEMA_VERSION}`)
  })
}

function pendingCallFromRow(row: PendingCallRow): PendingCall {
  const executionScopeId = row.execution_scope_id
  const policyDigest = row.policy_digest
  if ((executionScopeId === null) !== (policyDigest === null)) {
    throw new SqliteAdapterError('SQLITE_ADAPTER_SCHEMA_INVALID', `Pending Call ${row.call_id} 的 Execution Policy 字段不完整`)
  }
  if (row.policy_version !== 1 && row.policy_version !== 2) {
    throw new SqliteAdapterError('SQLITE_ADAPTER_SCHEMA_INVALID', `Pending Call ${row.call_id} 的 policy_version 非法`)
  }
  if (row.input_digest !== null && !row.input_digest.startsWith('sha256:')) {
    throw new SqliteAdapterError('SQLITE_ADAPTER_SCHEMA_INVALID', `Pending Call ${row.call_id} 的 input_digest 非法`)
  }
  return {
    sessionId: row.session_id,
    toolName: row.tool_name,
    ...(row.prompt_name ? { promptName: row.prompt_name } : {}),
    ...(row.run_instance_id ? { runInstanceId: row.run_instance_id } : {}),
    ...(executionScopeId && policyDigest
      ? {
          executionPolicy: {
            executionScopeId,
            policyDigest: policyDigest as `sha256:${string}`,
          },
        }
      : {}),
    ...(row.input_digest ? { inputDigest: row.input_digest as `sha256:${string}` } : {}),
  }
}

function readPendingCall(database: DatabaseSync, callId: string): PendingCall | undefined {
  const row = database.prepare(`SELECT
    call_id,session_id,tool_name,prompt_name,run_instance_id,execution_scope_id,
    policy_digest,input_digest,policy_version
    FROM agent_pending_calls WHERE call_id = ?`).get(callId) as PendingCallRow | undefined
  return row ? pendingCallFromRow(row) : undefined
}

function samePendingCall(left: PendingCall, right: PendingCall): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sameToolResult(
  existing: Extract<SessionMessage, { role: 'tool' }>,
  incoming: Extract<SessionMessage, { role: 'tool' }>,
): boolean {
  return existing.callId === incoming.callId
    && existing.toolName === incoming.toolName
    && JSON.stringify(existing.content) === JSON.stringify(incoming.content)
}

/** SQLite 挂起调用表：进程重启后回填仍能关联，不依赖进程内存。 */
export function createSqlitePendingCallStore(
  database: DatabaseSync,
): PendingCallStore & PendingCallResultCommitter {
  migratePendingCallSchema(database)
  return {
    get(callId: string) {
      return readPendingCall(database, callId)
    },
    set(callId: string, call: PendingCall) {
      const policy = call.executionPolicy
      database
        .prepare(`INSERT OR REPLACE INTO agent_pending_calls (
          call_id,session_id,tool_name,prompt_name,run_instance_id,execution_scope_id,
          policy_digest,input_digest,policy_version
        ) VALUES (?,?,?,?,?,?,?,?,2)`)
        .run(
          callId,
          call.sessionId,
          call.toolName,
          call.promptName ?? null,
          call.runInstanceId ?? null,
          policy?.executionScopeId ?? null,
          policy?.policyDigest ?? null,
          call.inputDigest ?? null,
        )
    },
    delete(callId: string) {
      database.prepare('DELETE FROM agent_pending_calls WHERE call_id = ?').run(callId)
    },
    complete({ callId, expected, toolMessage }) {
      return withImmediateTransaction(database, () => {
        const current = readPendingCall(database, callId)
        if (current && !samePendingCall(current, expected)) {
          throw new SqliteAdapterError('PENDING_CALL_SCOPE_MISMATCH', `Pending Call ${callId} 与 expected 不一致`)
        }
        const session = database.prepare('SELECT messages FROM agent_sessions WHERE session_id = ?')
          .get(expected.sessionId) as { messages?: string } | undefined
        if (!session?.messages) {
          throw new SqliteAdapterError('PENDING_CALL_SCOPE_MISMATCH', `Pending Call ${callId} 的 Session 不存在`)
        }
        let messages: SessionMessage[]
        try {
          messages = JSON.parse(session.messages) as SessionMessage[]
        } catch (error) {
          throw new SqliteAdapterError('SQLITE_ADAPTER_SCHEMA_INVALID', `Session ${expected.sessionId} 的消息不是合法 JSON`, { cause: error })
        }
        const existing = messages.find((message): message is Extract<SessionMessage, { role: 'tool' }> =>
          message.role === 'tool' && message.callId === callId)
        if (existing) {
          if (!sameToolResult(existing, toolMessage)) {
            throw new SqliteAdapterError('TOOL_RESULT_CONFLICT', `Tool Result ${callId} 已存在且内容不同`)
          }
          if (current) database.prepare('DELETE FROM agent_pending_calls WHERE call_id = ?').run(callId)
          return { state: 'already_committed' as const }
        }
        if (!current) {
          throw new SqliteAdapterError('PENDING_CALL_SCOPE_MISMATCH', `Pending Call ${callId} 已不存在且没有既有结果`)
        }
        messages.push(toolMessage)
        database.prepare('UPDATE agent_sessions SET messages = ?, updated_at = ? WHERE session_id = ?')
          .run(JSON.stringify(messages), new Date().toISOString(), expected.sessionId)
        database.prepare('DELETE FROM agent_pending_calls WHERE call_id = ?').run(callId)
        return { state: 'committed' as const }
      })
    },
  }
}

/** 组装 core 所需依赖：密钥库、会话存储、挂起调用存储、工具注册表与 harness。 */
export function createSqliteAgentRuntime(options: {
  database: DatabaseSync
  masterKey: string
  maxSteps?: number
  prompts?: PromptRegistry
  toolTimeoutMs?: number
  audit?: AuditLogger
  contextManager?: ContextManager & { onLlmTrace?: (event: LlmTraceEvent) => void }
  /** LLM 调用级追踪，供 verbose 日志使用。见 createLlmVerboseLogger。 */
  llmTrace?: (event: LlmTraceEvent) => void
  /** LLM 流式增量回调，提供时启用 stream:true。 */
  llmDelta?: (delta: LlmDelta) => void
  /** LLM 最大重试次数，透传给 createLlmClient。 */
  llmMaxRetries?: number
  /** LLM 单次请求超时毫秒数，透传给 createLlmClient（默认 30s）。长上下文可调大。 */
  llmTimeoutMs?: number
  /** LLM 服务商协议；默认使用 OpenAI 兼容协议。 */
  llmProvider?: LlmProvider
  /** LLM User-Agent 请求头；未配置时保留 Fetch 默认值。 */
  llmUserAgent?: string
  /** 透传给 Core Harness 的默认 Control Flow Decision Provider。 */
  controlFlowDecisionProvider?: ControlFlowDecisionProvider
}) {
  const secrets = createSqliteSecretProvider({ database: options.database, masterKey: options.masterKey })
  const sessions = createSqliteSessionStore(options.database)
  const pendingCalls = createSqlitePendingCallStore(options.database)
  const tools = createToolRegistry()
  const harness = createAgentHarness({
    // 每次补全前从 SQLite 读取当前密钥，未配置或版本不匹配时由 SecretProvider 抛稳定错误码。
    llm: {
      complete: async (request) => {
        const secret = await secrets.get()
        // 档案级 provider 优先；进程级仅兜底旧密文与未声明 provider 的调用方。
        const provider = secret.provider ?? options.llmProvider
        // turnId 在每次补全开头生成：同一次补全的 delta 分轮渲染依据，跨次必然不同。
        const turnId = `turn-${Math.random().toString(36).slice(2, 10)}`
        const clientTrace = (event: LlmTraceEvent) => {
          const enriched = { ...event, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }
          options.llmTrace?.(enriched)
          options.contextManager?.onLlmTrace?.(enriched)
        }
        return createLlmClient({
          ...secret,
          ...(provider ? { provider } : {}),
          ...(options.llmUserAgent === undefined ? {} : { userAgent: options.llmUserAgent }),
          trace: clientTrace,
          ...(options.llmDelta
            ? {
                onDelta: (delta) =>
                  options.llmDelta?.({ ...delta, turnId, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }),
              }
            : {}),
          ...(options.llmMaxRetries !== undefined ? { maxRetries: options.llmMaxRetries } : {}),
          ...(options.llmTimeoutMs !== undefined ? { timeoutMs: options.llmTimeoutMs } : {}),
        }).complete(request)
      },
    },
    sessions,
    tools,
    pendingCalls,
    maxSteps: options.maxSteps ?? 10,
    ...(options.controlFlowDecisionProvider ? { controlFlowDecisionProvider: options.controlFlowDecisionProvider } : {}),
    ...(options.prompts ? { prompts: options.prompts } : {}),
    ...(options.audit ? { audit: options.audit } : {}),
    ...(options.contextManager ? { context: options.contextManager } : {}),
    ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
  })
  return { secrets, sessions, tools, pendingCalls, harness, database: options.database }
}
