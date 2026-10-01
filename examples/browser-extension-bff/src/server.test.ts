import { afterEach, describe, expect, it, vi } from 'vitest'

import { toToolSchema } from '@agentkit-ai/core'

import { createBrowserExtensionBff } from './server.js'
import { browserToolDefinitions } from './browser-tools.js'

const masterKey = 'A'.repeat(43)
const llm = { apiKey: 'sk-secret-value', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

/** 装配一个内存 BFF，并等待密钥写入完成。 */
async function bff(options: { apiToken?: string; withLlm?: boolean } = {}) {
  const instance = createBrowserExtensionBff({
    masterKey,
    apiToken: options.apiToken ?? 'token-1',
    databasePath: ':memory:',
    ...(options.withLlm === false ? {} : { llm }),
  })
  await instance.ready
  return instance
}

/** 让模型返回一次工具调用。 */
function stubToolCall(toolName: string, args: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: toolName, arguments: JSON.stringify(args) } }] } }] }),
    })),
  )
}

/** 让模型返回最终文本。 */
function stubFinal(content: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) })))
}

/** 带鉴权的 run 请求。 */
function run(
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  sessionId: string,
  input: string,
  token = 'token-1',
): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/agent/sessions/${sessionId}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ input, context: {} }),
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser-extension-bff 鉴权与密钥边界', () => {
  it('未鉴权请求返回 401 且不发起模型调用', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { app, database } = await bff()
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hi', context: {} }),
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(fetchMock).not.toHaveBeenCalled()
    database.close()
  })

  it('接入 token 不匹配返回 401', async () => {
    const { app, database } = await bff({ apiToken: 'right' })
    const response = await run(app, 's-1', 'hi', 'wrong')
    expect(response.status).toBe(401)
    database.close()
  })

  it('拒绝非 32 字节主密钥', () => {
    expect(() => createBrowserExtensionBff({ masterKey: 'short', apiToken: 't', databasePath: ':memory:' })).toThrowError(/32 字节/)
  })

  it('模型密钥以密文落库且主密钥不入库', async () => {
    const { database } = await bff()
    const dump = JSON.stringify(database.prepare('SELECT * FROM agent_secrets').all())
    expect(dump).not.toContain('sk-secret-value')
    expect(dump).not.toContain(masterKey)
    database.close()
  })

  it('未配置模型密钥时返回 SECRET_NOT_CONFIGURED 而非泄露细节', async () => {
    const { app, database } = await bff({ withLlm: false })
    const response = await run(app, 's-1', 'hi')
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
    database.close()
  })
})

describe('browser-extension-bff 运行协议', () => {
  it('返回最终文本', async () => {
    stubFinal('已完成')
    const { app, database } = await bff()
    await expect((await run(app, 's-1', '你好')).json()).resolves.toEqual({ type: 'final', output: '已完成' })
    database.close()
  })

  it('远端工具返回 pending_tool_calls 且不在服务端执行', async () => {
    stubToolCall('browser_locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const payload = (await (await run(app, 's-1', '定位打招呼按钮')).json()) as { type: string; calls: Array<{ toolName: string; callId: string }> }
    expect(payload.type).toBe('pending_tool_calls')
    expect(payload.calls[0]).toMatchObject({ toolName: 'browser_locate_element' })
    database.close()
  })

  it('工具结果回填后继续推进模型', async () => {
    stubToolCall('browser_locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const pending = (await (await run(app, 's-1', '定位')).json()) as { calls: Array<{ callId: string }> }
    const callId = pending.calls[0]?.callId
    stubFinal('按钮在 (100, 200)')
    const response = await app.request(`/v1/agent/sessions/s-1/tool-results/${callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ output: { found: true, x: 100, y: 200 } }),
    })
    await expect(response.json()).resolves.toEqual({ type: 'final', output: '按钮在 (100, 200)' })
    database.close()
  })

  it('工具输出不符合 Schema 时作为工具错误回传给模型', async () => {
    stubToolCall('browser_locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const pending = (await (await run(app, 's-1', '定位')).json()) as { calls: Array<{ callId: string }> }
    // 远端回填的 schema 错误不会直接打断会话，而是作为工具错误交给下一轮模型处理。
    stubFinal('已识别工具输出无效')
    const response = await app.request(`/v1/agent/sessions/s-1/tool-results/${pending.calls[0]?.callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ output: { found: 'yes' } }),
    })
    await expect(response.json()).resolves.toEqual({ type: 'final', output: '已识别工具输出无效' })
    database.close()
  })

  it('跨 session 回填被拒绝', async () => {
    stubToolCall('browser_locate_element', { role: 'greetButton' })
    const { app, database } = await bff()
    const pending = (await (await run(app, 's-1', '定位')).json()) as { calls: Array<{ callId: string }> }
    const response = await app.request(`/v1/agent/sessions/s-other/tool-results/${pending.calls[0]?.callId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ output: { found: true } }),
    })
    await expect(response.json()).resolves.toMatchObject({ code: 'PENDING_CALL_NOT_FOUND' })
    database.close()
  })

  it('会话按已认证主体隔离命名空间', async () => {
    stubFinal('ok')
    const { app, runtime, database } = await bff()
    await run(app, 's-1', '你好')
    // 主体前缀绑定：扩展传的 s-1 实际落在 browser-extension:s-1 下。
    await expect(runtime.sessions.load('browser-extension:s-1')).resolves.not.toHaveLength(0)
    await expect(runtime.sessions.load('s-1')).resolves.toHaveLength(0)
    database.close()
  })

  it('把工具清单作为 tools 字段发给模型', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { app, database } = await bff()
    await run(app, 's-1', '你好')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { tools?: Array<{ function: { name: string } }> }
    expect(body.tools?.map((tool) => tool.function.name)).toEqual(browserToolDefinitions.map((tool) => tool.name))
    database.close()
  })
})

describe('browser-extension-bff 日志与错误红线', () => {
  it('错误响应只含 code/requestId/message 且不回显 Prompt 与密钥', async () => {
    const { app, database } = await bff({ withLlm: false })
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ input: 'prompt-secret-content', context: { apiKey: 'sk-leaked-value' } }),
    })
    const text = await response.text()
    expect(text).not.toContain('prompt-secret-content')
    expect(text).not.toContain('sk-leaked-value')
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['code', 'message', 'requestId'])
    database.close()
  })
})

describe('浏览器工具定义', () => {
  it('全部工具声明为 remote，不在服务端执行', () => {
    expect(browserToolDefinitions.every((tool) => tool.execution === 'remote')).toBe(true)
    expect(browserToolDefinitions.every((tool) => tool.execute === undefined)).toBe(true)
  })

  it('覆盖闭环所需的全部工具', () => {
    expect(browserToolDefinitions.map((tool) => tool.name)).toEqual([
      'browser_snapshot',
      'browser_read_page',
      'browser_locate_element',
      'browser_click',
      'browser_hover',
      'browser_wait_for',
      'browser_input_text',
      'browser_press_key',
      'browser_scroll',
      'browser_verify',
      'browser_screenshot',
      'browser_go_back',
      'browser_save_file',
      'browser_read_file',
      'browser_write_file',
    ])
  })

  it('每个工具都有供模型理解用途的说明', () => {
    expect(browserToolDefinitions.every((tool) => (tool.description ?? '').length > 0)).toBe(true)
  })

  it('snapshot 是第一个工具，引导模型先看清页面', () => {
    // 自由指令下模型若不先快照就会凭猜测写选择器，这是最主要的失败来源。
    expect(browserToolDefinitions[0]?.name).toBe('browser_snapshot')
  })

  it('click 与 input_text 接受 ref，不强制传坐标', () => {
    for (const name of ['browser_click', 'browser_input_text']) {
      const tool = browserToolDefinitions.find((item) => item.name === name)
      const schema = toToolSchema(tool!)
      const properties = (schema.parameters as { properties: Record<string, unknown> }).properties
      expect(properties.ref, `${name} 缺少 ref`).toBeDefined()
      // 坐标必须可选，否则模型被迫先 locate 一次，ref 就失去意义了。
      const required = (schema.parameters as { required?: string[] }).required ?? []
      expect(required, `${name} 的坐标不应是必填`).not.toContain('x')
      expect(required).not.toContain('y')
    }
  })

  it('locate_element 的 role 已改为可选，不再绑死 BOSS 角色枚举', () => {
    const tool = browserToolDefinitions.find((item) => item.name === 'browser_locate_element')
    const required = (toToolSchema(tool!).parameters as { required?: string[] }).required ?? []
    expect(required).not.toContain('role')
  })

  it('全部工具的 input schema 都能转成 JSON Schema', () => {
    // 转换失败会让整轮 LLM 调用抛错，必须在这里挡住。
    for (const tool of browserToolDefinitions) {
      expect(() => toToolSchema(tool), `${tool.name} 无法转换`).not.toThrow()
    }
  })
})

describe('提示词注册', () => {
  it('free-form 为默认提示词', async () => {
    const { prompts, database } = await bff()
    expect(prompts.getDefault()?.name).toBe('free-form')
    database.close()
  })

  it('三个提示词均可按名取到', async () => {
    const { prompts, database } = await bff()
    for (const name of ['free-form', 'browser-automation', 'candidate-assessment']) {
      expect(prompts.getByName(name), `${name} 未注册`).toBeDefined()
    }
    database.close()
  })

  it('只有 candidate-assessment 声明输出协议', async () => {
    const { prompts, database } = await bff()
    expect(prompts.getByName('free-form')?.protocol).toBeUndefined()
    expect(prompts.getByName('candidate-assessment')?.protocol).toBeDefined()
    database.close()
  })

  it('自由指令提示词交代先快照后动作', async () => {
    const { prompts, database } = await bff()
    const prompt = prompts.getByName('free-form')?.prompt ?? ''
    expect(prompt).toContain('browser_snapshot')
    expect(prompt).toContain('ref')
    database.close()
  })

  it('按名指定 candidate-assessment 时其输出协议生效', async () => {
    // 这是 harness getDefault() 缺陷的端到端回归：此前该协议永远不可达。
    stubFinal(JSON.stringify({ decisions: 'not-an-array' }))
    const { app, database } = await bff()
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ input: '评估', context: {}, promptName: 'candidate-assessment' }),
    })
    await expect(response.json()).resolves.toMatchObject({ code: 'LLM_OUTPUT_PROTOCOL_INVALID' })
    database.close()
  })

  it('promptName 非字符串时返回 REQUEST_INVALID', async () => {
    const { app, database } = await bff()
    const response = await app.request('/v1/agent/sessions/s-1/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ input: 'hi', context: {}, promptName: 123 }),
    })
    expect(response.status).toBe(400)
    database.close()
  })
})
