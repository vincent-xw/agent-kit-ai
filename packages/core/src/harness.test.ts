import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AgentKitError, createAgentHarness, createContextManager, createMemorySessionStore, createPromptRegistry, createToolRegistry } from './index.js'
import type { HarnessToolExecutionRequest, LlmRequest, LlmResult, PendingCall, PendingCallStore, SessionMessage, ToolCall } from './index.js'
import { looksLikeToolCallMarkup } from './harness.js'

/** 构造单个工具调用的模型响应，避免每处重复写复数壳。 */
function callsOf(...calls: ToolCall[]): LlmResult {
  return { type: 'tool_calls', calls }
}

describe('AgentHarness', () => {
  it('Default Control Flow Provider 收到的工具名与本轮实际暴露的工具完全一致', async () => {
    const tools = createToolRegistry()
    for (const name of ['visible_tool', 'filtered_tool']) {
      tools.register({
        name, execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}),
      })
    }
    const providerToolNames: string[][] = []
    let requestToolNames: string[] = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requestToolNames = request.tools?.map((tool) => tool.name) ?? []
        return { type: 'final', output: '完成' }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
      controlFlowDecisionProvider: { decide: async (input) => {
        providerToolNames.push([...input.availableToolNames])
        return null
      } },
    })

    await expect(harness.run({
      sessionId: 'control-flow-visible-tools', input: '执行', context: {}, allowedToolNames: ['visible_tool'],
    })).resolves.toMatchObject({ type: 'final', output: '完成' })

    expect(providerToolNames).toEqual([['visible_tool']])
    expect(requestToolNames).toEqual(['visible_tool'])
  })

  it('默认 Control Flow Provider 连续强制工具时保留历史工具对应的可见定义', async () => {
    const tools = createToolRegistry()
    let executions = 0
    for (const name of ['observe', 'other']) {
      tools.register({
        name, execution: 'server', input: z.object({}), output: z.object({}),
        execute: async () => { executions += 1; return {} },
      })
    }
    const sessions = createMemorySessionStore()
    const requests: LlmRequest[] = []
    const decisions: Array<{ decisionId: string; sessionId: string; runInstanceId?: string; availableToolNames: readonly string[] }> = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        if (requests.length === 1) {
          return { type: 'tool_calls', calls: [{ callId: 'selected-call', toolName: 'observe', input: {} }], content: '不得提交的正文' }
        }
        if (requests.length === 2) {
          return { type: 'tool_calls', calls: [{ callId: 'selected-call-2', toolName: 'other', input: {} }], content: '不得提交的工具正文' }
        }
        return { type: 'final', output: '完成' }
      } },
      sessions, tools, maxSteps: 3,
      controlFlowDecisionProvider: {
        decide: async (input) => {
          decisions.push(input)
          if (decisions.length === 1) return { type: 'call_tool', toolName: 'observe' }
          if (decisions.length === 2) return { type: 'call_tool', toolName: 'other' }
          return { type: 'finish' }
        },
      },
    })

    await expect(harness.run({
      sessionId: 'provider-loop', runInstanceId: 'run-scope-1', input: '观察', context: {},
    })).resolves.toMatchObject({ type: 'final', output: '完成' })

    expect(decisions).toHaveLength(3)
    expect(decisions[0]?.decisionId).not.toBe(decisions[1]?.decisionId)
    expect(decisions.map((decision) => decision.availableToolNames)).toEqual([
      ['observe', 'other'], ['observe', 'other'], ['observe', 'other'],
    ])
    expect(decisions.every((decision) => decision.runInstanceId === 'run-scope-1')).toBe(true)
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['observe', 'other'])
    expect(requests[0]?.toolChoice).toEqual({ type: 'tool', toolName: 'observe' })
    expect(requests[0]?.parallelToolCalls).toBe(false)
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: expect.arrayContaining([expect.objectContaining({ callId: 'selected-call', toolName: 'observe' })]),
      }),
    ]))
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['observe', 'other'])
    expect(requests[1]?.toolChoice).toEqual({ type: 'tool', toolName: 'other' })
    expect(requests[1]?.parallelToolCalls).toBe(false)
    expect(requests[2]?.tools).toBeUndefined()
    expect(requests[2]?.toolChoice).toEqual({ type: 'none' })
    expect(executions).toBe(2)
    const saved = await sessions.load('provider-loop')
    expect(saved.filter((message) => message.role === 'assistant')[0]).toMatchObject({ content: null })
    expect(JSON.stringify(saved)).not.toContain('不得提交的正文')
  })

  it.each([
    { label: '最终文本', result: { type: 'final' as const, output: '不能重新选择工具' } },
    { label: '不同工具', result: callsOf({ callId: 'wrong-name', toolName: 'other', input: { value: 'ok' } }) },
    { label: '多个工具', result: callsOf(
      { callId: 'first', toolName: 'observe', input: { value: 'ok' } },
      { callId: 'second', toolName: 'observe', input: { value: 'ok' } },
    ) },
    { label: '零个工具', result: { type: 'tool_calls' as const, calls: [] } },
    { label: '非法参数', result: callsOf({ callId: 'invalid-args', toolName: 'observe', input: {} }) },
  ])('成功选择工具后，$label 触发有限 generation mismatch 且不提交候选', async ({ result }) => {
    const tools = createToolRegistry()
    let executions = 0
    tools.register({
      name: 'observe', execution: 'server', input: z.object({ value: z.string() }).strict(), output: z.object({}),
      execute: async () => { executions += 1; return {} },
    })
    tools.register({ name: 'other', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    const sessions = createMemorySessionStore()
    const audits: Array<Record<string, unknown>> = []
    let selectedDecisionId = ''
    const sessionId = 'mismatch'
    const harness = createAgentHarness({
      llm: { complete: async () => result },
      sessions, tools, maxSteps: 1,
      audit: { log: (event) => { audits.push(event as unknown as Record<string, unknown>) } },
      controlFlowDecisionProvider: { decide: async (input) => {
        selectedDecisionId = input.decisionId
        return { type: 'call_tool', toolName: 'observe' }
      } },
    })

    await expect(harness.run({ sessionId, input: '观察', context: {} }))
      .rejects.toMatchObject({ code: 'CONTROL_FLOW_GENERATION_MISMATCH' })
    expect(executions).toBe(0)
    expect((await sessions.load(sessionId)).some((message) => message.role === 'assistant' || message.role === 'tool')).toBe(false)
    expect(audits.some((event) => event.errorCode === 'CONTROL_FLOW_GENERATION_MISMATCH' && event.decisionId === selectedDecisionId)).toBe(true)
  })

  it('没有 visible Tool 时不调用默认 Provider，Main LLM 使用无工具请求', async () => {
    const requests: LlmRequest[] = []
    const provider = { decide: vi.fn(async () => ({ type: 'finish' as const })) }
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return { type: 'final', output: '直接回答' }
      } },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 1,
      controlFlowDecisionProvider: provider,
    })

    await expect(harness.run({ sessionId: 'no-visible-tool', input: '回答', context: {} }))
      .resolves.toMatchObject({ type: 'final', output: '直接回答' })

    expect(provider.decide).not.toHaveBeenCalled()
    expect(requests[0]?.tools).toBeUndefined()
    expect(requests[0]?.toolChoice).toBeUndefined()
  })

  it.each([
    { label: '返回 null', decide: async () => null },
    { label: '抛出异常', decide: async () => { throw new Error('provider unavailable') } },
  ])('默认 Provider $label 时 fail-open 到普通 Main LLM 请求', async ({ decide }) => {
    const tools = createToolRegistry()
    tools.register({ name: 'one', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    tools.register({ name: 'two', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return { type: 'final', output: '普通路径完成' }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 1,
      controlFlowDecisionProvider: { decide },
    })

    await expect(harness.run({ sessionId: 'provider-fail-open', input: '继续', context: {} }))
      .resolves.toMatchObject({ type: 'final', output: '普通路径完成' })
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['one', 'two'])
    expect(requests[0]?.toolChoice).toBeUndefined()
    expect(requests[0]?.parallelToolCalls).toBeUndefined()
  })

  it('请求级 Provider 可替换默认值，显式 null 可关闭默认值', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'observe', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    const defaultProvider = { decide: vi.fn(async () => ({ type: 'finish' as const })) }
    const overrideProvider = { decide: vi.fn(async () => ({ type: 'call_tool' as const, toolName: 'observe' })) }
    const sessions = createMemorySessionStore()
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? callsOf({ callId: 'override-call', toolName: 'observe', input: {} })
          : { type: 'final', output: '直接回答' }
      } },
      sessions, tools, maxSteps: 2, controlFlowDecisionProvider: defaultProvider,
    })

    await harness.run({
      sessionId: 'provider-override', input: '观察', context: {}, stepMode: true,
      controlFlowDecisionProvider: overrideProvider,
    })
    expect(overrideProvider.decide).toHaveBeenCalledTimes(1)
    expect(defaultProvider.decide).not.toHaveBeenCalled()
    expect(requests[0]?.toolChoice).toEqual({ type: 'tool', toolName: 'observe' })

    const disabled = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return { type: 'final', output: '直接回答' }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 1, controlFlowDecisionProvider: defaultProvider,
    })
    await disabled.run({ sessionId: 'provider-disabled', input: '回答', context: {}, controlFlowDecisionProvider: null })
    expect(defaultProvider.decide).not.toHaveBeenCalled()
    expect(requests.at(-1)?.toolChoice).toBeUndefined()
    expect(requests.at(-1)?.tools?.map((tool) => tool.name)).toEqual(['observe'])
  })

  it('continue 与 resume 继承默认 Provider 和当前 runInstanceId', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'remote', execution: 'remote', input: z.object({}), output: z.object({}) })
    const decisions: Array<{ runInstanceId?: string; availableToolNames: readonly string[] }> = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => request.input
        ? callsOf({ callId: 'resume-call', toolName: 'remote', input: {} })
        : { type: 'final', output: '完成' } },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
      controlFlowDecisionProvider: { decide: async (input) => {
        decisions.push(input)
        return { type: 'finish' }
      } },
    })

    await harness.continue({ sessionId: 'continue-scope', context: {}, runInstanceId: 'scope-continue' })
    await harness.run({ sessionId: 'resume-scope', input: '发起远端调用', context: {}, runInstanceId: 'scope-resume', controlFlowDecisionProvider: null })
    await harness.resume({ sessionId: 'resume-scope', callId: 'resume-call', output: {}, runInstanceId: 'scope-resume' })

    expect(decisions.map((decision) => decision.runInstanceId)).toEqual(['scope-continue', 'scope-resume'])
    expect(decisions.every((decision) => decision.availableToolNames.includes('remote'))).toBe(true)
  })

  it('默认 Provider 取消后不降级调用 Main LLM', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'observe', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    const controller = new AbortController()
    const complete = vi.fn(async () => ({ type: 'final' as const, output: '不应调用' }))
    const harness = createAgentHarness({
      llm: { complete }, sessions: createMemorySessionStore(), tools, maxSteps: 1,
      controlFlowDecisionProvider: { decide: async () => {
        controller.abort()
        throw new Error('cancelled')
      } },
    })

    await expect(harness.run({ sessionId: 'provider-abort', input: '停止', context: {}, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTION_ABORTED' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('Jev finish 只禁用工具，未声明输出协议时不强制 JSON mode', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'observe', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return { type: 'final', output: '已完成' }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 1,
      controlFlowDecisionProvider: { decide: async () => ({ type: 'finish' }) },
    })

    await expect(harness.run({
      sessionId: 'jev-finish-no-protocol', input: '执行', context: {}, toolExecution: { execute: async () => ({}) },
    })).resolves.toMatchObject({ type: 'final', output: '已完成' })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools).toBeUndefined()
    expect(requests[0]?.responseFormatJson).toBeUndefined()
    expect(requests[0]?.systemPrompt).toContain('只输出最终结果')
  })

  it('Jev finish 在当前 Prompt 声明输出协议时启用 JSON mode', async () => {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'structured-agent', version: '1', prompt: '执行任务', protocol: z.object({ ok: z.boolean() }) })
    const tools = createToolRegistry()
    let responseFormatJson: boolean | undefined
    tools.register({ name: 'observe', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}) })
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        responseFormatJson = request.responseFormatJson
        return { type: 'final', output: JSON.stringify({ ok: true }) }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 1, prompts,
      controlFlowDecisionProvider: { decide: async () => ({ type: 'finish' }) },
    })

    await expect(harness.run({
      sessionId: 'jev-finish-protocol', input: '执行', context: {}, promptName: 'structured-agent',
      toolExecution: { execute: async () => ({}) },
    })).resolves.toMatchObject({ type: 'final', output: { ok: true } })
    expect(responseFormatJson).toBe(true)
  })

  it('JEV 精确选择工具，工具结果后的下一轮再次由 Provider 决策', async () => {
    const tools = createToolRegistry()
    let executions = 0
    tools.register({
      name: 'observe', execution: 'server', input: z.object({}), output: z.object({ observed: z.boolean() }),
      execute: async () => { executions += 1; return { observed: true } },
    })
    const requests: LlmRequest[] = []
    let providerCalls = 0
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? callsOf({ callId: 'jev-call-tools', toolName: 'observe', input: {} })
          : { type: 'final', output: '完成' }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
      controlFlowDecisionProvider: { decide: async () => {
        providerCalls += 1
        return providerCalls === 1 ? { type: 'call_tool', toolName: 'observe' } : { type: 'finish' }
      } },
    })

    await expect(harness.run({
      sessionId: 'jev-call-tools', input: '观察后完成', context: {},
    })).resolves.toMatchObject({ type: 'final', output: '完成' })

    expect(providerCalls).toBe(2)
    expect(executions).toBe(1)
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['observe'])
    expect(requests[0]?.systemPrompt).toContain('必须调用工具 observe')
    expect(requests[1]?.tools).toBeUndefined()
  })

  it.each([
    { decision: { type: 'finish' as const }, candidate: callsOf({ callId: 'mismatch-finish', toolName: 'side_effect', input: {} }) },
    { decision: { type: 'call_tool' as const, toolName: 'side_effect' }, candidate: { type: 'final' as const, output: '不应直接收口' } },
  ])('Control Flow generation_mismatch 丢弃候选并拒绝 LLM 夺回 Decision Authority（$decision.type）', async ({ decision, candidate }) => {
    const tools = createToolRegistry()
    let executions = 0
    tools.register({
      name: 'side_effect', execution: 'server', input: z.object({}), output: z.object({}),
      execute: async () => { executions += 1; return {} },
    })
    const sessions = createMemorySessionStore()
    const audits: Array<Record<string, unknown>> = []
    let decisionId = ''
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        expect(await sessions.load('jev-mismatch')).toEqual([])
        expect(request.input).toBe('保持这份用户输入')
        return candidate
      } },
      sessions, tools, maxSteps: 2,
      audit: { log: (event) => { audits.push(event as unknown as Record<string, unknown>) } },
      controlFlowDecisionProvider: { decide: async (input) => {
        decisionId = input.decisionId
        return decision
      } },
    })

    await expect(harness.run({
      sessionId: 'jev-mismatch', input: '保持这份用户输入', context: { attempt: 1 },
    })).rejects.toMatchObject({ code: 'CONTROL_FLOW_GENERATION_MISMATCH' })

    expect(audits).toContainEqual(expect.objectContaining({ errorCode: 'CONTROL_FLOW_GENERATION_MISMATCH', decisionId }))
    expect((await sessions.load('jev-mismatch')).filter((message) => message.role === 'assistant' || message.role === 'tool')).toEqual([])
    expect(executions).toBe(0)
  })

  it('请求级 toolExecution 将已解析 Tool、输入、身份和 AbortSignal 交给宿主', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'server_tool', execution: 'server', input: z.object({ value: z.string() }),
      output: z.object({ ok: z.boolean() }), execute: async () => ({ ok: false }),
    })
    const requests: HarnessToolExecutionRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => request.messages.some((message) => message.role === 'tool')
          ? { type: 'final', output: '完成' }
          : callsOf({ callId: 'host-call-1', toolName: 'server_tool', input: { value: 'x' } }),
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({
      sessionId: 'agent-session', input: '执行任务', context: {},
      allowedToolNames: ['server_tool'], maxSteps: 3,
      toolExecution: { execute: async (request) => { requests.push(request); return { ok: true } } },
    })).resolves.toMatchObject({ type: 'final', output: '完成' })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      tool: { name: 'server_tool' }, input: { value: 'x' }, sessionId: 'agent-session', callId: 'host-call-1',
    })
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('带 Tool Loop 的结构化 Agent 不发送 response_format JSON，最终仍由 Harness 校验协议', async () => {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'agent', version: '1', prompt: '执行受控任务', protocol: z.object({ ok: z.boolean() }) })
    const tools = createToolRegistry()
    tools.register({
      name: 'observe', execution: 'server', input: z.object({}), output: z.object({}), execute: async () => ({}),
    })
    const responseFormatFlags: Array<boolean | undefined> = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          responseFormatFlags.push(request.responseFormatJson)
          return { type: 'final', output: JSON.stringify({ ok: true }) }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 2, prompts,
    })

    await expect(harness.run({
      sessionId: 'agent-protocol', input: '执行', context: {}, promptName: 'agent',
      allowedToolNames: ['observe'], toolExecution: { execute: async () => ({}) },
    })).resolves.toMatchObject({ type: 'final', output: { ok: true } })
    expect(responseFormatFlags).toEqual([undefined])
  })

  it('最终输出不是协议 JSON 时补要一次，补正成功仍按正常收口返回', async () => {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'agent', version: '1', prompt: '执行受控任务', protocol: z.object({ ok: z.boolean() }) })
    const sessions = createMemorySessionStore()
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          // 真机样本：模型拿到工具结果后直接用自然语言收尾，整段不是 JSON。
          return requests.length === 1
            ? { type: 'final', output: '已获得业务方口径，折扣下限是 85 折。' }
            : { type: 'final', output: JSON.stringify({ ok: true }) }
        },
      },
      sessions, tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 'repair-ok', input: '执行', context: {}, promptName: 'agent' }))
      .resolves.toMatchObject({ type: 'final', output: { ok: true } })
    expect(requests).toHaveLength(2)
    // 补正请求不能再带工具，否则模型可能把失败动作重复执行一遍。
    expect(requests[1]?.tools).toBeUndefined()
    expect(requests[1]?.systemPrompt).toContain('只输出符合该协议的完整 JSON')
    // 不合协议的那轮与补正结果都留在会话里，刷新后能看到真实发生过什么。
    const assistantMessages = (await sessions.load('repair-ok')).filter((message) => message.role === 'assistant')
    expect(assistantMessages).toHaveLength(2)
  })

  it('补正请求必须带上具体校验错误，否则模型会重复同一个错误', async () => {
    // 真机样本：第一次补正只说「不符合协议」，模型第二次仍然漏掉必填的 error 字段，
    // 整轮 Run 依旧失败。补正只有一次机会，必须把 Zod 的字段路径原样告诉模型。
    const prompts = createPromptRegistry()
    prompts.register({ name: 'agent', version: '1', prompt: '执行受控任务', protocol: z.object({ ok: z.boolean(), error: z.string().nullable() }) })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? { type: 'final', output: JSON.stringify({ ok: true }) }
            : { type: 'final', output: JSON.stringify({ ok: true, error: null }) }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 'repair-detail', input: '执行', context: {}, promptName: 'agent' }))
      .resolves.toMatchObject({ type: 'final', output: { ok: true, error: null } })
    // 补正指令必须点名缺失的字段，而不是泛泛说「不符合协议」。
    expect(requests[1]?.systemPrompt).toContain('error')
    expect(requests[1]?.systemPrompt).toContain('校验器给出的具体问题')
    // 补正请求必须开 JSON 模式：它没有工具，正是最该约束输出格式的时候。
    // 真机样本里补正漏了这个开关，模型又吐了一段带未转义引号的非法 JSON。
    expect(requests[1]?.responseFormatJson).toBe(true)
  })

  it('补正后仍不合协议时才抛出 LLM_OUTPUT_PROTOCOL_INVALID', async () => {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'agent', version: '1', prompt: '执行受控任务', protocol: z.object({ ok: z.boolean() }) })
    let calls = 0
    const harness = createAgentHarness({
      llm: { complete: async () => { calls += 1; return { type: 'final', output: '还是自然语言' } } },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 'repair-fail', input: '执行', context: {}, promptName: 'agent' }))
      .rejects.toMatchObject({ code: 'LLM_OUTPUT_PROTOCOL_INVALID' })
    // 只补一次，不做无限重试。
    expect(calls).toBe(2)
  })

  it('请求级 maxSteps 不能超过宿主上限', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'bounded_tool', execution: 'server', input: z.object({}), output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    let modelCalls = 0
    const harness = createAgentHarness({
      llm: { complete: async () => { modelCalls += 1; return callsOf({ callId: `bounded-${modelCalls}`, toolName: 'bounded_tool', input: {} }) } },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await expect(harness.run({
      sessionId: 'bounded-session', input: '执行', context: {}, maxSteps: 99,
    })).rejects.toMatchObject({ code: 'HARNESS_STEP_LIMIT' })
    expect(modelCalls).toBe(2)
  })

  it('宿主回调抛出 TOOL_EXECUTION_UNCERTAIN 时走收口补全，且不再调用工具', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'uncertain_tool', execution: 'server', input: z.object({}), output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    const requests: LlmRequest[] = []
    let modelCalls = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          modelCalls += 1
          return modelCalls === 1
            ? callsOf({ callId: 'uncertain-1', toolName: 'uncertain_tool', input: {} })
            : { type: 'final', output: '结果不确定，已停止，请确认后让我继续。' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const result = await harness.run({
      sessionId: 'uncertain-session', input: '执行副作用', context: {},
      toolExecution: { execute: async () => { throw new AgentKitError('TOOL_EXECUTION_UNCERTAIN', '结果未知') } },
    })

    expect(result).toMatchObject({ type: 'final', output: expect.stringContaining('结果不确定') })
    expect(modelCalls).toBe(2)
    // 收口补全必须禁用工具，避免把不确定的副作用再发起一次。
    expect(requests.at(-1)?.tools).toBeUndefined()
  })

  it('宿主回调返回带稳定错误码的普通 Error 时同样走收口补全', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'plain_uncertain_tool', execution: 'server', input: z.object({}), output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    let modelCalls = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          modelCalls += 1
          return modelCalls === 1
            ? callsOf({ callId: 'plain-uncertain-1', toolName: 'plain_uncertain_tool', input: {} })
            : { type: 'final', output: '结果不确定，已停止，请确认后让我继续。' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({
      sessionId: 'plain-uncertain-session', input: '执行副作用', context: {},
      toolExecution: { execute: async () => { throw Object.assign(new Error('结果未知'), { code: 'TOOL_EXECUTION_UNCERTAIN' }) } },
    })).resolves.toMatchObject({ type: 'final', output: expect.stringContaining('结果不确定') })
    expect(modelCalls).toBe(2)
  })

  it('父级 AbortSignal 会传播到宿主 Tool 回调并中止等待', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'abortable_tool', execution: 'server', input: z.object({}), output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    const controller = new AbortController()
    let request: HarnessToolExecutionRequest | undefined
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'abort-1', toolName: 'abortable_tool', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const running = harness.run({
      sessionId: 'abort-session', input: '执行', context: {}, signal: controller.signal,
      toolExecution: { execute: async (value) => {
        request = value
        started()
        await new Promise<void>((_resolve, reject) => {
          value.signal.addEventListener('abort', () => reject(new AgentKitError('TOOL_EXECUTION_ABORTED', '已取消')), { once: true })
        })
        return { ok: true }
      } },
    })
    await startedPromise
    controller.abort()
    await expect(running).rejects.toMatchObject({ code: 'TOOL_EXECUTION_ABORTED' })
    expect(request?.signal.aborted).toBe(true)
  })

  it('请求级白名单只把允许的 Tool 暴露给模型并执行', async () => {
    const tools = createToolRegistry()
    const executed: string[] = []
    tools.register({
      name: 'host_xlsx_inspect', execution: 'server', input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => { executed.push('host_xlsx_inspect'); return { ok: true } },
    })
    tools.register({
      name: 'host_file_write', execution: 'server', input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => { executed.push('host_file_write'); return { ok: true } },
    })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'inspect-1', toolName: 'host_xlsx_inspect', input: {} })
            : { type: 'final', output: '完成' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({
      sessionId: 's-allowlist', input: '读取文件', context: {},
      allowedToolNames: ['host_xlsx_inspect'],
    })).resolves.toMatchObject({ type: 'final', output: '完成' })
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['host_xlsx_inspect'])
    expect(executed).toEqual(['host_xlsx_inspect'])
  })

  it('模型调用白名单外的 Tool 时不执行，并收到受限可用列表', async () => {
    const tools = createToolRegistry()
    let writeCount = 0
    tools.register({
      name: 'host_file_write', execution: 'server', input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => { writeCount += 1; return { ok: true } },
    })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'write-1', toolName: 'host_file_write', input: {} })
            : { type: 'final', output: '已停止写入' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({
      sessionId: 's-deny-allowlist', input: '写文件', context: {},
      allowedToolNames: [],
    })).resolves.toMatchObject({ type: 'final', output: '已停止写入' })
    expect(writeCount).toBe(0)
    expect(requests[1]?.messages.find((message) => message.role === 'tool')?.content)
      .toMatchObject({ ok: false, code: 'TOOL_NOT_ALLOWED' })
  })

  it('分步 continue 保持首轮请求的编辑态白名单', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'host_xlsx_inspect', execution: 'server', input: z.object({}),
      output: z.object({ ok: z.boolean() }), execute: async () => ({ ok: true }),
    })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: { complete: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? callsOf({ callId: 'inspect-step', toolName: 'host_xlsx_inspect', input: {} })
          : { type: 'final', output: '完成' }
      } },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({
      sessionId: 's-continue-allowlist', input: '开始', context: {}, stepMode: true,
      allowedToolNames: ['host_xlsx_inspect'],
    })).resolves.toMatchObject({ type: 'step_done' })
    await harness.continue({ sessionId: 's-continue-allowlist', context: {}, allowedToolNames: ['host_xlsx_inspect'] })
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['host_xlsx_inspect'])
  })

  it('server tool 阻塞时 assistant tool call 已经保存，刷新读取可恢复 ask 上下文', async () => {
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    let release!: () => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    const releasePromise = new Promise<void>((resolve) => { release = resolve })
    tools.register({
      name: 'ask_user', execution: 'server', input: z.object({}), output: z.object({ ok: z.boolean() }),
      execute: async () => { started(); await releasePromise; return { ok: true } },
    })
    let modelCalls = 0
    const harness = createAgentHarness({
      llm: { complete: async () => modelCalls++ === 0
        ? callsOf({ callId: 'ask-1', toolName: 'ask_user', input: {} })
        : { type: 'final', output: '完成' } },
      sessions, tools, maxSteps: 3,
    })

    const running = harness.run({ sessionId: 's-ask', input: '开始', context: {} })
    await startedPromise
    expect(await sessions.load('s-ask')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: '开始' }),
      expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ callId: 'ask-1' })] }),
    ]))
    release()
    await running
  })

  it('服务端工具结果会进入下一次模型调用', async () => {
    const requests: unknown[] = []
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({ city: z.string() }),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'call-1', toolName: 'weather_read', input: { city: '上海' } })
            : { type: 'final', output: '上海 26 度' }
        },
      },
      sessions: createMemorySessionStore(),
      tools,
      maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-1', input: '查询天气', context: {} })).resolves.toEqual({ type: 'final', output: '上海 26 度' })
    expect(requests).toHaveLength(2)
  })

  it('服务端工具执行上下文携带 sessionId 与 callId', async () => {
    const contexts: Array<{ sessionId?: string; callId?: string }> = []
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async (_input, context) => {
        contexts.push(context)
        return { temperature: 26 }
      },
    })
    const requests: unknown[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'call-ctx', toolName: 'weather_read', input: {} })
            : { type: 'final', output: '完成' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })
    await harness.run({ sessionId: 's-ctx', input: '查询', context: {} })
    expect(contexts[0]).toMatchObject({ sessionId: 's-ctx', callId: 'call-ctx' })
  })

  it('LLM 补全请求携带 sessionId', async () => {
    const requests: Array<{ sessionId?: string }> = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return { type: 'final', output: '好的' }
        },
      },
      sessions: createMemorySessionStore(),
      tools: createToolRegistry(),
      maxSteps: 3,
    })
    await harness.run({ sessionId: 's-req', input: 'hi', context: {} })
    expect(requests[0]?.sessionId).toBe('s-req')
  })

  it('远端工具返回待执行调用且不在服务端执行', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-2', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-2', input: '读取页面', context: {} })).resolves.toEqual({
      type: 'pending_tool_calls',
      calls: [{ callId: 'call-2', toolName: 'browser_read_page', input: {} }],
    })
  })

  it('未注册工具不中断整轮，把可用工具列表回传让模型自纠', async () => {
    // 模型在上下文压力大时会输出畸形函数名（曾出现 `browser_click" ref="259`）。
    // 这种偶发抽风不该杀死整个任务，应让模型有机会用正确的名字重试。
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'call-3', toolName: 'weather_read" ref="259', input: {} })
            : { type: 'final', output: '已改用正确工具' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await expect(harness.run({ sessionId: 's-3', input: '执行未知工具', context: {} })).resolves.toEqual({
      type: 'final',
      output: '已改用正确工具',
    })
    // 模型必须收到失败反馈，且反馈里带上可选工具名。
    const toolMessage = requests[1]?.messages.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toMatchObject({ ok: false, code: 'TOOL_NOT_REGISTERED' })
    expect(JSON.stringify(toolMessage?.content)).toContain('weather_read')
  })

  it('工具输入不符合 Schema 时回填错误，让模型修正参数后重试', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({ city: z.string() }),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          if (requests.length === 1) return callsOf({ callId: 'call-bad', toolName: 'weather_read', input: { city: 123 } })
          if (requests.length === 2) return callsOf({ callId: 'call-good', toolName: 'weather_read', input: { city: '上海' } })
          return { type: 'final', output: '重试成功' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 4,
    })

    await expect(harness.run({ sessionId: 's-4', input: '查询天气', context: {} })).resolves.toEqual({ type: 'final', output: '重试成功' })
    const feedback = requests[1]?.messages.find((message) => message.role === 'tool')
    expect(feedback?.content).toMatchObject({ ok: false, code: 'TOOL_INPUT_INVALID', retryable: true, attempt: 1 })
    expect(JSON.stringify(feedback?.content)).toContain('修正参数后重试')
  })

  it('工具参数连续校验失败两次后停止自动重试', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read', execution: 'server',
      input: z.object({ city: z.string() }), output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    let calls = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          calls += 1
          return callsOf({ callId: `call-bad-${calls}`, toolName: 'weather_read', input: { city: 123 } })
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 5,
    })

    await expect(harness.run({ sessionId: 's-4-stop', input: '查询天气', context: {} })).resolves.toMatchObject({
      type: 'final',
      output: expect.stringContaining('连续 2 次'),
    })
    // 前两次是模型发起的工具调用轮次，第三次是收口补全（mock 仍返回工具调用，
    // 因此落到本文件新的收口兜底文案，文案里保留失败事实）。
    expect(calls).toBe(3)
  })

  it('同一工具连续执行失败两次后进入收口补全', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'unstable_write', execution: 'server', input: z.object({}), output: z.object({ ok: z.boolean() }),
      execute: async () => { throw new Error('fetch failed') },
    })
    let calls = 0
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          calls += 1
          return callsOf({ callId: `unstable-${calls}`, toolName: 'unstable_write', input: {} })
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 5,
    })

    await expect(harness.run({ sessionId: 's-exec-stop', input: '写入', context: {} })).resolves.toMatchObject({
      type: 'final', output: expect.stringContaining('连续 2 次'),
    })
    // 前两次是模型发起的工具调用轮次，第三次是收口补全（本次 mock 仍返回工具调用，
    // 因此落到 Runtime 兜底文案，文案里保留失败事实）。
    expect(calls).toBe(3)
    expect(requests[2]?.tools).toBeUndefined()
    const firstFailure = requests[1]?.messages.find((message) => message.role === 'tool')
    // 普通执行异常不是取消：这里必须是 TOOL_EXECUTION_FAILED，否则 Workflow 会误判成 cancelled。
    expect(firstFailure?.content).toMatchObject({ code: 'TOOL_EXECUTION_FAILED', retryable: true, attempt: 1 })
  })

  it('stepMode 的输入校验失败通过 notices 告知调用方', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read', execution: 'server',
      input: z.object({ city: z.string() }), output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'notice-1', toolName: 'weather_read', input: { city: 123 } }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })
    await expect(harness.run({ sessionId: 's-notice', input: '查询', context: {}, stepMode: true })).resolves.toEqual({
      type: 'step_done',
      notices: [{
        toolName: 'weather_read', code: 'TOOL_INPUT_INVALID', attempt: 1, retryable: true,
        message: expect.stringContaining('修正参数后重试'),
      }],
    })
  })

  it('工具输出不符合 Schema 时回填错误并允许模型重试', async () => {
    const tools = createToolRegistry()
    let executions = 0
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => {
        executions += 1
        return executions === 1 ? { temperature: 'hot' } : { temperature: 26 }
      },
    })
    const requests: LlmRequest[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          if (requests.length <= 2) return callsOf({ callId: `call-output-${requests.length}`, toolName: 'weather_read', input: {} })
          return { type: 'final', output: '输出修正成功' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 4,
    })

    await expect(harness.run({ sessionId: 's-5', input: '查询天气', context: {} })).resolves.toEqual({ type: 'final', output: '输出修正成功' })
    const feedback = requests[1]?.messages.find((message) => message.role === 'tool')
    expect(feedback?.content).toMatchObject({ code: 'TOOL_OUTPUT_INVALID', retryable: true, attempt: 1 })
  })

  it('达到最大步数返回 HARNESS_STEP_LIMIT', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'loop_tick',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-6', toolName: 'loop_tick', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await expect(harness.run({ sessionId: 's-6', input: '循环', context: {} })).rejects.toMatchObject({ code: 'HARNESS_STEP_LIMIT' })
  })

  it('请求级 maxSteps 为 0 时不受宿主步数上限限制', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'unbounded_tick',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    let modelCalls = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          modelCalls += 1
          return modelCalls <= 3
            ? callsOf({ callId: `unbounded-${modelCalls}`, toolName: 'unbounded_tick', input: {} })
            : { type: 'final', output: '完成' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await expect(harness.run({ sessionId: 'unbounded-session', input: '执行复杂任务', context: {}, maxSteps: 0 }))
      .resolves.toEqual({ type: 'final', output: '完成' })
    expect(modelCalls).toBe(4)
  })

  it('远端工具结果通过 resume 回填后进入下一次模型调用', async () => {
    const requests: unknown[] = []
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({ url: z.string() }), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return requests.length === 1
            ? callsOf({ callId: 'call-7', toolName: 'browser_read_page', input: { url: 'https://example.test' } })
            : { type: 'final', output: '页面标题：首页' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const pending = await harness.run({ sessionId: 's-7', input: '读取页面', context: {} })
    expect(pending).toMatchObject({ type: 'pending_tool_calls', calls: [{ toolName: 'browser_read_page' }] })
    await expect(harness.resume({ sessionId: 's-7', callId: 'call-7', output: { title: '首页' } })).resolves.toEqual({ type: 'final', output: '页面标题：首页' })
    expect(requests).toHaveLength(2)
  })

  it('跨 session 回填被拒绝', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-8', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-8', input: '读取页面', context: {} })
    await expect(harness.resume({ sessionId: 's-other', callId: 'call-8', output: { title: 'x' } })).rejects.toMatchObject({ code: 'PENDING_CALL_NOT_FOUND' })
  })

  it('resume 的工具输出不符合 Schema 时降级为工具错误，不硬崩会话', async () => {
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const historyFromLlm: SessionMessage[][] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          historyFromLlm.push(request.messages as SessionMessage[])
          return historyFromLlm.length === 1
            ? callsOf({ callId: 'call-9', toolName: 'browser_read_page', input: {} })
            : { type: 'final', output: '工具返回了错误' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-9', input: '读取页面', context: {} })
    // 回填不符合 schema 的 output（title 应为 string，这里给了 number）。
    // 不应抛错，而是把校验失败作为工具错误喂回模型，让模型自行恢复。
    await expect(harness.resume({ sessionId: 's-9', callId: 'call-9', output: { title: 123 } })).resolves.toEqual({
      type: 'final', output: '工具返回了错误',
    })
    // 第二次发给模型的历史里应包含 ok:false 的工具错误结果。
    const secondCallMessages = historyFromLlm[1]
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool' && (m as { callId?: string }).callId === 'call-9')
    expect(toolMsg).toBeDefined()
    expect((toolMsg as { content: { ok: boolean; code: string } }).content).toMatchObject({ ok: false, code: 'TOOL_OUTPUT_INVALID' })
  })

  it('把已注册工具的 JSON Schema 发给模型', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'browser_click',
      execution: 'remote',
      description: '在给定坐标执行真实点击',
      input: z.object({ x: z.number(), y: z.number(), label: z.string().optional() }),
      output: z.object({ ok: z.boolean() }),
    })
    let seen: unknown
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.tools
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 2,
    })

    await harness.run({ sessionId: 's-10', input: '点击', context: {} })
    expect(seen).toEqual([
      {
        name: 'browser_click',
        description: '在给定坐标执行真实点击',
        parameters: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' } },
          required: ['x', 'y'],
        },
      },
    ])
  })

  it('注册表为空时不发送 tools 字段', async () => {
    let seen: unknown = 'unset'
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.tools
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2,
    })

    await harness.run({ sessionId: 's-11', input: '你好', context: {} })
    expect(seen).toBeUndefined()
  })

  it('assistant 的 reasoning 在最终回复和工具调用轮次都会入库', async () => {
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read', execution: 'server', input: z.object({}),
      output: z.object({ temperature: z.number() }), execute: async () => ({ temperature: 26 }),
    })
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1
            ? { ...callsOf({ callId: 'reason-call', toolName: 'weather_read', input: {} }), content: '我先查询天气。', reasoning: '先查询天气' }
            : { type: 'final', output: '26 度', reasoning: '工具返回 26 度' }
        },
      },
      sessions, tools, maxSteps: 3,
    })
    await harness.run({ sessionId: 's-reasoning', input: '查天气', context: {} })
    const history = await sessions.load('s-reasoning')
    const assistant = history.filter((message) => message.role === 'assistant')
    expect(assistant[0]).toMatchObject({ content: '我先查询天气。', reasoning: '先查询天气' })
    expect(assistant[1]).toMatchObject({ reasoning: '工具返回 26 度' })
  })

  it('assistant 轮次与工具结果成对入库且顺序正确', async () => {
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1 ? callsOf({ callId: 'call-a', toolName: 'weather_read', input: {} }) : { type: 'final', output: '26 度' }
        },
      },
      sessions, tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-12', input: '查天气', context: {} })
    const history = (await sessions.load('s-12')) as SessionMessage[]
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(history[1]).toMatchObject({ role: 'assistant', toolCalls: [{ callId: 'call-a', toolName: 'weather_read' }] })
    expect(history[2]).toMatchObject({ role: 'tool', callId: 'call-a' })
  })

  it('把 final 和工具调用轮次的 reasoning 一并持久化', async () => {
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1
            ? { type: 'tool_calls', calls: [{ callId: 'call-reasoning', toolName: 'weather_read', input: {} }], content: '我先查询天气。', reasoning: '先查询天气' }
            : { type: 'final', output: '26 度', reasoning: '根据工具结果整理答案' }
        },
      },
      sessions, tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-reasoning', input: '查天气', context: {} })
    const history = await sessions.load('s-reasoning')
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: '我先查询天气。', reasoning: '先查询天气' }),
      expect.objectContaining({ role: 'assistant', reasoning: '根据工具结果整理答案', content: '26 度' }),
    ]))
  })

  it('模型看到自己的上一轮 assistant 输出', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read',
      execution: 'server',
      input: z.object({}),
      output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    const seenHistories: SessionMessage[][] = []
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seenHistories.push([...request.messages])
          step += 1
          return step === 1 ? callsOf({ callId: 'call-b', toolName: 'weather_read', input: {} }) : { type: 'final', output: '26 度' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-13', input: '查天气', context: {} })
    expect(seenHistories[1]?.some((message) => message.role === 'assistant')).toBe(true)
  })

  it('一轮内多个工具调用全部执行', async () => {
    const executed: string[] = []
    const tools = createToolRegistry()
    for (const name of ['a_run', 'b_run']) {
      tools.register({
        name,
        execution: 'server',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        execute: async () => {
          executed.push(name)
          return { ok: true }
        },
      })
    }
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1
            ? callsOf({ callId: 'c1', toolName: 'a_run', input: {} }, { callId: 'c2', toolName: 'b_run', input: {} })
            : { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-14', input: '并行', context: {} })
    expect(executed).toEqual(['a_run', 'b_run'])
  })

  it('一轮内部分工具失败时失败与成功结果一并回传', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'ok_run',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => ({ ok: true }),
    })
    tools.register({
      name: 'bad_run',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => {
        throw new Error('炸了')
      },
    })
    const seenHistories: SessionMessage[][] = []
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seenHistories.push([...request.messages])
          step += 1
          return step === 1
            ? callsOf({ callId: 'c1', toolName: 'ok_run', input: {} }, { callId: 'c2', toolName: 'bad_run', input: {} })
            : { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    await harness.run({ sessionId: 's-15', input: '混合', context: {} })
    const second = seenHistories[1] ?? []
    const toolMessages = second.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.some((message) => (message.content as { ok?: boolean }).ok === false)).toBe(true)
  })

  it('多个远端调用需全部回填后才推进模型', async () => {
    const tools = createToolRegistry()
    for (const name of ['r1_run', 'r2_run']) {
      tools.register({ name, execution: 'remote', input: z.object({}), output: z.object({ ok: z.boolean() }) })
    }
    let step = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          step += 1
          return step === 1
            ? callsOf({ callId: 'c1', toolName: 'r1_run', input: {} }, { callId: 'c2', toolName: 'r2_run', input: {} })
            : { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3,
    })

    const pending = await harness.run({ sessionId: 's-16', input: '双远端', context: {} })
    expect(pending).toMatchObject({ type: 'pending_tool_calls' })
    expect((pending as { calls: unknown[] }).calls).toHaveLength(2)

    // 只回填第一个：仍应挂起，且模型未被推进。
    const partial = await harness.resume({ sessionId: 's-16', callId: 'c1', output: { ok: true } })
    expect(partial).toMatchObject({ type: 'pending_tool_calls', calls: [{ callId: 'c2' }] })
    expect(step).toBe(1)

    await expect(harness.resume({ sessionId: 's-16', callId: 'c2', output: { ok: true } })).resolves.toEqual({ type: 'final', output: 'done' })
  })

  it('工具执行超时返回 TOOL_EXECUTION_TIMEOUT 且循环继续', async () => {
    vi.useFakeTimers()
    try {
      const tools = createToolRegistry()
      tools.register({
        name: 'slow_run',
        execution: 'server',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        timeoutMs: 50,
        execute: (_input, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      })
      const seenHistories: SessionMessage[][] = []
      let step = 0
      const harness = createAgentHarness({
        llm: {
          complete: async (request) => {
            seenHistories.push([...request.messages])
            step += 1
            return step === 1 ? callsOf({ callId: 'c1', toolName: 'slow_run', input: {} }) : { type: 'final', output: 'done' }
          },
        },
        sessions: createMemorySessionStore(), tools, maxSteps: 3,
      })

      const running = harness.run({ sessionId: 's-17', input: '慢工具', context: {} })
      await vi.advanceTimersByTimeAsync(100)
      await expect(running).resolves.toEqual({ type: 'final', output: 'done' })
      const toolMessage = (seenHistories[1] ?? []).find((message) => message.role === 'tool')
      expect(toolMessage?.content).toMatchObject({ ok: false, code: 'TOOL_EXECUTION_TIMEOUT' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('工具忽略 AbortSignal 时仍在超时后返回并继续循环', async () => {
    vi.useFakeTimers()
    try {
      const tools = createToolRegistry()
      tools.register({
        name: 'ignoring_timeout',
        execution: 'server',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        timeoutMs: 50,
        execute: async () => new Promise(() => {}),
      })
      let callCount = 0
      const harness = createAgentHarness({
        llm: {
          complete: async () => {
            callCount += 1
            return callCount === 1
              ? callsOf({ callId: 'c-timeout', toolName: 'ignoring_timeout', input: {} })
              : { type: 'final', output: '继续完成' }
          },
        },
        sessions: createMemorySessionStore(), tools, maxSteps: 3,
      })

      const running = harness.run({ sessionId: 's-hard-timeout', input: '执行', context: {} })
      await vi.advanceTimersByTimeAsync(50)
      await expect(running).resolves.toEqual({ type: 'final', output: '继续完成' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeoutMs 为 0 的工具可以持续等待用户确认', async () => {
    vi.useFakeTimers()
    try {
      const tools = createToolRegistry()
      tools.register({
        name: 'waiting_for_user',
        execution: 'server',
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        // 需要用户确认的工具不能因 harness 默认超时被取消；设备动作自身仍可有独立超时。
        timeoutMs: 0,
        execute: async () => new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true }), 100)
        }),
      })
      let callCount = 0
      const seenHistories: SessionMessage[][] = []
      const harness = createAgentHarness({
        llm: {
          complete: async (request) => {
            seenHistories.push([...request.messages])
            callCount += 1
            return callCount === 1
              ? callsOf({ callId: 'c-wait', toolName: 'waiting_for_user', input: {} })
              : { type: 'final', output: '已继续' }
          },
        },
        sessions: createMemorySessionStore(), tools, maxSteps: 3, toolTimeoutMs: 50,
      })

      const running = harness.run({ sessionId: 's-wait', input: '等待确认', context: {} })
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(100)
      await expect(running).resolves.toEqual({ type: 'final', output: '已继续' })
      const toolMessage = (seenHistories[1] ?? []).find((message) => message.role === 'tool')
      expect(toolMessage?.content).toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('可注入自定义挂起调用存储', async () => {
    const store = new Map<string, PendingCall>()
    const pendingCalls: PendingCallStore = {
      get: (callId) => store.get(callId),
      set: (callId, call) => void store.set(callId, call),
      delete: (callId) => void store.delete(callId),
    }
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => callsOf({ callId: 'call-x', toolName: 'browser_read_page', input: {} }) },
      sessions: createMemorySessionStore(), tools, maxSteps: 3, pendingCalls,
    })

    await harness.run({ sessionId: 's-18', input: '读取', context: {} })
    expect(store.get('call-x')).toEqual({ sessionId: 's-18', toolName: 'browser_read_page' })
  })

  it('注入的挂起存储使新 harness 实例也能回填', async () => {
    const store = new Map<string, PendingCall>()
    const pendingCalls: PendingCallStore = {
      get: (callId) => store.get(callId),
      set: (callId, call) => void store.set(callId, call),
      delete: (callId) => void store.delete(callId),
    }
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const deps = { sessions, tools, maxSteps: 3, pendingCalls }

    const first = createAgentHarness({ ...deps, llm: { complete: async () => callsOf({ callId: 'call-y', toolName: 'browser_read_page', input: {} }) } })
    await first.run({ sessionId: 's-19', input: '读取', context: {} })

    // 模拟进程重启：换一个 harness 实例，挂起调用仍能通过注入存储找回。
    const second = createAgentHarness({ ...deps, llm: { complete: async () => ({ type: 'final', output: '首页' }) } })
    await expect(second.resume({ sessionId: 's-19', callId: 'call-y', output: { title: '首页' } })).resolves.toEqual({ type: 'final', output: '首页' })
  })

  it('接入 ContextManager 后历史被裁剪', async () => {
    const sessions = createMemorySessionStore()
    await sessions.save('s-20', [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
      { role: 'user', content: '4' },
    ])
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
      context: createContextManager({ maxMessages: 2 }),
    })

    await harness.run({ sessionId: 's-20', input: '继续', context: {} })
    // 裁剪后的 2 条历史，加上前置的裁剪摘要 system 消息。
    expect(seen.filter((message) => message.role !== 'system')).toHaveLength(2)
  })

  it('裁剪摘要作为 system 消息发给模型', async () => {
    // 不注入摘要模型就不知道自己丢了上下文——它会以为看到的就是完整历史。
    const sessions = createMemorySessionStore()
    await sessions.save('s-23', [
      { role: 'user', content: '1' },
      { role: 'user', content: '2' },
      { role: 'user', content: '3' },
      { role: 'user', content: '4' },
    ])
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
      context: createContextManager({ maxMessages: 2 }),
    })

    await harness.run({ sessionId: 's-23', input: '继续', context: {} })
    expect(seen[0]).toMatchObject({ role: 'system' })
    expect(String((seen[0] as { content: unknown }).content)).toContain('已裁剪')
  })

  it('未发生裁剪时不注入摘要消息', async () => {
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(),
      tools: createToolRegistry(),
      maxSteps: 2,
      context: createContextManager({ maxMessages: 10 }),
    })

    await harness.run({ sessionId: 's-24', input: '你好', context: {} })
    expect(seen.some((message) => message.role === 'system')).toBe(false)
  })

  it('声明输出协议时要求 JSON 并校验模型输出', async () => {
    const prompts = createPromptRegistry()
    prompts.register({
      name: 'assess',
      version: '1',
      prompt: '评估候选人',
      protocol: z.object({ shouldFavorite: z.boolean(), reason: z.string() }),
    })
    let sawJsonFlag = false
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          sawJsonFlag = request.responseFormatJson === true
          return { type: 'final', output: JSON.stringify({ shouldFavorite: true, reason: '匹配' }) }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 's-21', input: '评估', context: {} })).resolves.toEqual({
      type: 'final',
      output: { shouldFavorite: true, reason: '匹配' },
    })
    expect(sawJsonFlag).toBe(true)
  })

  it('模型输出不符合已声明协议时返回 LLM_OUTPUT_PROTOCOL_INVALID', async () => {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'assess', version: '1', prompt: '评估', protocol: z.object({ shouldFavorite: z.boolean() }) })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: JSON.stringify({ shouldFavorite: '是' }) }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 's-22', input: '评估', context: {} })).rejects.toMatchObject({ code: 'LLM_OUTPUT_PROTOCOL_INVALID' })
  })

  it('输出协议失败时包含字段级诊断，便于定位 Agent Task 的真实原因', async () => {
    const prompts = createPromptRegistry()
    prompts.register({
      name: 'assess-diagnostics', version: '1', prompt: '评估',
      protocol: z.object({ shouldFavorite: z.boolean(), reason: z.string() }).strict(),
    })
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: JSON.stringify({ shouldFavorite: '是' }) }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts,
    })

    await expect(harness.run({ sessionId: 's-22-diagnostics', input: '评估', context: {}, promptName: 'assess-diagnostics' }))
      .rejects.toThrow(/shouldFavorite.*boolean|reason.*必填/)
  })

  it('run 时清除残破的未完成工具轮次', async () => {
    // 一轮含远端调用时若被中止，harness 已持久化带 toolCalls 的 assistant 但没有对应结果。
    // 之后同会话再发新指令，残破历史会原样发给模型，而 OpenAI 兼容端点要求
    // 每个 tool_call_id 都有结果 —— 直接 400。run 必须裁掉这类残破轮次。
    const sessions = createMemorySessionStore()
    await sessions.save('s-25', [
      { role: 'user', content: '之前的一轮' },
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c-orphan', toolName: 'browser_snapshot', input: {} }] },
      // 注意：没有对应的 tool 结果消息 —— 这就是被中止的残破轮次。
    ])
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
    })

    await harness.run({ sessionId: 's-25', input: '新指令', context: {} })
    // 残破的 assistant 被裁掉，发给模型的消息里没有无结果的 tool_calls。
    const assistantWithCalls = seen.filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    expect(assistantWithCalls).toHaveLength(0)
  })

  it('run 时清除残破轮次后把清理结果写回存储', async () => {
    const sessions = createMemorySessionStore()
    await sessions.save('s-26', [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c-orphan', toolName: 'browser_click', input: {} }] },
    ])
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: 'done' }) },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
    })

    await harness.run({ sessionId: 's-26', input: '新指令', context: {} })
    const history = await sessions.load('s-26')
    expect(history.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(false)
  })

  it('run 时保留完整往返，不清掉已回填的调用', async () => {
    const sessions = createMemorySessionStore()
    await sessions.save('s-27', [
      { role: 'assistant', content: null, toolCalls: [{ callId: 'c-ok', toolName: 'browser_click', input: {} }] },
      { role: 'tool', content: { ok: true }, callId: 'c-ok' },
    ])
    let seen: SessionMessage[] = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = [...request.messages]
          return { type: 'final', output: 'done' }
        },
      },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
    })

    await harness.run({ sessionId: 's-27', input: '新指令', context: {} })
    const assistantWithCalls = seen.filter((m) => m.role === 'assistant' && m.toolCalls?.length)
    expect(assistantWithCalls).toHaveLength(1)
    expect((assistantWithCalls[0] as { toolCalls?: Array<{ callId: string }> }).toolCalls?.[0]?.callId).toBe('c-ok')
  })

  it('run 时无残破轮次则不清洗', async () => {
    const sessions = createMemorySessionStore()
    await sessions.save('s-28', [{ role: 'user', content: '干净的历史' }])
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: 'done' }) },
      sessions,
      tools: createToolRegistry(),
      maxSteps: 2,
    })

    await harness.run({ sessionId: 's-28', input: '新指令', context: {} })
    const history = await sessions.load('s-28')
    expect(history.some((m) => m.role === 'user' && m.content === '干净的历史')).toBe(true)
  })
})

describe('按名选择提示词', () => {
  /** 注册两个提示词：第一个无协议（会成为默认），第二个带协议。 */
  function twoPrompts() {
    const prompts = createPromptRegistry()
    prompts.register({ name: 'browser-automation', version: '1', prompt: '你在操作浏览器' })
    prompts.register({
      name: 'candidate-assessment',
      version: '1',
      prompt: '评估候选人',
      protocol: z.object({ decisions: z.array(z.object({ index: z.number() })) }),
    })
    return prompts
  }

  it('省略 promptName 时使用默认（首个注册）提示词', async () => {
    let seen: string | undefined
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.systemPrompt
          return { type: 'final', output: 'done' }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await harness.run({ sessionId: 's-p1', input: 'hi', context: {} })
    expect(seen).toBe('你在操作浏览器')
  })

  it('指定 promptName 时使用该提示词', async () => {
    // 之前 harness 死取 getDefault()，第二个注册的提示词永远选不中。
    let seen: string | undefined
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seen = request.systemPrompt
          return { type: 'final', output: JSON.stringify({ decisions: [] }) }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await harness.run({ sessionId: 's-p2', input: 'hi', context: {}, promptName: 'candidate-assessment' })
    expect(seen).toBe('评估候选人')
  })

  it('非默认提示词的输出协议能够生效', async () => {
    // 这是原缺陷的核心后果：candidate-assessment 的 protocol 此前完全不可达。
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: JSON.stringify({ decisions: 'not-an-array' }) }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await expect(
      harness.run({ sessionId: 's-p3', input: 'hi', context: {}, promptName: 'candidate-assessment' }),
    ).rejects.toMatchObject({ code: 'LLM_OUTPUT_PROTOCOL_INVALID' })
  })

  it('默认提示词无协议时不强制 JSON', async () => {
    let sawJsonFlag: boolean | undefined = true
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          sawJsonFlag = request.responseFormatJson
          return { type: 'final', output: '纯文本' }
        },
      },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await harness.run({ sessionId: 's-p4', input: 'hi', context: {} })
    expect(sawJsonFlag).toBeUndefined()
  })

  it('提示词未注册时返回 PROMPT_NOT_FOUND', async () => {
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: 'done' }) },
      sessions: createMemorySessionStore(), tools: createToolRegistry(), maxSteps: 2, prompts: twoPrompts(),
    })
    await expect(
      harness.run({ sessionId: 's-p5', input: 'hi', context: {}, promptName: 'nonexistent' }),
    ).rejects.toMatchObject({ code: 'PROMPT_NOT_FOUND' })
  })

  it('resume 沿用发起调用时的提示词', async () => {
    // 否则一次工具循环的前后两半会用不同提示词（甚至不同输出协议）。
    const prompts = twoPrompts()
    const tools = createToolRegistry()
    tools.register({ name: 'browser_read_page', execution: 'remote', input: z.object({}), output: z.object({ title: z.string() }) })
    const seenPrompts: Array<string | undefined> = []
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          seenPrompts.push(request.systemPrompt)
          return seenPrompts.length === 1
            ? { type: 'tool_calls', calls: [{ callId: 'c1', toolName: 'browser_read_page', input: {} }] }
            : { type: 'final', output: JSON.stringify({ decisions: [] }) }
        },
      },
      sessions: createMemorySessionStore(), tools, maxSteps: 3, prompts,
    })

    await harness.run({ sessionId: 's-p6', input: 'hi', context: {}, promptName: 'candidate-assessment' })
    await harness.resume({ sessionId: 's-p6', callId: 'c1', output: { title: '首页' } })
    expect(seenPrompts).toEqual(['评估候选人', '评估候选人'])
  })

  describe('stepMode', () => {
    it('server 工具执行完一步后返回 step_done 并落库', async () => {
      let callCount = 0
      const tools = createToolRegistry()
      tools.register({
        name: 'ping',
        execution: 'server',
        input: z.object({}),
        output: z.object({ pong: z.boolean() }),
        execute: async () => {
          callCount += 1
          return { pong: true }
        },
      })
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: {
          complete: async () =>
            callsOf({ callId: 'c-ping', toolName: 'ping', input: {} }),
        },
        sessions,
        tools,
        maxSteps: 5,
      })

      const result = await harness.run({
        sessionId: 's-step',
        input: 'ping 一下',
        context: {},
        stepMode: true,
      })

      expect(result).toEqual({ type: 'step_done' })
      expect(callCount).toBe(1)
      const stored = await sessions.load('s-step')
      expect(stored.some((m) => m.role === 'tool')).toBe(true)
      expect(stored.some((m) => m.role === 'assistant' && (m as { toolCalls?: unknown }).toolCalls)).toBe(true)
    })

    it('不传 stepMode 时行为不变，循环跑到 final', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'ping',
        execution: 'server',
        input: z.object({}),
        output: z.object({ pong: z.boolean() }),
        execute: async () => ({ pong: true }),
      })
      let responses = 0
      const harness = createAgentHarness({
        llm: {
          complete: async () => {
            responses += 1
            return responses === 1
              ? callsOf({ callId: 'c-ping', toolName: 'ping', input: {} })
              : { type: 'final', output: 'pong' }
          },
        },
        sessions: createMemorySessionStore(),
        tools,
        maxSteps: 5,
      })

      const result = await harness.run({ sessionId: 's-normal', input: 'x', context: {} })

      expect(result).toEqual({ type: 'final', output: 'pong' })
      expect(responses).toBe(2)
    })

    it('stepMode 不影响 remote 工具（仍返回 pending_tool_calls）', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'remote_thing',
        execution: 'remote',
        input: z.object({}),
        output: z.object({}),
      })
      const harness = createAgentHarness({
        llm: {
          complete: async () =>
            callsOf({ callId: 'c-r', toolName: 'remote_thing', input: {} }),
        },
        sessions: createMemorySessionStore(),
        tools,
        maxSteps: 5,
      })

      const result = await harness.run({
        sessionId: 's-remote',
        input: 'x',
        context: {},
        stepMode: true,
      })

      expect(result.type).toBe('pending_tool_calls')
    })

    it('continue 推进到下一步，可多次调用直到 final', async () => {
      const tools = createToolRegistry()
      let n = 0
      tools.register({
        name: 'inc',
        execution: 'server',
        input: z.object({}),
        output: z.object({ n: z.number() }),
        execute: async () => ({ n: ++n }),
      })
      let modelCalls = 0
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: {
          complete: async () => {
            modelCalls += 1
            return modelCalls < 3
              ? callsOf({ callId: 'c-' + modelCalls, toolName: 'inc', input: {} })
              : { type: 'final', output: 'done' }
          },
        },
        sessions,
        tools,
        maxSteps: 10,
      })

      const first = await harness.run({ sessionId: 's-cont', input: '开始', context: {}, stepMode: true })
      expect(first).toEqual({ type: 'step_done' })

      const second = await harness.continue({ sessionId: 's-cont' })
      expect(second).toEqual({ type: 'step_done' })

      const third = await harness.continue({ sessionId: 's-cont' })
      expect(third).toEqual({ type: 'final', output: 'done' })

      expect(n).toBe(2)
    })

    it('上下文 projection 返回空数组时 continue 仍把已保存的任务历史发给模型', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'observe',
        execution: 'server',
        input: z.object({}),
        output: z.object({ title: z.string() }),
        execute: async () => ({ title: '首页' }),
      })
      const sessions = createMemorySessionStore()
      const requests: LlmRequest[] = []
      let modelCalls = 0
      const harness = createAgentHarness({
        llm: { complete: async (request) => {
          requests.push(request)
          modelCalls += 1
          return modelCalls === 1
            ? callsOf({ callId: 'observe-1', toolName: 'observe', input: {} })
            : { type: 'final', output: '已完成首页检查' }
        } },
        sessions,
        tools,
        maxSteps: 3,
        // 空 projection 模拟状态丢失；非空 Session 历史仍是 Core 可恢复的事实来源。
        context: {
          load: () => [],
          save: () => {},
          append: () => {},
          getSummary: () => undefined,
        },
      })

      await harness.run({ sessionId: 's-empty-projection', input: '打开首页并核对标题', context: {}, stepMode: true })
      await harness.continue({ sessionId: 's-empty-projection', context: {} })

      expect(requests[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '打开首页并核对标题' }),
        expect.objectContaining({ role: 'tool', callId: 'observe-1', content: { title: '首页' } }),
      ]))
    })

    it('continue 带 input 时作为中途注入消息发给模型并并入历史', async () => {
      const tools = createToolRegistry()
      tools.register({
        name: 'noop',
        execution: 'server',
        input: z.object({}),
        output: z.object({}),
        execute: async () => ({}),
      })
      const seenInputs: unknown[] = []
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: {
          complete: async (req) => {
            // 注入消息通过 input 参数传递（首轮用户输入同理）
            seenInputs.push(req.input)
            return { type: 'final', output: 'ok' }
          },
        },
        sessions,
        tools,
        maxSteps: 5,
      })

      await harness.run({ sessionId: 's-inj', input: '初始任务', context: {}, stepMode: true })
      await harness.continue({ sessionId: 's-inj', input: '换个方向' })

      expect(seenInputs).toContain('初始任务')
      expect(seenInputs).toContain('换个方向')
    })

    it('continue 在没有 stepMode 历史的会话上也能工作（防御性）', async () => {
      const sessions = createMemorySessionStore()
      const harness = createAgentHarness({
        llm: { complete: async () => ({ type: 'final', output: '直接完成' }) },
        sessions,
        tools: createToolRegistry(),
        maxSteps: 3,
      })

      const result = await harness.continue({ sessionId: 's-empty' })
      expect(result).toEqual({ type: 'final', output: '直接完成' })
    })
  })
})

describe('工具失败的错误码归类', () => {
  it('工具抛出的普通异常归类为 TOOL_EXECUTION_FAILED，而不是已取消', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'flaky_tool',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => { throw new Error('HTTP 500') },
    })
    const sessions = createMemorySessionStore()
    let modelCalls = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          modelCalls += 1
          // 第一次返回工具调用触发失败；第二次（模型已看到失败）直接收口。
          if (request.messages.some((message) => message.role === 'tool')) {
            return { type: 'final', output: '已向用户说明失败' }
          }
          return callsOf({ callId: `flaky-${modelCalls}`, toolName: 'flaky_tool', input: {} })
        },
      },
      sessions,
      tools,
      maxSteps: 3,
    })

    await harness.run({ sessionId: 'flaky-session', input: '执行', context: {} })

    const toolMessage = (await sessions.load('flaky-session')).find((message) => message.role === 'tool')
    expect(toolMessage?.content).toMatchObject({ ok: false, code: 'TOOL_EXECUTION_FAILED' })
  })
})

describe('工具失败收口补全', () => {
  /** 注册一个永远抛普通异常的工具，用于触发连续失败收口。 */
  function registerDeadTool(tools: ReturnType<typeof createToolRegistry>): void {
    tools.register({
      name: 'dead_tool',
      execution: 'server',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      execute: async () => { throw new Error('HTTP 500') },
    })
  }

  it('连续两次失败后由模型写收口说明，且收口补全禁用工具', async () => {
    const tools = createToolRegistry()
    registerDeadTool(tools)
    const requests: LlmRequest[] = []
    let call = 0
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          call += 1
          if (call <= 2) return callsOf({ callId: `dead-${call}`, toolName: 'dead_tool', input: {} })
          return { type: 'final', output: '两次尝试都失败了，当前无法继续；你可以稍后让我重试。' }
        },
      },
      sessions: createMemorySessionStore(),
      tools,
      maxSteps: 5,
    })

    const result = await harness.run({ sessionId: 'dead-session', input: '执行', context: {} })

    expect(result).toMatchObject({ type: 'final', output: expect.stringContaining('当前无法继续') })
    expect(requests.at(-1)?.tools).toBeUndefined()
    expect(requests.at(-1)?.systemPrompt).toContain('不要调用任何工具')
  })

  it('收口补全自身失败时返回中性兜底文案且不抛出', async () => {
    const tools = createToolRegistry()
    registerDeadTool(tools)
    let call = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          call += 1
          if (call <= 2) return callsOf({ callId: `dead-${call}`, toolName: 'dead_tool', input: {} })
          throw new Error('LLM 不可用')
        },
      },
      sessions: createMemorySessionStore(),
      tools,
      maxSteps: 5,
    })

    const result = await harness.run({ sessionId: 'dead-fallback', input: '执行', context: {} })

    expect(result).toMatchObject({ type: 'final', output: expect.stringContaining('本次执行未完成') })
  })

  it('声明协议的 prompt 收口失败时返回请求方提供的 failureFallback', async () => {
    const tools = createToolRegistry()
    registerDeadTool(tools)
    const prompts = createPromptRegistry()
    prompts.register({
      name: 'protocol-task',
      version: '1',
      prompt: '你是任务执行器',
      protocol: z.object({ status: z.enum(['passed', 'failed', 'blocked']), summary: z.string() }),
    })
    let call = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          call += 1
          if (call <= 2) return callsOf({ callId: `dead-${call}`, toolName: 'dead_tool', input: {} })
          // 收口补全返回的不是协议 JSON：必须回落到 failureFallback，而不是抛协议错误。
          return { type: 'final', output: '不是 JSON' }
        },
      },
      sessions: createMemorySessionStore(),
      tools,
      prompts,
      maxSteps: 5,
    })

    await expect(harness.run({
      sessionId: 'protocol-session',
      input: '执行',
      context: {},
      promptName: 'protocol-task',
      failureFallback: { status: 'failed', summary: '工具连续失败，任务终止' },
    })).resolves.toMatchObject({
      type: 'final',
      output: { status: 'failed', summary: expect.stringContaining('工具连续失败') },
    })
  })
})

describe('工具不可用时的降级', () => {
  it('未注册工具的反馈允许用文本向用户提问', async () => {
    const tools = createToolRegistry()
    const sessions = createMemorySessionStore()
    let call = 0
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          call += 1
          return call === 1
            ? callsOf({ callId: 'ghost-1', toolName: 'not_registered', input: {} })
            : { type: 'final', output: '我直接问你：要继续吗？' }
        },
      },
      sessions,
      tools,
      maxSteps: 3,
    })

    await harness.run({ sessionId: 'ghost-session', input: '执行', context: {} })

    const toolMessage = (await sessions.load('ghost-session')).find((message) => message.role === 'tool')
    // 反馈里必须给出「用文本继续」这条出路，否则模型容易在缺工具时停在原地。
    expect(String((toolMessage?.content as { message?: string })?.message)).toContain('用文本')
  })
})

/** 构造模型泄漏的工具调用标记；分片拼接，避免测试文件本身出现完整协议标记。 */
function leakedToolCallMarkup(toolName: string): string {
  const open = ['<', 'invoke name="', toolName, '">'].join('')
  const parameter = ['<', 'parameter name="timeoutMs">3000'].join('')
  const close = ['<', '/invoke>'].join('')
  return [open, parameter, close].join('\n')
}

/** DSML 外壳：用 unicode 转义拼装全角竖线，避免与真实泄漏文本混淆。 */
function dsmlWrapped(body: string): string {
  const bars = '\uFF5C\uFF5C'
  return [`${bars}DSML${bars} calls`, body, `${bars}/${bars} calls`].join('\n')
}

describe('AgentHarness 工具调用标记泄漏', () => {
  it('识别工具调用标记，不误伤普通正文', () => {
    expect(looksLikeToolCallMarkup(leakedToolCallMarkup('mobile_wait_for'))).toBe(true)
    expect(looksLikeToolCallMarkup(dsmlWrapped(leakedToolCallMarkup('mobile_snapshot')))).toBe(true)
    // 正文里讨论 invoke 但没有结束标签时不算泄漏。
    expect(looksLikeToolCallMarkup('调用 invoke 时应该走工具协议，而不是手写标记')).toBe(false)
    expect(looksLikeToolCallMarkup({ ok: true })).toBe(false)
  })

  it('纯 Chat 收到标记文本时落库可行动说明，而不是原始标记', async () => {
    const sessions = createMemorySessionStore()
    const tools = createToolRegistry()
    const harness = createAgentHarness({
      llm: { complete: async () => ({ type: 'final', output: leakedToolCallMarkup('mobile_wait_for') }) },
      sessions, tools, maxSteps: 2,
    })

    const result = await harness.run({ sessionId: 's-markup', input: '继续', context: {} })

    expect(result).toMatchObject({ type: 'final', output: expect.stringContaining('无法解析的工具调用格式') })
    const stored = JSON.stringify(await sessions.load('s-markup'))
    expect(stored).toContain('无法解析的工具调用格式')
    // 最后一条可见答复必须是说明，而不是原始标记（泄漏原文仅作为模型自查保留在历史中）。
    const history = await sessions.load('s-markup')
    expect(String(history.at(-1)?.content)).toContain('无法解析的工具调用格式')
  })

  it('收口补全返回标记时改用失败兜底文案', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read', execution: 'server',
      input: z.object({ city: z.string() }), output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    let calls = 0
    const sessions = createMemorySessionStore()
    const harness = createAgentHarness({
      llm: {
        complete: async () => {
          calls += 1
          // 前两次模型发起非法参数调用，第三次（收口补全）返回标记文本。
          return calls <= 2
            ? callsOf({ callId: `call-${calls}`, toolName: 'weather_read', input: { city: 123 } })
            : { type: 'final', output: leakedToolCallMarkup('weather_read') }
        },
      },
      sessions, tools, maxSteps: 5,
    })

    const result = await harness.run({ sessionId: 's-markup-wrapup', input: '查询天气', context: {} })

    expect(result).toMatchObject({ type: 'final', output: expect.stringContaining('连续 2 次') })
    expect(JSON.stringify(await sessions.load('s-markup-wrapup'))).not.toContain('invoke name=')
  })

  it('标记泄漏后给一次纠正重试：模型改用工具协议重发则任务继续', async () => {
    const tools = createToolRegistry()
    tools.register({
      name: 'weather_read', execution: 'server',
      input: z.object({ city: z.string() }), output: z.object({ temperature: z.number() }),
      execute: async () => ({ temperature: 26 }),
    })
    let calls = 0
    const requests: LlmRequest[] = []
    const sessions = createMemorySessionStore()
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          calls += 1
          requests.push(request)
          if (calls === 1) return { type: 'final', output: leakedToolCallMarkup('weather_read') }
          if (calls === 2) return callsOf({ callId: 'call-retry', toolName: 'weather_read', input: { city: '上海' } })
          return { type: 'final', output: '上海 26 度' }
        },
      },
      sessions, tools, maxSteps: 4,
    })

    await expect(harness.run({ sessionId: 's-markup-retry', input: '查询天气', context: {} }))
      .resolves.toEqual({ type: 'final', output: '上海 26 度' })

    // 第二次请求必须带上纠正指令，模型才知道要用工具协议重发。
    expect(requests[1]?.systemPrompt).toContain('工具调用写成了正文里的标记')
    expect(calls).toBe(3)
    const stored = await sessions.load('s-markup-retry')
    expect(stored.at(-1)?.content).toBe('上海 26 度')
  })

  it('纠正重试仍泄漏时只补一次，直接用兜底文案收口', async () => {
    const tools = createToolRegistry()
    const requests: LlmRequest[] = []
    const sessions = createMemorySessionStore()
    const harness = createAgentHarness({
      llm: {
        complete: async (request) => {
          requests.push(request)
          return { type: 'final', output: leakedToolCallMarkup('mobile_wait_for') }
        },
      },
      sessions, tools, maxSteps: 4,
    })

    const result = await harness.run({ sessionId: 's-markup-twice', input: '继续', context: {} })

    expect(result).toMatchObject({ type: 'final', output: expect.stringContaining('无法解析的工具调用格式') })
    // 首次 + 一次纠正 = 2 次调用，不再继续消耗。
    expect(requests).toHaveLength(2)
    const history = await sessions.load('s-markup-twice')
    expect(String(history.at(-1)?.content)).toContain('无法解析的工具调用格式')
  })
})
