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
