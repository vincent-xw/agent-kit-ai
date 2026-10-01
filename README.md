# Agent Kit

面向项目 BFF 的最小 Agent 运行时。

## 包

- `@agentkit-ai/core`：工具注册、session、受限 harness 与稳定错误码。
- `@agentkit-ai/adapter-sqlite`：Node BFF SQLite session、挂起调用表与 AES-256-GCM 密钥库。
- `@agentkit-ai/bff-hono`：鉴权 BFF 路由与远端 Tool Host 回填协议。

## 工具调用

已注册工具的输入 Schema 会经 `toToolSchema` 转为 JSON Schema，并作为 `tools` 字段随每次补全请求发给模型——不发这个字段模型就不知道有哪些工具可调。工具注册表通过 `list()` 枚举，`ToolRegistry` 的实现方需提供该方法。

一轮响应内的**全部** `tool_calls` 都会被处理，`LlmResult` 与 `HarnessResult` 因此是复数形态（`tool_calls` / `pending_tool_calls`）。工具结果消息携带 `tool_call_id` 与其发起调用关联；assistant 轮次会连同它发起的 `toolCalls` 一并入库，使模型在后续轮次能看到自己的上一轮输出。

服务端工具通过 `execute(input, { signal })` 执行，受 `timeoutMs`（工具级）或 `toolTimeoutMs`（harness 级，默认 30 秒）约束。运行期失败会作为工具结果回传给模型让其自行补救；Schema 校验失败属于契约违约，直接抛 `TOOL_INPUT_INVALID` / `TOOL_OUTPUT_INVALID`。

## 安全规则

浏览器扩展、H5 与网页前端不得保存 `LLM_API_KEY`，也不得直接请求模型接口。Node BFF 设置 `AGENT_KIT_MASTER_KEY`（32 字节 base64url）以加密 SQLite 中的模型密钥。BFF 日志不得记录密钥、Prompt 正文、模型原文或业务上下文。

## 免责声明

本项目按“现状”提供，仅作为通用 Agent 运行时和开发示例，不构成任何法律、合规或安全建议。使用者应自行确认其使用方式、接入的数据、自动化行为以及部署环境符合适用的法律法规、平台规则、第三方服务条款和数据保护要求，并自行承担由此产生的全部责任。

本项目作者和贡献者不对使用本项目造成的任何直接或间接损失负责，也不对使用者或任何第三方基于本项目实施的行为作出授权、认可或担保。任何人使用本项目实施的侵权、违法违规、未经授权访问、滥用自动化或其他不当行为，均由实施者独立承担责任，与本项目及其作者、贡献者无关。

## 浏览器 Tool Host

插件调用 `POST /v1/agent/sessions/:sessionId/run`。若响应为 `pending_tool_calls`，插件只能执行已注册白名单工具，并对**每个** `callId` 调用 `POST /v1/agent/sessions/:sessionId/tool-results/:callId` 回填结果；同轮全部回填完毕后 harness 才推进模型，未填完时接口继续返回剩余的 `pending_tool_calls`。BFF 负责鉴权并将用户主体传入 harness。

挂起调用状态由 `PendingCallStore` 持有。默认实现是进程内 Map（进程重启即丢），生产环境应注入持久化实现——`@agentkit-ai/adapter-sqlite` 的 `createSqlitePendingCallStore` 即为此提供。

## 接入文档

- [浏览器扩展 + BFF 接入](docs/integrations/browser-extension-bff.md)
- [安全说明](docs/security.md)

## 验收清单

- [x] BFF 示例未在扩展配置中出现 Endpoint、模型或 API Key
- [x] SQLite 示例要求设置 `AGENT_KIT_MASTER_KEY`
- [x] 工具示例声明 `execution: 'remote'`

## 命令

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
