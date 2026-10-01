# 安全说明

Agent Kit 的安全边界由设计说明与各适配器共同保证。本文档给出密钥管理、轮换与日志规则。

## 密钥边界

- 浏览器、扩展与 H5 永不接收、不存储、不直连使用 LLM API Key。
- `@agentkit-ai/adapter-sqlite` 只在 Node BFF 使用 SQLite 保存加密后的密钥；主密钥由 BFF 进程环境变量 `AGENT_KIT_MASTER_KEY` 提供，不写入 SQLite。
- 未配置密钥时直接返回 `SECRET_NOT_CONFIGURED`，不做默认值兜底，不从浏览器存储或明文文件读取。

## 主密钥要求

- `AGENT_KIT_MASTER_KEY` 必须是 32 字节 base64url 值，例如 `openssl rand -base64 32` 后转 base64url。
- 密钥库表 `agent_secrets` 保存 AES-256-GCM 的 `ciphertext`、`iv`、`tag` 与 `key_version`；`key_version` 由主密钥派生，用于轮换后拒绝旧密文。
- 主密钥缺失、长度非法、版本不匹配或解密失败时均返回明确错误，绝不生成临时主密钥。

## 轮换步骤

### 轮换 LLM API Key

1. 更新 BFF 中的密钥记录：`runtime.secrets.put({ apiKey: <新 Key>, baseUrl, model })` 重新加密写入。
2. 旧 Key 在服务端失效后立即失效；BFF 侧旧密文被覆盖，无需其它操作。

### 轮换主密钥

1. 用新主密钥重新写入全部密钥记录（`put` 会使用新的 `key_version`）。
2. 再替换 BFF 进程环境变量中的 `AGENT_KIT_MASTER_KEY`。
3. 若忘记先重写记录，旧密文因 `key_version` 不匹配会被拒绝，需重新配置。

## 日志与审计

审计日志只允许记录：

- `requestId`
- 模型标识
- 耗时
- HTTP 状态
- 工具名
- 错误码

禁止记录：密钥、Prompt 正文、模型原文、业务上下文。

## 错误响应

BFF 的错误响应统一为 `{ code, requestId, message }`：

- `UNAUTHORIZED` / `REQUEST_INVALID`：鉴权或参数问题（HTTP 400/401）。
- 业务错误码（如 `SECRET_NOT_CONFIGURED`、`HARNESS_STEP_LIMIT`）：由 `AgentKitError` 原样透出。
- 其它未知错误归一化为 `INTERNAL`，不回显内部堆栈或输入正文。
