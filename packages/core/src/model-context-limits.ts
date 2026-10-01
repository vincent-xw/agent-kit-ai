export const DEFAULT_CONTEXT_LIMIT = 256_000

const LIMITS: Record<string, number> = {
  'deepseek-chat': 64_000,
  'deepseek-coder': 64_000,
  'deepseek-reasoner': 64_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
}

export function resolveContextLimit(model: string, envLimit?: string): number {
  const parsedEnv = envLimit ? Number(envLimit) : Number.NaN
  if (!Number.isNaN(parsedEnv) && parsedEnv > 0) return parsedEnv
  const normalized = model.toLowerCase().trim()
  return LIMITS[normalized] ?? DEFAULT_CONTEXT_LIMIT
}
