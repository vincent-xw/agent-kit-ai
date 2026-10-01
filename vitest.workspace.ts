import { defineWorkspace } from 'vitest/config'

/**
 * 各 workspace 包与示例各自作为独立 vitest 项目运行。
 * 示例必须纳入：BFF 装配与鉴权红线的测试都在 examples/browser-extension-bff 里。
 */
export default defineWorkspace([
  'packages/*',
  'examples/*',
])
