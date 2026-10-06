import { serve } from '@hono/node-server'
import { streamSSE } from 'hono/streaming'
import type { Context } from 'hono'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 获取程序所在目录（配置文件与数据库的落地位置）。
 *
 * pkg 打包后代码跑在只读虚拟 FS 里（POSIX 是 /snapshot/...，Windows 是 C:\snapshot\...），
 * 所以不能用 __filename 的目录，必须用 exe 自身所在目录。
 */
function getProgramDir(): string {
  if ((process as { pkg?: unknown }).pkg !== undefined) {
    return dirname(process.execPath)
  }
  if (typeof __filename !== 'undefined') {
    return dirname(__filename)
  }
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
      return dirname(fileURLToPath(import.meta.url))
    }
  } catch {
    // import.meta 不可用时 fallback
  }
  return dirname(process.execPath)
}

import { createSqliteAgentRuntime } from '@agentkit-ai/adapter-sqlite'
import { createAgentBff } from '@agentkit-ai/bff-hono'
import { AgentKitError, createConsoleAuditLogger, createLlmVerboseLogger, createPromptRegistry } from '@agentkit-ai/core'
import type { AuditLogger, LlmSecret, LlmTraceEvent } from '@agentkit-ai/core'

import {
  browserAutomationPrompt,
  browserToolDefinitions,
  candidateAssessmentPrompt,
  candidateAssessmentProtocol,
  freeFormPrompt,
  planningPrompt,
  planningProtocol,
} from './browser-tools.js'
import { createEventBus } from './event-bus.js'
import type { BffEvent } from './event-bus.js'
import { llmTraceToBus } from './tool-events.js'
import { createExecuteLoop } from './execute-loop.js'

/** 装配浏览器扩展专属 BFF：SQLite 密钥库 + Bearer 鉴权 + harness HTTP 边界 + SSE 事件流。 */
export function createBrowserExtensionBff(options: {
  masterKey: string
  apiToken: string
  databasePath?: string
  llm?: LlmSecret
  audit?: AuditLogger
  llmTrace?: (event: LlmTraceEvent) => void
  llmMaxRetries?: number
}) {
  const database = new DatabaseSync(options.databasePath ?? 'agent-kit.sqlite')
  const audit = options.audit ?? createConsoleAuditLogger({ prefix: '[bff]' })
  const prompts = createPromptRegistry()
  prompts.register({ name: 'free-form', version: '1', prompt: freeFormPrompt })
  prompts.register({ name: 'planning', version: '1', prompt: planningPrompt, protocol: planningProtocol })
  prompts.register({ name: 'browser-automation', version: '1', prompt: browserAutomationPrompt })
  prompts.register({
    name: 'candidate-assessment',
    version: '1',
    prompt: candidateAssessmentPrompt,
    protocol: candidateAssessmentProtocol,
  })

  const bus = createEventBus()
  const executeLoop = createExecuteLoop(bus)
  const traceToBus = llmTraceToBus(bus)

  const runtime = createSqliteAgentRuntime({
    database,
    masterKey: options.masterKey,
    prompts,
    audit,
    llmTrace: (event: LlmTraceEvent) => {
      options.llmTrace?.(event)
      traceToBus(event)
    },
    llmDelta: (delta) => {
      bus.emit({ type: 'llm_delta', ...delta })
    },
    ...(options.llmMaxRetries !== undefined ? { llmMaxRetries: options.llmMaxRetries } : {}),
  })
  for (const tool of browserToolDefinitions) runtime.tools.register(tool)

  const app = createAgentBff({
    authenticate: async (request) => {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
      return token && token === options.apiToken ? { subject: 'browser-extension' } : null
    },
    harness: runtime.harness,
    audit,
  })

  // ── SSE event stream ──────────────────────────────────
  app.get('/api/events', (c) => {
    if (c.req.query('token') !== options.apiToken) return c.json({ error: 'unauthorized' }, 401)
    const lastEventId = c.req.header('last-event-id')
    const fromSeq = lastEventId !== undefined ? Number(lastEventId) : undefined

    // Hono 4.13 的 streamSSE 使用默认 Context 泛型；路由推导出的字面量路径泛型
    // 在这里只影响类型，不影响运行时，显式收窄为通用 Context 以兼容构建。
    return streamSSE(c as unknown as Context, async (stream) => {
      const queue: BffEvent[] = []
      const unsubscribe = bus.subscribe((event) => queue.push(event), fromSeq)
      stream.onAbort(unsubscribe)
      let lastPing = Date.now()
      try {
        while (!stream.aborted) {
          while (queue.length > 0) {
            const event = queue.shift() as BffEvent
            await stream.writeSSE({
              data: JSON.stringify(event),
              event: event.type,
              id: String(event.seq),
            })
          }
          if (Date.now() - lastPing >= 15_000) {
            await stream.write(': ping\n\n')
            lastPing = Date.now()
          }
          await stream.sleep(250)
        }
      } finally {
        unsubscribe()
      }
    })
  })

  // ── Start execution (SSE-driven) ──────────────────────
  app.post('/api/execute', async (c) => {
    const identity = await authenticate(c.req.raw, options.apiToken)
    if (!identity) return c.json({ code: 'UNAUTHORIZED', message: '未通过 BFF 鉴权' }, 401)

    const body = await c.req.json<{ input?: unknown; context?: unknown; sessionId?: unknown; promptName?: unknown }>()
    if (typeof body.input !== 'string' || !body.input.trim()) {
      return c.json({ code: 'REQUEST_INVALID', message: 'input 必须是非空字符串' }, 400)
    }
    if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
      return c.json({ code: 'REQUEST_INVALID', message: 'context 必须是对象' }, 400)
    }
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return c.json({ code: 'REQUEST_INVALID', message: 'sessionId 必须是非空字符串' }, 400)
    }

    const scopedSessionId = `${identity.subject}:${body.sessionId}`
    const rawSessionId = body.sessionId

    runtime.harness
      .run({
        sessionId: scopedSessionId,
        input: body.input,
        context: body.context as Record<string, unknown>,
        ...(typeof body.promptName === 'string' ? { promptName: body.promptName } : {}),
      })
      .then((result) => executeLoop.dispatchResult(result, rawSessionId))
      .catch((error: unknown) => {
        const code = error instanceof AgentKitError ? error.code : 'INTERNAL'
        const message = error instanceof Error ? error.message : '服务内部错误'
        bus.emit({ type: 'error', code, message, sessionId: rawSessionId })
      })

    return c.json({ accepted: true }, 202)
  })

  // ── Submit tool result (SSE-driven) ───────────────────
  app.post('/api/tool-results/:callId', async (c) => {
    const identity = await authenticate(c.req.raw, options.apiToken)
    if (!identity) return c.json({ code: 'UNAUTHORIZED', message: '未通过 BFF 鉴权' }, 401)

    const callId = c.req.param('callId')
    const body = await c.req.json<{ output?: unknown; sessionId?: unknown }>()
    if (!Object.prototype.hasOwnProperty.call(body, 'output')) {
      return c.json({ code: 'REQUEST_INVALID', message: '缺少工具输出' }, 400)
    }
    if (typeof body.sessionId !== 'string' || !body.sessionId.trim()) {
      return c.json({ code: 'REQUEST_INVALID', message: 'sessionId 必须是非空字符串' }, 400)
    }

    const scopedSessionId = `${identity.subject}:${body.sessionId}`
    const rawSessionId = body.sessionId

    runtime.harness
      .resume({
        sessionId: scopedSessionId,
        callId,
        output: body.output,
      })
      .then((result) => executeLoop.dispatchResult(result, rawSessionId))
      .catch((error: unknown) => {
        const code = error instanceof AgentKitError ? error.code : 'INTERNAL'
        const message = error instanceof Error ? error.message : '服务内部错误'
        bus.emit({ type: 'error', code, message, sessionId: rawSessionId })
      })

    return c.json({ accepted: true }, 202)
  })

  const ready = seedSecret(runtime, options.llm)
  return { app, runtime, database, prompts, bus, ready }
}

async function authenticate(request: Request, apiToken: string): Promise<{ subject: string } | null> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/, '')
  return token && token === apiToken ? { subject: 'browser-extension' } : null
}

/** 把环境提供的模型配置写入加密密钥库；未提供时保留库中已有配置。 */
async function seedSecret(
  rt: { secrets: { put(secret: LlmSecret): Promise<void> } },
  llm?: LlmSecret,
): Promise<void> {
  if (!llm) return
  await rt.secrets.put(llm)
}

/** 用 @hono/node-server 启动 BFF。 */
export function startServer(options: {
  masterKey: string
  apiToken: string
  port?: number
  llm?: LlmSecret
  llmMaxRetries?: number
  llmTrace?: (event: LlmTraceEvent) => void
  databasePath?: string
}): Promise<{ server: ReturnType<typeof serve>; database: DatabaseSync }> {
  const { app, ready, database } = createBrowserExtensionBff(options)
  return new Promise((resolve) => {
    ready.then(() => {
      const port = options.port ?? 8787
      const server = serve(
        { fetch: (req: Request) => app.fetch(req), port, hostname: '127.0.0.1' },
        () => {
          console.log(`BFF listening on http://localhost:${port}`)
        },
      )
      resolve({ server, database })
    })
  })
}

/**
 * 从 exe/脚本 同目录的 .env 文件加载配置。
 */
function loadEnvFile(): { loaded: boolean; path: string; vars: string[] } {
  const dir = getProgramDir()
  const envPath = join(dir, '.env')
  if (!existsSync(envPath)) return { loaded: false, path: envPath, vars: [] }
  const content = readFileSync(envPath, 'utf-8')
  const loaded: string[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) {
      process.env[key] = value
      loaded.push(key)
    }
  }
  return { loaded: true, path: envPath, vars: loaded }
}

/** 生成配置文件模板（首次启动时如果 .env 不存在则写入）。 */
function ensureEnvTemplate(): void {
  const dir = getProgramDir()
  const envPath = join(dir, '.env')
  if (existsSync(envPath)) return
  const template = [
    '# BFF 配置文件。填好后启动 exe 即可。',
    '# 井号开头是注释，不用管。',
    '',
    '# 32 字节 base64url 主密钥。用于加解密 SQLite 中的模型密钥。',
    "# 生成方法：在终端运行 openssl rand -base64 32 然后把 + 换成 -、/ 换成 _、去掉末尾 =",
    'AGENT_KIT_MASTER_KEY=',
    '',
    '# 扩展访问 BFF 的接入凭证（不是 LLM API Key）。',
    '# 随便取一个字符串，需与扩展设置里的「BFF 接入 token」一致。',
    'BFF_API_TOKEN=dev-token',
    '',
    '# 模型配置。只存在于 BFF 进程环境，扩展侧看不到。',
    'LLM_API_KEY=',
    'LLM_MODEL=deepseek-v4-flash',
    '',
    '# OpenAI 兼容端点。DeepSeek 用 https://api.deepseek.com',
    '# 火山方舟用 https://ark.cn-beijing.volces.com/api/v3',
    'LLM_BASE_URL=https://api.deepseek.com',
    '',
    '# 日志级别：info（默认）或 verbose（打印 LLM 完整输入输出，排障用）',
    '# LOG_LEVEL=verbose',
    '',
    '# LLM 请求最大重试次数（0-5，默认 3）。网络错误、408/425、5xx 使用退避；429 最多重试 2 次并在当前 BFF 进程内共享冷却。',
    '# 可重试响应优先遵循 Retry-After；429 无该响应头时按 60 秒起步逐步延长，退避上限 15 分钟。确定性 4xx 不重试。',
    '# LLM_MAX_RETRIES=3',
    '',
    '# 监听端口（默认 8787）',
    '# PORT=8787',
    '',
  ].join('\n')
  try {
    writeFileSync(envPath, template, 'utf-8')
    console.log(`[bff] 已生成配置文件模板：${envPath}`)
    console.log('[bff] 请填写后重新启动。')
    process.exit(0)
  } catch {
    // 写不了也不阻塞
  }
}

const isMainModule = process.execPath === process.argv[0] ||
  (typeof __filename !== 'undefined' && process.argv[1] === __filename && !process.env.VITEST) ||
  (typeof import.meta !== 'undefined' && import.meta.url === `file://${process.argv[1]}` && !process.env.VITEST)
if (process.argv[1] && isMainModule && !process.env.VITEST) {
  ensureEnvTemplate()
  const envResult = loadEnvFile()
  if (envResult.loaded) {
    console.log(`[bff] 已从 ${envResult.path} 加载配置：${envResult.vars.join(', ')}`)
  }
  const masterKey = process.env.AGENT_KIT_MASTER_KEY ?? ''
  const apiToken = process.env.BFF_API_TOKEN ?? ''
  if (!masterKey || !apiToken) {
    console.error('缺少配置：AGENT_KIT_MASTER_KEY 与 BFF_API_TOKEN')
    console.error('请在 exe 同目录的 .env 文件中填写，或通过环境变量设置。')
    process.exit(1)
  }
  const apiKey = process.env.LLM_API_KEY ?? ''
  const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.deepseek.com'
  const model = process.env.LLM_MODEL ?? ''
  if (!apiKey || !model) {
    console.error('缺少配置：LLM_API_KEY 与 LLM_MODEL')
    console.error('请在 exe 同目录的 .env 文件中填写，或通过环境变量设置。')
    process.exit(1)
  }
  const logLevel = process.env.LOG_LEVEL ?? 'info'
  const llmTrace =
    logLevel === 'verbose'
      ? createLlmVerboseLogger({ prefix: '[bff:llm]' })
      : undefined
  if (logLevel === 'verbose') console.log('[bff] LOG_LEVEL=verbose -- 将打印 LLM 请求与响应的完整内容（含 Prompt 正文）')
  const llmMaxRetries = Number(process.env.LLM_MAX_RETRIES ?? '3')
  const port = Number(process.env.PORT ?? '8787')
  const dbPath = join(getProgramDir(), 'agent-kit.sqlite')

  const launch = async () => {
    const { server, database } = await startServer({
      masterKey,
      apiToken,
      llm: { apiKey, baseUrl, model },
      ...(llmTrace ? { llmTrace } : {}),
      llmMaxRetries,
      port,
      databasePath: dbPath,
    })
    const shutdown = () => {
      server.close()
      database.close()
      process.exit(0)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  }
  void launch()
}
