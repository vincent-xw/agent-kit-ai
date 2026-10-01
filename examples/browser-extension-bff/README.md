# browser-extension-bff 示例

为「无 Secret 能力的前端项目」提供的最小 Node BFF：浏览器扩展只采集业务信息、请求 BFF，并按白名单执行远端工具；LLM API Key、Endpoint 与模型配置全部由 BFF 持有，扩展配置中不出现任何模型字段。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `AGENT_KIT_MASTER_KEY` | 是 | 32 字节 base64url 值。只用于 AES-256-GCM 加解密 SQLite 中的模型密钥，本身不入库。 |
| `BFF_API_TOKEN` | 是 | 扩展访问 BFF 的接入凭证。**不是** LLM API Key。 |
| `LLM_API_KEY` | 是 | 模型 API Key。只存在于 BFF 进程环境。 |
| `LLM_MODEL` | 是 | 模型名，例如 `doubao-pro-32k`。 |
| `LLM_BASE_URL` | 否 | OpenAI 兼容端点，默认 `https://ark.cn-beijing.volces.com/api/v3`。 |

缺少任一必填项时 BFF 拒绝启动并打印缺失项。

## 启动

首次先装依赖并准备环境变量（`.env.example` 是模板，`.env` 已被 gitignore）：

```bash
pnpm install && cp examples/browser-extension-bff/.env.example examples/browser-extension-bff/.env
```

填好 `.env` 后从仓库根目录启动。`.env` 由 Node 原生 `--env-file` 加载，无需手动 source：

```bash
pnpm dev:bff
```

| 命令 | 用途 |
|---|---|
| `pnpm dev:bff` | 开发模式。`tsc --watch` 增量编译 + `node --watch` 自动重启，改 prompt 或工具定义后无需手动重编 |
| `pnpm start:bff` | 一次性启动。先编译全部依赖包再跑 |

两者都会自动先编译 `@agentkit-ai/core`、`bff-hono`、`adapter-sqlite` —— 它们是 workspace
包，不编译就没有 `dist` 可导入。

默认监听 `http://localhost:8787`。扩展设置里填入该地址与 `BFF_API_TOKEN` 即可。

`.env` 缺失时不报错（用的是 `--env-file-if-exists`），可以纯靠环境变量启动；
CLI 上显式给出的变量**优先于** `.env`，便于临时换模型：

```bash
LLM_MODEL=another-model pnpm start:bff
```

> 主密钥每次随机生成的话，上一次落库的密文将无法解密（`key_version` 不匹配）。要复用同一个 SQLite 文件，请把主密钥固定在 `.env` 里。

验证服务在跑（返回 401 即说明已启动且鉴权生效）：

```bash
curl -s -w " HTTP %{http_code}\n" localhost:8787/v1/agent/sessions/s/run -H 'content-type: application/json' -d '{"input":"hi","context":{}}'
```

## 协议

发起运行：

```bash
curl -s localhost:8787/v1/agent/sessions/s-1/run -H 'authorization: Bearer dev-token' -H 'content-type: application/json' -d '{"input":"读取当前页面","context":{}}'
```

若响应为 `pending_tool_calls`，扩展只能执行白名单中的远端工具，并对**每个** `callId` 回填：

```bash
curl -s localhost:8787/v1/agent/sessions/s-1/tool-results/<callId> -H 'authorization: Bearer dev-token' -H 'content-type: application/json' -d '{"output":{"found":true,"x":100,"y":200}}'
```

同轮内还有未回填的 `callId` 时，回填接口继续返回剩余的 `pending_tool_calls` 且不推进模型。

## 已注册工具

全部 `execution: 'remote'`，由扩展执行、BFF 只校验结构：

`browser_snapshot`、`browser_read_page`、`browser_locate_element`、`browser_click`、`browser_hover`、`browser_wait_for`、`browser_input_text`、`browser_press_key`、`browser_scroll`、`browser_verify`、`browser_screenshot`、`browser_go_back`、`browser_save_file`、`browser_read_file`、`browser_write_file`

坐标契约：`x` / `y` 一律是相对主页面 viewport 的 **CSS 像素**，不乘 `devicePixelRatio`。该约定写在工具 description 里，模型据此传参。

## 安全要点

- 扩展移除 LLM Endpoint、模型与 API Key 设置项；密钥只由 BFF 进程环境持有。
- 主密钥（`AGENT_KIT_MASTER_KEY`）必须为 32 字节 base64url 值，只用于 AES-256-GCM 加解密，不写入 SQLite。
- 会话按已认证主体绑定命名空间（`<subject>:<sessionId>`），跨主体回填 `callId` 会被拒。
- 日志与错误响应不得包含密钥、Prompt 正文、模型原文或业务上下文；错误只返回 `{ code, requestId, message }`。
