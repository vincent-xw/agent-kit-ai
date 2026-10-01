# 浏览器扩展 + BFF 接入指南

适用于 `BOOS_browser_ext` 一类没有 Secret 能力的前端项目。浏览器扩展仅采集业务信息、请求项目专属 BFF，并按白名单执行远端工具；LLM Endpoint、模型与 API Key 全部由 BFF 持有，扩展配置中不出现任何模型字段。

## 1. 部署 BFF

BFF 是独立 Node 服务，运行时要求：

```bash
export AGENT_KIT_MASTER_KEY=<32 字节 base64url 值>
export BFF_API_TOKEN=<扩展接入 token>
```

- `AGENT_KIT_MASTER_KEY` 只存在于 BFF 进程环境，用于 AES-256-GCM 加解密 SQLite 中的模型密钥，绝不写入 SQLite。
- `BFF_API_TOKEN` 是扩展访问 BFF 的接入凭证，不是 LLM API Key。

可直接复用仓库内示例 `examples/browser-extension-bff`：

```bash
pnpm install
pnpm --filter browser-extension-bff build
AGENT_KIT_MASTER_KEY=... BFF_API_TOKEN=... node examples/browser-extension-bff/dist/server.js
```

## 2. 扩展侧配置

扩展设置面板移除以下三项：

- ~~LLM Endpoint~~
- ~~模型~~
- ~~API Key~~

扩展唯一保留的业务配置是 BFF 地址与接入 token，且接入 token 不是 LLM API Key。

## 3. 调用协议

### 发起运行

```http
POST /v1/agent/sessions/:sessionId/run
Authorization: Bearer <BFF_API_TOKEN>
Content-Type: application/json

{ "input": "读取当前页面", "context": {} }
```

### 执行远端工具并回填

若响应为 `pending_tool_calls`，扩展只能执行已注册白名单中的工具，例如：

```ts
tools.register({
  name: 'browser.read_page',
  execution: 'remote',
  description: '读取当前页面标题与正文摘要',
  input: z.object({ url: z.string() }),
  output: z.object({ title: z.string() }),
})
```

`description` 会随 JSON Schema 一并发给模型，用于让模型理解工具用途。

响应形态是复数，一轮可能包含多个调用：

```json
{ "type": "pending_tool_calls", "calls": [{ "callId": "call-1", "toolName": "browser.read_page", "input": {} }] }
```

工具结果按 `callId` 逐个回填：

```http
POST /v1/agent/sessions/:sessionId/tool-results/:callId
Authorization: Bearer <BFF_API_TOKEN>
Content-Type: application/json

{ "output": { "title": "页面标题" } }
```

同轮内还有未回填的 `callId` 时，该接口继续返回剩余的 `pending_tool_calls` 且不推进模型；全部回填完毕后才返回 `final` 或下一轮的 `pending_tool_calls`。

BFF 会把已认证主体绑定到 session namespace，跨用户、跨 session 的 `callId` 回填会被拒绝（`PENDING_CALL_NOT_FOUND`）。挂起调用由 `createSqlitePendingCallStore` 落库，BFF 进程重启后回填仍能关联。

## 4. 安全要点

- 扩展不得在浏览器端存储或直连使用 LLM API Key。
- BFF 日志不得记录密钥、Prompt 正文、模型原文或业务上下文；错误响应只返回 `{ code, requestId, message }`。
