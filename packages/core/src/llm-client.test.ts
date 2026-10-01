import { afterEach, describe, expect, it, vi } from 'vitest'

import { createLlmClient } from './index.js'

const baseConfig = { apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

/** 读取被 stub 的 fetch 第一次调用的请求体。 */
function bodyOf(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const firstCall = fetchMock.mock.calls[0]
  expect(firstCall).toBeDefined()
  const [, init] = firstCall as unknown as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/** 构造一个返回固定文本的 fetch stub。 */
function okFetch(payload: unknown = { choices: [{ message: { content: 'ok' } }] }) {
  return vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => payload }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LlmClient', () => {
  it('解析文本输出为 final', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({ type: 'final', output: '你好' })
  })

  it('解析单个 tool_calls 为复数结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '我先查询天气。', tool_calls: [{ id: 'call-1', function: { name: 'weather.read', arguments: '{"city":"上海"}' } }] } }] }),
    })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({
      type: 'tool_calls',
      calls: [{ callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } }],
      content: '我先查询天气。',
    })
  })

  it('解析一轮内的多个 tool_calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'c1', function: { name: 'a.run', arguments: '{}' } },
                { id: 'c2', function: { name: 'b.run', arguments: '{"x":1}' } },
              ],
            },
          },
        ],
      }),
    })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({
      type: 'tool_calls',
      calls: [
        { callId: 'c1', toolName: 'a.run', input: {} },
        { callId: 'c2', toolName: 'b.run', input: { x: 1 } },
      ],
    })
  })

  it('HTTP 非 2xx 返回 LLM_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('服务端返回带 trace_id 的模糊 400 后重试并可恢复', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'invalid request error trace_id: 8341e148832303040386d8f1d72200ac', type: 'invalid_request_error' }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })
    vi.stubGlobal('fetch', fetchMock)

    const client = createLlmClient({ ...baseConfig, maxRetries: 2 })
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({ type: 'final', output: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('服务端返回带 trace_id 的模糊 400 后流式请求也会重试', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'invalid request error trace_id: c5415a94053405c456cc20326f88c4bd', type: 'invalid_request_error' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const client = createLlmClient({ ...baseConfig, maxRetries: 2, onDelta: () => {} })
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).resolves.toEqual({ type: 'final', output: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('普通 invalid_request_error 400 不重试', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'model parameter is invalid', type: 'invalid_request_error' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createLlmClient({ ...baseConfig, maxRetries: 3 })
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('带 trace_id 的模糊 400 用尽默认重试后停止', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ message: 'invalid request error trace_id: 8341e148832303040386d8f1d72200ac', type: 'invalid_request_error' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('响应不是有效 JSON 返回 LLM_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })))
    const client = createLlmClient(baseConfig)
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('请求超时返回 LLM_RESPONSE_INVALID', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const client = createLlmClient({ ...baseConfig, timeoutMs: 50 })
    await expect(client.complete({ input: 'hi', context: {}, messages: [] })).rejects.toMatchObject({ code: 'LLM_RESPONSE_INVALID' })
  })

  it('外部 signal 取消请求时不重试并中止 fetch', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient({ ...baseConfig, maxRetries: 3 })
    const controller = new AbortController()
    const running = client.complete({ input: 'hi', context: {}, messages: [], signal: controller.signal })
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('请求携带 Bearer 密钥并构造 OpenAI 协议消息', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: { city: '上海' }, messages: [{ role: 'user', content: '你好' }], systemPrompt: '你是助手' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string) as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是助手' })
    expect(body.messages[1]).toEqual({ role: 'system', content: 'context: {"city":"上海"}' })
    expect(body.messages[body.messages.length - 1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('配置思考强度时请求体发送 reasoning_effort', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient({ ...baseConfig, reasoningEffort: 'high' })

    await client.complete({ input: 'hi', context: {}, messages: [] })

    expect(bodyOf(fetchMock).reasoning_effort).toBe('high')
  })

  it('OpenCode Go Provider 请求携带当前 sessionId Header', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient({ ...baseConfig, provider: 'opencode-go' })

    await client.complete({ input: 'hi', context: {}, messages: [], sessionId: 'session-1' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('session-1')
  })

  it('默认 OpenAI 兼容 Provider 不携带非标准 OpenCode Header', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)

    await client.complete({ input: 'hi', context: {}, messages: [], sessionId: 'session-1' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers as Record<string, string>).not.toHaveProperty('x-opencode-session')
  })

  it('OpenCode Go Provider 的流式请求也携带当前 sessionId Header', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient({ ...baseConfig, provider: 'opencode-go', onDelta: () => {} })

    await client.complete({ context: {}, messages: [], sessionId: 'session-stream' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('session-stream')
  })

  it('收到 SSE [DONE] 后立即结束流读取，不等待上游关闭连接', async () => {
    const encoder = new TextEncoder()
    let readCount = 0
    const reader = {
      async read() {
        readCount += 1
        if (readCount === 1) {
          return {
            done: false,
            value: encoder.encode('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),
          }
        }
        // 真实代理可能在 [DONE] 后保持 HTTP 连接；读取到这里说明实现没有及时收口。
        throw new Error('不应在 [DONE] 后继续读取 SSE')
      },
      releaseLock() {},
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: { getReader: () => reader },
    })))

    const client = createLlmClient({ ...baseConfig, onDelta: () => {} })
    await expect(client.complete({ context: {}, messages: [] })).resolves.toEqual({ type: 'final', output: '完成' })
    expect(readCount).toBe(1)
  })

  it('携带 tools 声明时请求体包含 tools 字段', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({
      input: 'hi',
      context: {},
      messages: [],
      tools: [{ name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } }],
    })
    expect(bodyOf(fetchMock).tools).toEqual([
      { type: 'function', function: { name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } } },
    ])
  })

  it('tools 为空数组时不发送 tools 字段', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: {}, messages: [], tools: [] })
    expect(bodyOf(fetchMock)).not.toHaveProperty('tools')
  })

  it('普通 JSON 请求不发送 Tool Choice 新字段', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)

    await client.complete({ context: {}, messages: [] })

    expect(bodyOf(fetchMock)).not.toHaveProperty('tool_choice')
    expect(bodyOf(fetchMock)).not.toHaveProperty('parallel_tool_calls')
  })

  it('受约束的 JSON 请求发送 none 与精确 Tool Choice', async () => {
    const noneFetch = okFetch()
    vi.stubGlobal('fetch', noneFetch)
    const noneClient = createLlmClient(baseConfig)
    await noneClient.complete({ context: {}, messages: [], toolChoice: { type: 'none' } })
    expect(bodyOf(noneFetch)).toHaveProperty('tool_choice', 'none')

    const toolFetch = okFetch({ choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'browser_click', arguments: '{}' } }] } }] })
    vi.stubGlobal('fetch', toolFetch)
    const toolClient = createLlmClient(baseConfig)
    await toolClient.complete({
      context: {},
      messages: [],
      tools: [{ name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } }],
      toolChoice: { type: 'tool', toolName: 'browser_click' },
      parallelToolCalls: false,
    })
    expect(bodyOf(toolFetch)).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'browser_click' } },
      parallel_tool_calls: false,
      tools: [{ type: 'function', function: { name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } } }],
    })
  })

  it('普通流式请求保持旧请求体，受约束流式请求发送精确 Tool Choice', async () => {
    const createStreamFetch = () => vi.fn(async (_url: string, _init: RequestInit) => {
      const encoder = new TextEncoder()
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'))
            controller.close()
          },
        }),
      }
    })
    const plainFetch = createStreamFetch()
    vi.stubGlobal('fetch', plainFetch)
    const plainClient = createLlmClient({ ...baseConfig, onDelta: () => {} })
    await plainClient.complete({ context: {}, messages: [] })
    expect(bodyOf(plainFetch)).not.toHaveProperty('tool_choice')
    expect(bodyOf(plainFetch)).not.toHaveProperty('parallel_tool_calls')

    const constrainedFetch = createStreamFetch()
    vi.stubGlobal('fetch', constrainedFetch)
    const constrainedClient = createLlmClient({ ...baseConfig, onDelta: () => {} })
    await constrainedClient.complete({
      context: {},
      messages: [],
      tools: [{ name: 'browser_click', description: '点击', parameters: { type: 'object', properties: {} } }],
      toolChoice: { type: 'tool', toolName: 'browser_click' },
      parallelToolCalls: false,
    })
    expect(bodyOf(constrainedFetch)).toMatchObject({
      tool_choice: { type: 'function', function: { name: 'browser_click' } },
      parallel_tool_calls: false,
    })
  })

  it('tool 消息携带 tool_call_id', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({
      context: {},
      messages: [{ role: 'tool', content: { temperature: 26 }, callId: 'call-9' }],
    })
    const body = bodyOf(fetchMock) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({ role: 'tool', content: '{"temperature":26}', tool_call_id: 'call-9' })
  })

  it('assistant 消息携带 tool_calls 并回传原 callId', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({
      context: {},
      messages: [
        { role: 'assistant', content: null, toolCalls: [{ callId: 'call-1', toolName: 'weather.read', input: { city: '上海' } }] },
        { role: 'tool', content: { temperature: 26 }, callId: 'call-1' },
      ],
    })
    const body = bodyOf(fetchMock) as { messages: Array<Record<string, unknown>> }
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'weather.read', arguments: '{"city":"上海"}' } }],
    })
    expect(body.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
  })

  it('声明 JSON 输出协议时请求体带 response_format', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const client = createLlmClient(baseConfig)
    await client.complete({ input: 'hi', context: {}, messages: [], responseFormatJson: true })
    expect(bodyOf(fetchMock).response_format).toEqual({ type: 'json_object' })
  })
})

import type { LlmTraceEvent } from './llm-client.js'

describe('usage parsing', () => {
  it('response usage 进入 trace 事件', async () => {
    const events: LlmTraceEvent[] = []
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    })

    const client = createLlmClient({ apiKey: 'k', baseUrl: 'http://localhost', model: 'm', trace: (e) => events.push(e) })
    await client.complete({ context: {}, messages: [{ role: 'user', content: 'hi' }] })

    const responseEvent = events.find((e) => e.phase === 'response')
    expect(responseEvent).toMatchObject({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })
  })

  it('流式同轮同时返回 content 和 tool_calls 时保留 assistant content', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const chunks = [
          'data: {"choices":[{"delta":{"reasoning_content":"先看屏幕"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"content":"我来看看手机屏幕。"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"mobile_snapshot","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }), body: stream,
    })
    const client = createLlmClient({ apiKey: 'k', baseUrl: 'http://localhost', model: 'm', onDelta: () => {} })
    const result = await client.complete({ context: {}, messages: [{ role: 'user', content: '看屏幕' }] })
    expect(result).toEqual({
      type: 'tool_calls',
      calls: [{ callId: 'call-1', toolName: 'mobile_snapshot', input: {} }],
      content: '我来看看手机屏幕。',
      reasoning: '先看屏幕',
    })
  })

  it('流式末尾 usage chunk 进入 trace 事件', async () => {
    const events: LlmTraceEvent[] = []
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const chunks = [
          'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: {"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
          'data: [DONE]\n\n',
        ]
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    })

    const client = createLlmClient({ apiKey: 'k', baseUrl: 'http://localhost', model: 'm', trace: (e) => events.push(e), onDelta: () => {} })
    const result = await client.complete({ context: {}, messages: [{ role: 'user', content: 'hi' }] })

    expect(result).toEqual({ type: 'final', output: '你好' })
    const responseEvent = events.find((e) => e.phase === 'response')
    expect(responseEvent).toMatchObject({ promptTokens: 4, completionTokens: 2, totalTokens: 6 })
    expect(responseEvent?.responseBody).toMatchObject({ content_length: 2 })
  })

  it('流式 tool_calls 保留工具调用前已经输出的正文', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const chunks = [
          'data: {"choices":[{"delta":{"content":"我先读取页面。"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"mobile_snapshot","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    })

    const deltas: Array<{ content?: string }> = []
    const client = createLlmClient({ ...baseConfig, onDelta: (delta) => deltas.push(delta) })
    await expect(client.complete({ context: {}, messages: [] })).resolves.toEqual({
      type: 'tool_calls',
      calls: [{ callId: 'call-1', toolName: 'mobile_snapshot', input: {} }],
      content: '我先读取页面。',
    })
    expect(deltas).toContainEqual({ content: '我先读取页面。' })
  })

  it('流式工具调用轮次识别 OpenCode Go 的 delta.reasoning', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        const chunks = [
          'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"先检查设备状态"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"，再调用工具"},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"role":"assistant","content":"","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"mobile_snapshot","arguments":"{}"}}]},"finish_reason":null}]}\n\n',
          'data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: stream,
    })

    const deltas: Array<{ reasoning?: string }> = []
    const client = createLlmClient({ ...baseConfig, onDelta: (delta) => deltas.push(delta) })
    await expect(client.complete({ context: {}, messages: [] })).resolves.toMatchObject({
      type: 'tool_calls',
      reasoning: '先检查设备状态，再调用工具',
    })
    expect(deltas).toEqual([
      { reasoning: '先检查设备状态' },
      { reasoning: '，再调用工具' },
    ])
  })
})
