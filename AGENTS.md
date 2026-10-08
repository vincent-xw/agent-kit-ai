# Agent Kit 协作说明

- 始终使用简体中文回答。
- 函数、变量及复杂业务逻辑添加中文注释。
- 默认不做字段兜底；如需兜底，说明原因。
- 不启动 subagent；在当前工作区完成开发、审查和验证。

## 仓库边界

- `packages/core`、`packages/bff-hono`、`packages/adapter-sqlite` 是共享基础包。
- `examples/browser-extension-bff` 随主仓库公开。
- `examples/agent-runtime-bff` 是私有 Git submodule。没有访问权限的克隆可能没有该目录内容；不要把它的源文件或内部设计文档加入主仓库。
- 根目录 `pnpm-workspace.yaml` 会扫描 `packages/*` 与 `examples/*`。有权限的内部开发环境可以在同一工作区使用私有 BFF。

## 共享包变更

- 只升级实际修改的共享包。验证阶段先用 Beta 版本；验证通过后按 SemVer 影响升级正式版本，并核对 workspace 依赖与构建产物。
- 修改 `packages/core`、`packages/bff-hono` 或 `packages/adapter-sqlite` 时，同步审阅并更新 sibling 仓库 `../agent-doc/docs/packages/{core,bff-hono,adapter-sqlite}.md` 中对应的包文档；只改动受本次代码变化影响的文档，并确保示例与当前公开导出一致。
- 在包文档新增 API 说明时，标注该 API 首次引入的包版本（例如“自 `@agentkit-ai/core` v1.3.2 起提供”）。通过 Git 首次引入提交中的 `package.json` 版本、Git tag 和 npm registry 交叉核对；没有发布证据时，明确写成“源码版本/计划版本，尚未发布”，不能让读者误以为该版本可安装。
- 修改共享包后，检查 `browser-extension-bff` 和私有 `agent-runtime-bff` 的兼容性。只有 BFF submodule 已初始化且可访问时，才能完成后者的验证。
- 全 workspace 验证命令为 `pnpm -r typecheck && pnpm -r test && pnpm -r build`。

## Companion APK

修改 `companion-android/app/src/main/`、`AndroidManifest.xml`、资源或会影响 APK 行为的 Gradle 配置时，递增 `versionCode` 和 `versionName`，并在 `companion-android` 下运行：

```bash
rtk ./gradlew :app:testDebugUnitTest :app:assembleDebug --offline
```

## 单测维护

- 优先验证可观察行为、协议结果、状态变化、持久化副作用和安全边界。
- 不新增只检查源码 ID、函数名、CSS 选择器、正则或文案的测试；纯文本交付物应从构建产物或消费者行为验证。
- 新增回归测试前搜索同层覆盖，能扩展现有场景时不为同一根因重复建例。
- UI 静态结构不做逐元素断言；关键交互使用 JSDOM，跨模块或真实布局使用少量 Playwright 场景。
