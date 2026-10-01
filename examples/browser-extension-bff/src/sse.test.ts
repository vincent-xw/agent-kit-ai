import { afterEach, describe, expect, it, vi } from 'vitest'
import { serve } from '@hono/node-server'
import { createBrowserExtensionBff } from './server.js'

const masterKey = 'A'.repeat(43)
const llm = { apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' }

afterEach(() => vi.unstubAllGlobals())

async function start() {
  const bff = createBrowserExtensionBff({
    masterKey,
    apiToken: 'token-1',
    databasePath: ':memory:',
    llm,
  })
  await bff.ready
  const server = serve({ fetch: (req: Request) => bff.app.fetch(req), port: 0 }, (info: { port: number }) => info)
  const port = (server.address() as { port: number }).port
  return { bff, port, close: () => server.close() }
}

/** Mock only LLM API calls; pass through local HTTP requests to the real server. */
function stubLlmFetch(handler: (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>) {
  const originalFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      if (urlStr.includes('127.0.0.1') || urlStr.includes('localhost')) {
        return originalFetch(url, init)
      }
      return handler(urlStr)
    }),
  )
}

async function readUntil(body: ReadableStream<Uint8Array>, marker: string, timeoutMs = 5000): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes(marker)) return text
    }
  } finally {
    reader.releaseLock()
  }
  return text
}

describe('SSE /api/events', () => {
  it('rejects missing token with 401', async () => {
    const { port, close } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/events`)
    expect(res.status).toBe(401)
    close()
  })

  it('returns text/event-stream on valid token', async () => {
    const { port, close } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body!.cancel()
    close()
  })

  it('emits tool_call events via bus', async () => {
    const { bff, port, close } = await start()
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((r) => setTimeout(r, 300))

    bff.bus.emit({ type: 'tool_call', callId: 'c1', toolName: 'browser_click', input: {}, sessionId: 's1' })

    const text = await readUntil(res.body!, 'browser_click')
    expect(text).toContain('event: tool_call')
    expect(text).toContain('browser_click')
    close()
  })
})

describe('POST /api/execute', () => {
  it('starts execution and emits tool_call via SSE', async () => {
    stubLlmFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'browser_click', arguments: '{}' } }] } }],
      }),
    }))

    const { port, close } = await start()

    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((r) => setTimeout(r, 200))

    const execRes = await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ sessionId: 's1', input: '点击', context: {} }),
    })
    expect(execRes.status).toBe(202)

    const text = await readUntil(sseRes.body!, 'browser_click')
    expect(text).toContain('browser_click')
    close()
  })

  it('emits final via SSE when model returns text', async () => {
    stubLlmFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '任务完成' } }],
      }),
    }))

    const { port, close } = await start()
    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((r) => setTimeout(r, 200))

    await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ sessionId: 's2', input: '你好', context: {} }),
    })

    const text = await readUntil(sseRes.body!, '任务完成')
    expect(text).toContain('event: final')
    close()
  })
})

describe('POST /api/tool-results/:callId', () => {
  it('resumes and emits next events via SSE', async () => {
    let callCount = 0
    stubLlmFetch(async () => {
      callCount += 1
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { tool_calls: [{ id: 'call-1', function: { name: 'browser_click', arguments: '{}' } }] } }],
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '已点击' } }] }),
      }
    })

    const { port, close } = await start()
    const sseRes = await fetch(`http://127.0.0.1:${port}/api/events?token=token-1`)
    await new Promise((r) => setTimeout(r, 200))

    await fetch(`http://127.0.0.1:${port}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ sessionId: 's1', input: '点击', context: {} }),
    })
    await readUntil(sseRes.body!, 'tool_call')

    const resultRes = await fetch(`http://127.0.0.1:${port}/api/tool-results/call-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer token-1' },
      body: JSON.stringify({ sessionId: 's1', output: { ok: true, message: 'clicked' } }),
    })
    expect(resultRes.status).toBe(202)

    const text = await readUntil(sseRes.body!, '已点击')
    expect(text).toContain('event: final')
    close()
  })
})
