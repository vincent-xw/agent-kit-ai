import type { z } from 'zod'

import { AgentKitError } from './errors.js'
import type { ToolDefinition, ToolSchema } from './contracts.js'

/** JSON Schema 片段。用宽松的记录类型，因为要发给模型而不是在本地做强校验。 */
type JsonSchema = Record<string, unknown>

/** 读取 zod 内部定义。zod 3 没有公开的 introspection API，只能走 _def。 */
function defOf(schema: z.ZodTypeAny): { typeName: string; description?: string; [key: string]: unknown } {
  return (schema as unknown as { _def: { typeName: string; description?: string } })._def
}

/**
 * 把单个 zod 类型转换为 JSON Schema。
 * path 只用于报错定位——转换失败必须能指出是哪个字段，否则排查成本极高。
 */
function convert(schema: z.ZodTypeAny, toolName: string, path: string): JsonSchema {
  const def = defOf(schema)
  const described = def.description ? { description: def.description } : {}

  switch (def.typeName) {
    case 'ZodString':
      return { type: 'string', ...described }
    case 'ZodNumber': {
      const checks = (def.checks ?? []) as Array<{ kind: string }>
      const isInt = checks.some((check) => check.kind === 'int')
      return { type: isInt ? 'integer' : 'number', ...described }
    }
    case 'ZodBoolean':
      return { type: 'boolean', ...described }
    case 'ZodNull':
      return { type: 'null', ...described }
    case 'ZodEnum':
      return { type: 'string', enum: [...(def.values as string[])], ...described }
    case 'ZodLiteral': {
      const value = def.value
      const literalType = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string'
      return { type: literalType, enum: [value], ...described }
    }
    case 'ZodArray':
      return { type: 'array', items: convert(def.type as z.ZodTypeAny, toolName, `${path}[]`), ...described }
    case 'ZodObject':
      return { ...convertObject(schema as z.ZodObject<z.ZodRawShape>, toolName, path), ...described }
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: convert(def.valueType as z.ZodTypeAny, toolName, `${path}.*`),
        ...described,
      }
    case 'ZodUnion': {
      const options = def.options as z.ZodTypeAny[]
      return { anyOf: options.map((option, index) => convert(option, toolName, `${path}|${index}`)), ...described }
    }
    // 可选和默认值由父对象的 required 表达，直接透传内层 Schema。
    case 'ZodOptional':
    case 'ZodDefault':
      return { ...convert((def.innerType ?? def.type) as z.ZodTypeAny, toolName, path), ...described }
    // nullable 不等于 optional：字段仍然必填，但值可以明确为 null。
    case 'ZodNullable':
      return {
        anyOf: [
          convert(def.innerType as z.ZodTypeAny, toolName, path),
          { type: 'null' },
        ],
        ...described,
      }
    case 'ZodAny':
    case 'ZodUnknown':
      return { ...described }
    default:
      throw new AgentKitError(
        'TOOL_SCHEMA_UNSUPPORTED',
        `工具 ${toolName} 的字段 ${path} 使用了无法转换为 JSON Schema 的类型：${def.typeName}`,
      )
  }
}

/** 判断字段是否可省略。ZodDefault 有默认值，同样不该进 required。 */
function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = defOf(schema).typeName
  return typeName === 'ZodOptional' || typeName === 'ZodDefault'
}

/** 转换对象类型，并据字段可选性填充 required。 */
function convertObject(schema: z.ZodObject<z.ZodRawShape>, toolName: string, path: string): JsonSchema {
  const shape = (schema as unknown as { _def: { shape: () => z.ZodRawShape } })._def.shape()
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(shape)) {
    const child = value as z.ZodTypeAny
    properties[key] = convert(child, toolName, path ? `${path}.${key}` : key)
    if (!isOptional(child)) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

/**
 * OpenAI 兼容端点对函数名的约束：只允许字母、数字、下划线与连字符。
 * 点号会被拒绝（`Invalid 'tools[0].function.name': string does not match pattern`），
 * 而错误发生在请求端而非注册时，症状是「所有请求都 400」，很难定位到是命名问题。
 * 所以在转换时就挡住。
 */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/** 把工具的输入 Schema 转换为可发给模型的 JSON Schema 声明。 */
export function toToolSchema(tool: ToolDefinition): ToolSchema {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new AgentKitError(
      'TOOL_SCHEMA_UNSUPPORTED',
      `工具名 ${tool.name} 不合法：OpenAI 兼容端点只接受字母、数字、下划线与连字符（^[a-zA-Z0-9_-]+$），不能含点号等字符。`,
    )
  }
  const parameters = convert(tool.input as z.ZodTypeAny, tool.name, '')
  // 顶层必须是 object：OpenAI 的 function parameters 只接受对象形态。
  if (parameters.type !== 'object') {
    throw new AgentKitError('TOOL_SCHEMA_UNSUPPORTED', `工具 ${tool.name} 的输入 Schema 顶层必须是对象`)
  }
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters,
  }
}

/** 批量转换已注册工具。 */
export function toToolSchemas(tools: ToolDefinition[]): ToolSchema[] {
  return tools.map(toToolSchema)
}
