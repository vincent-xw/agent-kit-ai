-- Agent Kit SQLite 表结构；与代码内 CREATE TABLE 保持一致。
-- agent_secrets 只保存 AES-GCM 密文与密钥版本，主密钥由 BFF 进程环境提供。
-- id 是槽位名：default 表示当前生效主 LLM 的镜像，llm:<profileId> / vision:<profileId> 是各档模型档案的权威密钥。
CREATE TABLE IF NOT EXISTS agent_secrets (
  id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_version TEXT NOT NULL
);

-- agent_sessions 保存受控 session 消息 JSON 与更新时间。
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  messages TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- agent_pending_calls 保存跨进程恢复所需的远端 Tool Call。
-- policy_version=1 表示旧行仅有 session/tool/prompt；新 Runtime 写入 version=2 的执行身份。
CREATE TABLE IF NOT EXISTS agent_pending_calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  prompt_name TEXT,
  run_instance_id TEXT,
  execution_scope_id TEXT,
  policy_digest TEXT,
  input_digest TEXT,
  policy_version INTEGER NOT NULL DEFAULT 2 CHECK (policy_version IN (1, 2)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

PRAGMA user_version = 2;
