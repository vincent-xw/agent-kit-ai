import { AgentKitError } from '@agentkit-ai/core'
import type { AgentHarness, AuditLogger } from '@agentkit-ai/core'
import { Hono } from 'hono'

/** 创建不持有密钥的 HTTP 边界；密钥、会话与 harness 均由 BFF 服务端注入。 */
export function createAgentBff(options: {
  harness: AgentHarness
  authenticate: (request: Request) => Promise<{ subject: string } | null>
  /**
   * 审计日志。不注入时边界上的失败在服务端不留任何痕迹 ——
   * 排查「扩展侧报了个错但服务端什么都看不到」时这是唯一线索。
   */
  audit?: AuditLogger
}) {
  const app = new Hono()

  /** 记一笔边界事件。只记非敏感字段，不含 Prompt 正文与业务上下文。 */
  function audit(requestId: string, route: string, startedAt: number, errorCode?: string): void {
    void options.audit?.log({
      requestId,
      durationMs: Date.now() - startedAt,
      toolName: route,
      ...(errorCode ? { errorCode } : {}),
    })
  }

  app.post('/v1/agent/sessions/:sessionId/run', async (context) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    try {
      const identity = await options.authenticate(context.req.raw)
      if (!identity) {
        audit(requestId, 'run', startedAt, 'UNAUTHORIZED')
        return context.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      }
      const body = await context.req.json<{ input?: unknown; context?: unknown; promptName?: unknown; skipTools?: unknown; stepMode?: unknown }>()
      if (typeof body.input !== 'string' || !body.input.trim() || !body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        audit(requestId, 'run', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: '请求参数不合法' }, 400)
      }
      if (body.promptName !== undefined && typeof body.promptName !== 'string') {
        audit(requestId, 'run', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'promptName 必须是字符串' }, 400)
      }
      if (body.skipTools !== undefined && typeof body.skipTools !== 'boolean') {
        audit(requestId, 'run', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'skipTools 必须是布尔值' }, 400)
      }
      if (body.stepMode !== undefined && typeof body.stepMode !== 'boolean') {
        audit(requestId, 'run', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'stepMode 必须是布尔值' }, 400)
      }
      // 把已认证主体绑定到 session namespace，防止跨用户读取同一 sessionId 的上下文。
      const scopedSessionId = `${identity.subject}:${context.req.param('sessionId')}`
      const result = await options.harness.run({
        sessionId: scopedSessionId,
        input: body.input,
        context: body.context as Record<string, unknown>,
        ...(body.promptName ? { promptName: body.promptName } : {}),
        ...(body.skipTools === true ? { skipTools: true } : {}),
        ...(body.stepMode === true ? { stepMode: true } : {}),
      })
      audit(requestId, `run:${result.type}`, startedAt)
      return context.json(result)
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      audit(requestId, 'run', startedAt, payload.code)
      // message 里可能带端点返回的具体原因（例如 LLM 400 的错误描述），
      // 这对排查是必需的，所以单独打一行完整信息到 stderr。
      options.audit?.log({ requestId, durationMs: 0, errorCode: payload.message })
      return context.json(payload, 500)
    }
  })

  app.post('/v1/agent/sessions/:sessionId/continue', async (context) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    try {
      const identity = await options.authenticate(context.req.raw)
      if (!identity) {
        audit(requestId, 'continue', startedAt, 'UNAUTHORIZED')
        return context.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      }
      const body = await context.req.json<{ input?: unknown; context?: unknown; promptName?: unknown }>()
      if (!body.context || typeof body.context !== 'object' || Array.isArray(body.context)) {
        audit(requestId, 'continue', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: '请求参数不合法' }, 400)
      }
      if (body.input !== undefined && (typeof body.input !== 'string' || !body.input.trim())) {
        audit(requestId, 'continue', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'input 若提供必须是非空字符串' }, 400)
      }
      if (body.promptName !== undefined && typeof body.promptName !== 'string') {
        audit(requestId, 'continue', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: 'promptName 必须是字符串' }, 400)
      }
      const scopedSessionId = `${identity.subject}:${context.req.param('sessionId')}`
      const result = await options.harness.continue({
        sessionId: scopedSessionId,
        context: body.context as Record<string, unknown>,
        ...(typeof body.input === 'string' ? { input: body.input } : {}),
        ...(body.promptName ? { promptName: body.promptName } : {}),
      })
      audit(requestId, `continue:${result.type}`, startedAt)
      return context.json(result)
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      audit(requestId, 'continue', startedAt, payload.code)
      options.audit?.log({ requestId, durationMs: 0, errorCode: payload.message })
      return context.json(payload, 500)
    }
  })

  app.post('/v1/agent/sessions/:sessionId/tool-results/:callId', async (context) => {
    const requestId = `req-${Math.random().toString(36).slice(2)}`
    const startedAt = Date.now()
    try {
      const identity = await options.authenticate(context.req.raw)
      if (!identity) {
        audit(requestId, 'tool-results', startedAt, 'UNAUTHORIZED')
        return context.json({ code: 'UNAUTHORIZED', requestId, message: '未通过 BFF 鉴权' }, 401)
      }
      const body = await context.req.json<{ output?: unknown }>()
      if (!Object.prototype.hasOwnProperty.call(body, 'output')) {
        audit(requestId, 'tool-results', startedAt, 'REQUEST_INVALID')
        return context.json({ code: 'REQUEST_INVALID', requestId, message: '缺少工具输出' }, 400)
      }
      // 远端工具结果只允许回填当前用户、当前 session 尚未完成的 callId。
      const scopedSessionId = `${identity.subject}:${context.req.param('sessionId')}`
      const result = await options.harness.resume({
        sessionId: scopedSessionId,
        callId: context.req.param('callId'),
        output: body.output,
      })
      audit(requestId, `tool-results:${result.type}`, startedAt)
      return context.json(result)
    } catch (error) {
      const payload = toErrorPayload(error, requestId)
      audit(requestId, 'tool-results', startedAt, payload.code)
      options.audit?.log({ requestId, durationMs: 0, errorCode: payload.message })
      return context.json(payload, 500)
    }
  })

  return app
}

/** 把任意错误归一化为 { code, requestId, message }，绝不回显密钥、Prompt 正文或业务上下文。 */
function toErrorPayload(error: unknown, requestId: string): { code: string; requestId: string; message: string } {
  if (error instanceof AgentKitError) {
    return { code: error.code, requestId, message: error.message }
  }
  // 请求超时（LLM 侧 AbortTimeout 等）单独归类，便于前端提示可重试
  if (error instanceof Error && (error.name === 'AbortError' || /timeout|timed?\s?out|abort/i.test(error.message))) {
    return { code: 'TIMEOUT', requestId, message: '服务请求超时' }
  }
  return { code: 'INTERNAL', requestId, message: '服务内部错误' }
}
