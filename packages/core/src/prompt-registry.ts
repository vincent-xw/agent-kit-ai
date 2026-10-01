import type { z } from 'zod'

import { AgentKitError } from './errors.js'

/** 已注册的提示词条目：以 name@version 唯一标识，可选输出协议。 */
export interface RegisteredPrompt {
  name: string
  version: string
  prompt: string
  /** 输出协议：可选的 Zod Schema，用于校验模型输出结构。 */
  protocol?: z.ZodType
}

/** 提示词注册表：以 name@version 注册系统提示词及输出协议。 */
export interface PromptRegistry {
  register(spec: { name: string; version: string; prompt: string; protocol?: z.ZodType }): void
  get(name: string, version: string): RegisteredPrompt | undefined
  /** 按名取（忽略 version）；同名多版本时返回最后注册的那个。 */
  getByName(name: string): RegisteredPrompt | undefined
  getDefault(): RegisteredPrompt | undefined
}

/** 内存实现；同名同版本重复注册直接报错，避免提示词被静默覆盖。 */
export function createPromptRegistry(): PromptRegistry {
  const prompts = new Map<string, RegisteredPrompt>()
  const byName = new Map<string, RegisteredPrompt>()
  let defaultPrompt: RegisteredPrompt | undefined
  return {
    register(spec) {
      const key = `${spec.name}@${spec.version}`
      if (prompts.has(key)) {
        throw new AgentKitError('PROMPT_ALREADY_REGISTERED', `提示词已注册：${key}`)
      }
      const entry: RegisteredPrompt = { ...spec }
      prompts.set(key, entry)
      byName.set(spec.name, entry)
      // 首个注册的提示词作为默认系统提示词，供 harness 无显式选择时使用。
      if (!defaultPrompt) defaultPrompt = entry
    },
    get(name, version) {
      return prompts.get(`${name}@${version}`)
    },
    getByName(name) {
      return byName.get(name)
    },
    getDefault() {
      return defaultPrompt
    },
  }
}
