import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { toToolSchema, toToolSchemas } from './json-schema.js'
import type { ToolDefinition } from './contracts.js'

/** 构造一个只关心 input Schema 的工具定义。 */
function toolWith(input: z.ZodType, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return { name: 'test_tool', execution: 'remote', input, output: z.object({}), ...extra } as ToolDefinition
}

describe('toToolSchema', () => {
  it('转换基础标量类型', () => {
    const schema = toToolSchema(toolWith(z.object({ s: z.string(), n: z.number(), b: z.boolean() })))
    expect(schema.parameters).toEqual({
      type: 'object',
      properties: { s: { type: 'string' }, n: { type: 'number' }, b: { type: 'boolean' } },
      required: ['s', 'n', 'b'],
    })
  })

  it('整数约束映射为 integer', () => {
    const schema = toToolSchema(toolWith(z.object({ count: z.number().int() })))
    expect(schema.parameters).toMatchObject({ properties: { count: { type: 'integer' } } })
  })

  it('可选字段不进 required', () => {
    const schema = toToolSchema(toolWith(z.object({ a: z.string(), b: z.string().optional() })))
    expect(schema.parameters).toMatchObject({ required: ['a'] })
    expect((schema.parameters as { properties: Record<string, unknown> }).properties.b).toEqual({ type: 'string' })
  })

  it('带默认值的字段不进 required', () => {
    const schema = toToolSchema(toolWith(z.object({ a: z.string(), mode: z.string().default('fast') })))
    expect(schema.parameters).toMatchObject({ required: ['a'] })
  })

  it('全部字段可选时省略 required', () => {
    const schema = toToolSchema(toolWith(z.object({ a: z.string().optional() })))
    expect(schema.parameters).not.toHaveProperty('required')
  })

  it('转换嵌套对象并保持层级与可选性', () => {
    const schema = toToolSchema(
      toolWith(
        z.object({
          outer: z.object({ inner: z.string(), maybe: z.number().optional() }),
        }),
      ),
    )
    expect(schema.parameters).toEqual({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' }, maybe: { type: 'number' } },
          required: ['inner'],
        },
      },
      required: ['outer'],
    })
  })

  it('转换枚举', () => {
    const schema = toToolSchema(toolWith(z.object({ mode: z.enum(['fast', 'slow']) })))
    expect(schema.parameters).toMatchObject({ properties: { mode: { type: 'string', enum: ['fast', 'slow'] } } })
  })

  it('转换数组与嵌套对象数组', () => {
    const schema = toToolSchema(toolWith(z.object({ tags: z.array(z.string()), items: z.array(z.object({ id: z.number() })) })))
    expect(schema.parameters).toMatchObject({
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
      },
    })
  })

  it('转换字面量与联合类型', () => {
    const schema = toToolSchema(toolWith(z.object({ kind: z.literal('click'), value: z.union([z.string(), z.number()]) })))
    expect(schema.parameters).toMatchObject({
      properties: {
        kind: { type: 'string', enum: ['click'] },
        value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    })
  })

  it('转换 null 类型，并保留 nullable 联合语义', () => {
    const schema = toToolSchema(toolWith(z.object({ value: z.union([z.string(), z.null()]), maybe: z.string().nullable() })))
    expect(schema.parameters).toMatchObject({
      properties: {
        value: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    })
  })

  it('转换 record 为 additionalProperties', () => {
    const schema = toToolSchema(toolWith(z.object({ meta: z.record(z.string()) })))
    expect(schema.parameters).toMatchObject({
      properties: { meta: { type: 'object', additionalProperties: { type: 'string' } } },
    })
  })

  it('保留 describe 说明', () => {
    const schema = toToolSchema(toolWith(z.object({ x: z.number().describe('横坐标，CSS 像素') })))
    expect(schema.parameters).toMatchObject({ properties: { x: { type: 'number', description: '横坐标，CSS 像素' } } })
  })

  it('带上工具自身的 description', () => {
    const schema = toToolSchema(toolWith(z.object({}), { description: '执行真实点击' }))
    expect(schema.description).toBe('执行真实点击')
  })

  it('顶层非对象时抛 TOOL_SCHEMA_UNSUPPORTED', () => {
    expect(() => toToolSchema(toolWith(z.string()))).toThrowError(
      expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED' }),
    )
  })

  it('不支持的类型抛错并指出工具名与字段路径', () => {
    const input = z.object({ when: z.date() })
    expect(() => toToolSchema(toolWith(input, { name: 'browser_click' }))).toThrowError(/browser_click.*when/)
  })

  it('工具名含点号时抛错', () => {
    // OpenAI 兼容端点的函数名只接受 ^[a-zA-Z0-9_-]+$。点号会让端点返回
    // Invalid 'tools[0].function.name' 的 400，症状是「所有请求都失败」，
    // 很难定位到命名问题，所以在转换阶段就拦住。
    expect(() => toToolSchema(toolWith(z.object({}), { name: 'browser.click' }))).toThrowError(
      expect.objectContaining({ code: 'TOOL_SCHEMA_UNSUPPORTED' }),
    )
  })

  it('工具名错误信息给出合法字符集', () => {
    expect(() => toToolSchema(toolWith(z.object({}), { name: 'browser.click' }))).toThrowError(/a-zA-Z0-9_-/)
  })

  it('接受下划线与连字符的工具名', () => {
    expect(() => toToolSchema(toolWith(z.object({}), { name: 'browser_snapshot' }))).not.toThrow()
    expect(() => toToolSchema(toolWith(z.object({}), { name: 'browser-snapshot' }))).not.toThrow()
  })

  it('拒绝含空格或斜杠的工具名', () => {
    for (const name of ['browser click', 'browser/click', 'browser:click']) {
      expect(() => toToolSchema(toolWith(z.object({}), { name })), name).toThrowError(/TOOL_SCHEMA_UNSUPPORTED|不合法/)
    }
  })

  it('嵌套字段的错误路径带完整层级', () => {
    const input = z.object({ outer: z.object({ when: z.date() }) })
    expect(() => toToolSchema(toolWith(input))).toThrowError(/outer\.when/)
  })

  it('批量转换保持顺序', () => {
    const schemas = toToolSchemas([
      toolWith(z.object({}), { name: 'a' }),
      toolWith(z.object({}), { name: 'b' }),
    ])
    expect(schemas.map((schema) => schema.name)).toEqual(['a', 'b'])
  })
})
