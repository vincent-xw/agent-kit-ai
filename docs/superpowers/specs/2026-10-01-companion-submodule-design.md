# Companion 子仓库拆分设计

## 目标

将 Android Companion 应用源码从公开主仓库的跟踪内容中移出，放入独立的私有 GitHub 仓库，同时保留开发工作区中的 `companion-android/` 路径，避免改动现有构建和 BFF 路径约定。

## 决策

- 子仓库显示名为 **Agent Kit Companion**，GitHub slug 为 `agent-kit-companion`。
- 子仓库远端地址预设为 `https://github.com/vincent-xw/agent-kit-companion.git`；远端仓库由用户通过 GitHub 插件创建并推送。
- 子仓库挂载路径为主仓库根目录下的 `companion-android/`。
- 子仓库初始提交采用当前 Companion 目录快照。既有完整历史保留在原私有仓库备份中，按需查询，不复制进新的子仓库历史。
- 主仓库仅保存 `.gitmodules` 配置和 Companion 子仓库的 gitlink，不再跟踪 Kotlin、Android 资源、Gradle Wrapper 等应用文件。

## 路径与依赖

当前根目录的 `build:companion` 脚本通过 `companion-android/gradlew` 构建；Agent Runtime BFF 也从主仓库根目录定位 `companion-android/app/build/outputs/apk/debug/` 下的 APK。子仓库维持原路径后，这些开发时的相对路径不变。

克隆主仓库但未初始化私有子仓库，或当前 GitHub 账号没有子仓库访问权限时，`companion-android/` 内容不可用，`build:companion` 无法构建。其他公开共享包和 browser-extension-bff 不依赖 Companion 子仓库。

## 实施范围

1. 在现有 `companion-android/` 内容上初始化独立 Git 仓库，提交当前 51 个已跟踪文件，并设置上述 `origin`。
2. 将其作为主仓库 `companion-android` 路径的 Git submodule，更新 `.gitmodules` 和主仓库 gitlink。
3. 保持 Android 源文件、Gradle 配置、APK 版本以及 BFF 源码不变。
4. 不创建远端仓库、不向 GitHub 推送。

## 结构验证

- 子仓库工作区干净，`main` 分支 HEAD 指向已提交快照。
- 主仓库索引中的 `companion-android` 模式为 `160000`，且 `.gitmodules` 路径、URL 与子仓库配置一致。
- 主仓库和子仓库都可独立查看提交状态；主仓库公开树中不再包含 Companion 源文件。

本次仅进行仓库结构迁移，不改 Android 行为或共享包代码，因此不运行 APK 构建、应用测试或 workspace 测试。
