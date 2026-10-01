#!/usr/bin/env bash
# BFF 源码打包脚本
# 用法：chmod +x pack.sh && ./pack.sh
# 产出：dist/boos-bff-YYYYMMDD-HHMMSS.zip

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BFF_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BFF_ROOT/../.." && pwd)"
OUTPUT_DIR="$BFF_ROOT/dist"
STAGING="$OUTPUT_DIR/boos-bff-staging"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ZIP_NAME="boos-bff-$TIMESTAMP.zip"
ZIP_PATH="$OUTPUT_DIR/$ZIP_NAME"

echo "打包 BFF 源码..."
echo "  仓库根目录：$REPO_ROOT"
echo "  输出路径：$ZIP_PATH"
echo ""

# 清理旧产物
rm -rf "$STAGING"
mkdir -p "$STAGING/boos-bff"

# ── 复制根目录配置文件 ──
echo "复制 workspace 配置..."
cp "$REPO_ROOT/package.json"        "$STAGING/boos-bff/"
cp "$REPO_ROOT/pnpm-workspace.yaml" "$STAGING/boos-bff/"
cp "$REPO_ROOT/tsconfig.base.json"  "$STAGING/boos-bff/"
[ -f "$REPO_ROOT/.npmrc" ] && cp "$REPO_ROOT/.npmrc" "$STAGING/boos-bff/"

# ── 复制 workspace 包（只取 src + package.json + tsconfig.json）──
for pkg in core bff-hono adapter-sqlite; do
  echo "复制 packages/$pkg..."
  mkdir -p "$STAGING/boos-bff/packages/$pkg"
  cp -R "$REPO_ROOT/packages/$pkg/src"          "$STAGING/boos-bff/packages/$pkg/"
  cp    "$REPO_ROOT/packages/$pkg/package.json" "$STAGING/boos-bff/packages/$pkg/"
  cp    "$REPO_ROOT/packages/$pkg/tsconfig.json" "$STAGING/boos-bff/packages/$pkg/"
done

# ── 复制 BFF 示例 ──
echo "复制 BFF 示例..."
mkdir -p "$STAGING/boos-bff/examples/browser-extension-bff"
cp -R "$BFF_ROOT/src"         "$STAGING/boos-bff/examples/browser-extension-bff/"
cp -R "$BFF_ROOT/deploy"      "$STAGING/boos-bff/examples/browser-extension-bff/"
cp    "$BFF_ROOT/package.json" "$STAGING/boos-bff/examples/browser-extension-bff/"
cp    "$BFF_ROOT/tsconfig.json" "$STAGING/boos-bff/examples/browser-extension-bff/"
cp    "$BFF_ROOT/build.mjs"    "$STAGING/boos-bff/examples/browser-extension-bff/"
cp    "$BFF_ROOT/.env.example" "$STAGING/boos-bff/examples/browser-extension-bff/"
[ -f "$BFF_ROOT/README.md" ] && cp "$BFF_ROOT/README.md" "$STAGING/boos-bff/examples/browser-extension-bff/"

# ── 生成说明文件 ──
cat > "$STAGING/boos-bff/README.md" <<'README'
# BOOS Browser Extension BFF

## 快速开始

### Windows
1. 解压 zip
2. 进入 `examples/browser-extension-bff/deploy/`
3. 右键 `start.ps1` -> "使用 PowerShell 运行"
4. 首次运行会自动生成 `.env` 配置文件，按提示填写后重新运行

### macOS
1. 解压 zip
2. 打开终端
3. 执行：
   ```bash
   cd examples/browser-extension-bff/deploy
   chmod +x start.sh
   ./start.sh
   ```
4. 首次运行会自动生成 `.env` 配置文件，按提示填写后重新运行

## .env 配置说明

| 变量 | 必填 | 说明 |
|---|---|---|
| AGENT_KIT_MASTER_KEY | 是 | 32 字节 base64url，生成：openssl rand -base64 32 |
| BFF_API_TOKEN | 是 | 扩展接入凭证，不是 LLM API Key |
| LLM_API_KEY | 是 | 模型 API Key |
| LLM_MODEL | 是 | 模型名 |
| LLM_BASE_URL | 否 | OpenAI 兼容端点，默认 DeepSeek |

## 目录结构

```
boos-bff/
├── package.json              workspace 根配置
├── pnpm-workspace.yaml       workspace 声明
├── tsconfig.base.json        共享 TS 配置
├── packages/
│   ├── core/                 agent-kit 核心
│   ├── bff-hono/            HTTP 路由
│   └── adapter-sqlite/      SQLite 适配器
└── examples/
    └── browser-extension-bff/
        ├── src/              BFF 源码
        ├── deploy/           启动脚本
        ├── build.mjs         打包配置
        └── .env.example      配置模板
```
README

# ── 排除不需要的文件 ──
echo "清理不需要的文件..."
find "$STAGING" -type d -name "node_modules" -exec rm -rf {} + 2>/dev/null || true
find "$STAGING" -type d -name "dist" -exec rm -rf {} + 2>/dev/null || true
find "$STAGING" -type d -name ".git" -exec rm -rf {} + 2>/dev/null || true
find "$STAGING" -name "*.sqlite" -delete 2>/dev/null || true
find "$STAGING" -name ".env" -not -name ".env.example" -delete 2>/dev/null || true
find "$STAGING" -name ".DS_Store" -delete 2>/dev/null || true

# ── 打 zip ──
echo "压缩..."
cd "$STAGING"
zip -r -q "$ZIP_PATH" boos-bff
cd - > /dev/null

# 清理临时目录
rm -rf "$STAGING"

# ── 输出结果 ──
FILE_SIZE=$(du -h "$ZIP_PATH" | cut -f1)
echo ""
echo "================================"
echo "打包完成：$ZIP_PATH"
echo "文件大小：$FILE_SIZE"
echo "================================"
echo ""
echo "解压后请阅读 README.md 按步骤操作。"
