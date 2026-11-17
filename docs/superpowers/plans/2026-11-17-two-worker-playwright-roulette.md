# 双 Worker Playwright Runtime 与虚拟轮盘游戏 Implementation Plan

> **For agentic workers:** 用户明确批准后，使用 `superpowers:executing-plans` 在当前工作区逐项执行；本仓库禁止启动 subagent。步骤使用 `- [ ]` 跟踪。

**Goal:** 在独立公开示例中实现固定两个 Worker 的 Playwright FIFO 抓取 Runtime，以及不占用 Worker 的可测试虚拟轮盘游戏。

**Architecture:** Hono 主线程提供 Agent Tool、REST、SSE 和 WebUI；两个 Worker Thread 各自持有 Playwright Browser，并从事务型 SQLite FIFO 队列领取任务。SQLite 状态是任务唯一权威，游戏使用独立表与短事务，服务端 RNG 决定结果。

**Tech Stack:** Node.js 22、TypeScript ESM、Hono、`node:sqlite`、`worker_threads`、Playwright、Web Audio API、Vitest、Playwright Test。

**Spec:** `docs/superpowers/specs/2026-11-17-two-worker-playwright-roulette-design.md`

## Global Constraints

- 设计未获批准前不创建源码、依赖或迁移；批准后也不修改 `packages/core` 或私有 BFF 子模块。
- Worker 数固定为 2，每 Worker 同时最多一个 Job；FIFO 以 SQLite `enqueue_seq` 为唯一顺序。
- Job 状态使用 `worker_id + lease_token + revision` CAS；dispatch 后未知副作用禁止自动重试。
- 只允许固定 recipe 和 origin allowlist；拒绝任意 JavaScript、私网目标及跨未授权 origin 重定向。
- 每个任务先写失败测试并确认 RED，再做最小实现；提交只包含该任务文件，并使用中文注释。

## Review Focus

- 两个 Worker 同抢队列时是否只领取两个不同队首任务，且第三个在槽位释放前保持 `queued`。
- Worker 崩溃、lease 过期或迟到写回时，是否不会创建第三个长期 Worker，也不会覆盖新 attempt。
- `safe_read` 与 `side_effecting` 在 dispatch 后断连时是否进入不同且可解释的恢复状态。
- 游戏重复 `actionId` 是否只消耗一次膛位，静音或减少动态效果时核心结果是否仍可理解。
- 抓取 URL、重定向和结果大小是否经过服务端硬校验，日志与 SSE 是否不泄露页面正文或凭据。

## File Map

- Create `examples/worker-roulette-runtime/package.json`、`src/server.ts`、`src/runtime/worker-coordinator.ts`、`src/runtime/playwright-worker.ts`：示例装配与双 Worker 生命周期。
- Create `src/runtime/scrape-job-store.ts`、`src/runtime/playwright-scraper.ts`、`src/tools/scrape-tools.ts`、`src/events/event-stream.ts`：FIFO、抓取、Agent Tool 与 SSE。
- Create `src/game/game-service.ts`、`src/game/game-store.ts`、`public/index.html`、`public/app.js`、`public/app.css`：游戏服务、状态和音视频界面。
- Modify root `pnpm-lock.yaml`：只增加示例所需已确认依赖；不改共享包版本。

## Tasks
### Task 1: 建立示例与 SQLite FIFO store
**Files:** Create package/server/store/schema files and `scrape-job-store.test.ts` under `examples/worker-roulette-runtime/`.
- [ ] 写并发 claim、FIFO、幂等提交和 stale lease 测试；运行 `rtk pnpm --filter worker-roulette-runtime test -- scrape-job-store`，预期 RED。
- [ ] 实现 WAL schema、`enqueue`、`claimNext(workerId, now)`、`renew`、`complete`、`fail`、`cancel`；同类测试 PASS 后提交 `feat: add durable scrape job queue`。
### Task 2: 建立固定两个 Worker 与 Playwright scraper
**Files:** Create `src/runtime/worker-coordinator.ts`、`playwright-worker.ts`、`playwright-scraper.ts` and their tests.
- [ ] 用本地 fixture HTTP Server 写“两个 Worker、每 Worker 一 Page、第三 Job 不启动”测试；运行 filter test，预期 RED。
- [ ] 实现 Coordinator 容量 2、Worker 自 claim、lease heartbeat、Context/Page `finally` 清理与 Browser 回收；测试 PASS 后提交 `feat: run two isolated playwright workers`。
### Task 3: 接 REST、Agent Tools 与 SSE
**Files:** Create `src/tools/scrape-tools.ts`、`src/events/event-stream.ts`；修改 `src/server.ts`、`src/server.test.ts`。
- [ ] 写 submit/status/cancel、Tool 参数边界和 `after=eventSeq` 回放测试；运行相关 Vitest，预期 RED。
- [ ] 实现严格 Zod 输入、三个 server Tool、REST 与事务后 SSE；测试 PASS 后提交 `feat: expose scrape runtime api and tools`。
### Task 4: 实现轮盘服务与 turn-level tests
**Files:** Create `src/game/game-service.ts`、`game-store.ts`、`game-service.test.ts`；修改 schema/server tests。
- [ ] 注入固定 RNG，写 6 膛路径、`click/bang`、重复 `actionId` 幂等测试；运行游戏测试，预期 RED。
- [ ] 实现 CSPRNG、原子 shot 与 reset、24h 清理和 REST 路由；测试 PASS 后提交 `feat: add idempotent virtual roulette game`。
### Task 5: 完成队列 UI、轮盘动画与合成音效
**Files:** Create `public/index.html`、`app.js`、`app.css`、`tests/ui.spec.ts`；修改 `src/server.ts` 静态资源。
- [ ] 用真实静态资源写 1440×900/960×800、SSE 恢复、静音、reduce-motion 和键盘测试；运行 Playwright，预期 RED。
- [ ] 实现受控 DOM、Web Audio 合成、动画降级与文本状态；测试 PASS 后提交 `feat: add queue and roulette web experience`。
### Task 6: 收口恢复、安全与真实双 Worker E2E
**Files:** Extend runtime tests、`tests/e2e.spec.ts`、`README.md`、`docs/acceptance/2026-11-17-two-worker-playwright-roulette.md`.
- [ ] 写 Worker kill/重启、lease 恢复、SSRF/重定向拒绝、结果超限和 3-Job 顺序测试；运行定向与 E2E，预期 RED。
- [ ] 实现剩余恢复/安全规则，运行 `rtk pnpm --filter worker-roulette-runtime typecheck test build` 与 Playwright E2E，记录真实结果后提交 `test: verify worker recovery and roulette e2e`。
