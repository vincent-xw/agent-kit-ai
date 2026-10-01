# 演示文稿维护脚本

`update-agent-deck.mjs` 是当前 Agent 工程化实践 PPT 的可复用维护脚本，默认更新第 5 页架构图。脚本按形状 `name` 查找并更新内容；新增节点、文字和连接线也会先复用已有对象，重复执行不会持续叠加同名图形。

运行前先为临时工作区准备 `@oai/artifact-tool`：

```bash
rtk node /Users/xuewen/.codex/plugins/cache/openai-primary-runtime/presentations/26.802.11031/skills/presentations/container_tools/setup_artifact_tool_workspace.mjs --workspace /private/tmp/agent-deck-workspace
```

然后从该工作区执行：

```bash
rtk node /Users/xuewen/ai-lab/project/agent-kit/scripts/presentation/update-agent-deck.mjs
```

后续修改 PPT 内容时，优先调整脚本中的文本、位置和样式常量，再重新渲染校验，避免每次从零生成一套编辑代码。
