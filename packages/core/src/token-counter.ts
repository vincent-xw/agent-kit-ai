import type { SessionMessage } from './contracts.js'

export interface LlmUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function estimateMessages(messages: SessionMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0)
}

export function applyUsageCorrection(estimated: number, usage?: LlmUsage): number {
  if (usage?.total_tokens !== undefined && usage.total_tokens > 0) return usage.total_tokens
  return estimated
}
