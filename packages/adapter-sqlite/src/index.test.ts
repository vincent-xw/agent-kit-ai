import type { ContextManager, LlmTraceEvent } from '@agentkit-ai/core'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createSqliteAgentRuntime, createSqlitePendingCallStore, createSqliteSecretProvider, createSqliteSessionStore } from './index.js'

const validMasterKey = 'A'.repeat(43)
const otherMasterKey = 'B'.repeat(43)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SQLite SecretProvider', () => {
  it('只保存加密后的 API Key', async () => {
    const database = new DatabaseSync(':memory:')
    const provider = createSqliteSecretProvider({
      database,
      masterKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })

    await provider.put({ apiKey: 'sk-secret-value', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
    expect(database.prepare('SELECT ciphertext FROM agent_secrets WHERE id = ?').get('default')).not.toMatchObject({ ciphertext: expect.stringContaining('sk-secret-value') })
    await expect(provider.get()).resolves.toEqual({ apiKey: 'sk-secret-value', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
  })

  it('按槽位读写密钥互不串档，删除槽位只清空自己', async () => {
    const database = new DatabaseSync(':memory:')
    const legacy = createSqliteSecretProvider({ database, masterKey: validMasterKey })
    const slotA = createSqliteSecretProvider({ database, masterKey: validMasterKey, id: 'llm:a' })
    const slotB = createSqliteSecretProvider({ database, masterKey: validMasterKey, id: 'llm:b' })

    await slotA.put({ apiKey: 'sk-a', baseUrl: 'https://a.example.test/v1', model: 'model-a' })
    await slotB.put({ apiKey: 'sk-b', baseUrl: 'https://b.example.test/v1', model: 'model-b' })

    await expect(slotA.get()).resolves.toMatchObject({ apiKey: 'sk-a', model: 'model-a' })
    await expect(slotB.get()).resolves.toMatchObject({ apiKey: 'sk-b', model: 'model-b' })
    // default 槽位没有被写入过，必须保持未配置状态。
    await expect(legacy.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })

    slotA.delete()
    await expect(slotA.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
    await expect(slotB.get()).resolves.toMatchObject({ apiKey: 'sk-b' })
    // 重复删除是幂等的，不能抛错。
    expect(() => slotA.delete()).not.toThrow()
  })

  it('SQLite session store 持久化受控消息', async () => {
    const database = new DatabaseSync(':memory:')
    const store = createSqliteSessionStore(database)
    await store.save('s-1', [{ role: 'user', content: '你好' }])
    await expect(store.load('s-1')).resolves.toEqual([{ role: 'user', content: '你好' }])
  })

  it('SQLite runtime 拒绝非 32 字节主密钥', () => {
    const database = new DatabaseSync(':memory:')
    expect(() => createSqliteAgentRuntime({ database, masterKey: 'short-key' })).toThrowError(/32 字节/)
  })

  it('key_version 与主密钥不匹配时拒绝解密', async () => {
    const database = new DatabaseSync(':memory:')
    const provider = createSqliteSecretProvider({ database, masterKey: validMasterKey })
    await provider.put({ apiKey: 'sk-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })

    const other = createSqliteSecretProvider({ database, masterKey: otherMasterKey })
    await expect(other.get()).rejects.toMatchObject({ code: 'SECRET_NOT_CONFIGURED' })
  })

  it('runtime harness 使用 SQLite 密钥完成文本输出且密文不落明文', async () => {
    const database = new DatabaseSync(':memory:')
    const runtime = createSqliteAgentRuntime({ database, masterKey: validMasterKey, maxSteps: 3 })
    await runtime.secrets.put({ apiKey: 'sk-test-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))

    await expect(runtime.harness.run({ sessionId: 's-1', input: 'hi', context: {} })).resolves.toEqual({ type: 'final', output: '你好' })
    const rows = database.prepare('SELECT ciphertext FROM agent_secrets').all() as Array<{ ciphertext: string }>
    expect(JSON.stringify(rows)).not.toContain('sk-test-value')
  })

  it('runtime 工厂将默认 Control Flow Provider 透传给 Core Harness', async () => {
    const database = new DatabaseSync(':memory:')
    const decisions: Array<{ decisionId: string; runInstanceId?: string; availableToolNames: readonly string[] }> = []
    const runtime = createSqliteAgentRuntime({
      database,
      masterKey: validMasterKey,
      maxSteps: 1,
      controlFlowDecisionProvider: { decide: async (input) => {
        decisions.push(input)
        return { type: 'finish' }
      } },
    })
    await runtime.secrets.put({ apiKey: 'sk-test-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })
    runtime.tools.register({ name: 'observe', execution: 'remote', input: z.object({}), output: z.object({}) })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '已完成' } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runtime.harness.run({ sessionId: 's-provider', runInstanceId: 'runtime-scope', input: '完成', context: {} }))
      .resolves.toMatchObject({ type: 'final', output: '已完成' })

    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ runInstanceId: 'runtime-scope', availableToolNames: ['observe'] })
    expect(decisions[0]?.decisionId).toBeTruthy()
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ tool_choice: 'none' })
    database.close()
  })

  it('runtime 将 OpenCode Go Provider 透传到 LLM 请求 Header', async () => {
    const database = new DatabaseSync(':memory:')
    const runtime = createSqliteAgentRuntime({ database, masterKey: validMasterKey, maxSteps: 3, llmProvider: 'opencode-go' })
    await runtime.secrets.put({ apiKey: 'sk-test-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '你好' } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(runtime.harness.run({ sessionId: 's-opencode', input: 'hi', context: {} })).resolves.toEqual({ type: 'final', output: '你好' })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('s-opencode')
    database.close()
  })

  it('档案级 provider 覆盖进程级 provider', async () => {
    const database = new DatabaseSync(':memory:')
    const runtime = createSqliteAgentRuntime({ database, masterKey: validMasterKey, maxSteps: 3, llmProvider: 'openai-compatible' })
    // 模拟激活后的 default 镜像：密钥里带档案级 provider。
    await runtime.secrets.put({
      apiKey: 'sk-test-value',
      baseUrl: 'https://llm.example.test/v1',
      model: 'test',
      provider: 'opencode-go',
    })
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '你好' } }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    await runtime.harness.run({ sessionId: 's-profile-provider', input: 'hi', context: {} })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-opencode-session']).toBe('s-profile-provider')
    database.close()
  })

  it('挂起调用落库，进程重启后仍可回填', async () => {
    const database = new DatabaseSync(':memory:')
    const store = createSqlitePendingCallStore(database)
    store.set('call-1', { sessionId: 's-1', toolName: 'browser_click' })
    // 换一个 store 实例模拟进程重启：状态在 SQLite 里，不在进程内存里。
    expect(createSqlitePendingCallStore(database).get('call-1')).toEqual({ sessionId: 's-1', toolName: 'browser_click' })
    store.delete('call-1')
    expect(store.get('call-1')).toBeUndefined()
  })

  it('挂起调用一并持久化 promptName', async () => {
    // 不存的话 BFF 重启后 resume 会回退到默认提示词，一次工具循环的前后两半用上不同协议。
    const database = new DatabaseSync(':memory:')
    const store = createSqlitePendingCallStore(database)
    store.set('call-2', { sessionId: 's-1', toolName: 'browser_click', promptName: 'candidate-assessment' })
    expect(createSqlitePendingCallStore(database).get('call-2')).toEqual({
      sessionId: 's-1',
      toolName: 'browser_click',
      promptName: 'candidate-assessment',
    })
  })

  it('远端工具挂起后新 runtime 实例仍能回填', async () => {
    const database = new DatabaseSync(':memory:')
    const first = createSqliteAgentRuntime({ database, masterKey: validMasterKey, maxSteps: 3 })
    await first.secrets.put({ apiKey: 'sk-test-value', baseUrl: 'https://llm.example.test/v1', model: 'test' })
    first.tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { tool_calls: [{ id: 'call-r', function: { name: 'browser_read_page', arguments: '{}' } }] } }] }),
      })),
    )
    await expect(first.harness.run({ sessionId: 's-2', input: '读取', context: {} })).resolves.toMatchObject({ type: 'pending_tool_calls' })

    // 同一个数据库、新的 runtime：挂起调用与会话都从 SQLite 恢复。
    const second = createSqliteAgentRuntime({ database, masterKey: validMasterKey, maxSteps: 3 })
    second.tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '首页' } }] }) })))
    await expect(second.harness.resume({ sessionId: 's-2', callId: 'call-r', output: { title: '首页' } })).resolves.toEqual({ type: 'final', output: '首页' })
  })

})

describe('SQLite runtime contextManager 追踪转发', () => {
  it('llmTrace 事件注入 sessionId 并转发给 contextManager.onLlmTrace', async () => {
    const database = new DatabaseSync(':memory:')
    const traceEvents: LlmTraceEvent[] = []
    const contextTraceEvents: LlmTraceEvent[] = []
    const contextManager: ContextManager & { onLlmTrace?: (event: LlmTraceEvent) => void } = {
      load: () => [],
      save: () => {},
      append: () => {},
      getSummary: () => undefined,
      onLlmTrace: (event) => contextTraceEvents.push(event),
    }
    const runtime = createSqliteAgentRuntime({
      database,
      masterKey: validMasterKey,
      maxSteps: 3,
      contextManager,
      llmTrace: (event) => traceEvents.push(event),
    })
    await runtime.secrets.put({ apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))

    await runtime.harness.run({ sessionId: 's-trace', input: 'hi', context: {} })

    expect(traceEvents.length).toBeGreaterThan(0)
    expect(contextTraceEvents.length).toBeGreaterThan(0)
    expect(traceEvents[0]).toMatchObject({ sessionId: 's-trace' })
    expect(contextTraceEvents[0]).toMatchObject({ sessionId: 's-trace' })
    database.close()
  })
})

describe('SQLite runtime 流式 delta 标注', () => {
  it('delta 携带 sessionId 且每次补全 turnId 不同', async () => {
    const database = new DatabaseSync(':memory:')
    const deltas: Array<{ content?: string; sessionId?: string; turnId?: string }> = []
    const runtime = createSqliteAgentRuntime({
      database,
      masterKey: validMasterKey,
      maxSteps: 3,
      llmDelta: (delta) => deltas.push(delta),
    })
    await runtime.secrets.put({ apiKey: 'sk-test', baseUrl: 'https://llm.example.test/v1', model: 'test-model' })
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `回复${call}` } }] }) }
    }))
    await runtime.harness.run({ sessionId: 's-delta', input: '一', context: {} })
    await runtime.harness.run({ sessionId: 's-delta', input: '二', context: {} })
    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toMatchObject({ content: '回复1', sessionId: 's-delta' })
    expect(deltas[1]).toMatchObject({ content: '回复2', sessionId: 's-delta' })
    expect(deltas[0]!.turnId).toBeTruthy()
    expect(deltas[0]!.turnId).not.toBe(deltas[1]!.turnId)
    database.close()
  })
})
