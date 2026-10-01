#!/usr/bin/env bash
# BFF 启动脚本 (macOS / Linux)
# 用法：chmod +x start.sh && ./start.sh
# 关闭终端即停止 BFF，不做后台运行。

set -e

BFF_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$BFF_ROOT/../.." && pwd)"

echo_step() { echo -e "\n\033[36m========== $1 ==========\033[0m"; }
echo_ok()   { echo -e "  \033[32m[OK]\033[0m $1"; }
echo_warn() { echo -e "  \033[33m[!!]\033[0m $1"; }
echo_err()  { echo -e "  \033[31m[XX]\033[0m $1"; }

# ── 1. 检测 nvm ──
echo_step "检测 nvm"

export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
fi

if command -v nvm &>/dev/null; then
    echo_ok "nvm 已安装：$(nvm --version)"
else
    echo_warn "nvm 未安装，正在安装..."
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    if command -v nvm &>/dev/null; then
        echo_ok "nvm 安装成功：$(nvm --version)"
    else
        echo_err "nvm 安装失败。请手动安装：https://github.com/nvm-sh/nvm"
        read -p "按回车键退出..."
        exit 1
    fi
fi

# ── 2. 安装 Node 22 ──
echo_step "安装 Node.js 22"
nvm install 22
nvm use 22
nvm alias default 22 2>/dev/null || true

# ── 3. 检测 node 和 npm 版本 ──
echo_step "检测 Node 和 npm"
echo_ok "Node: $(node --version)"
echo_ok "npm: v$(npm --version)"

# ── 4. 检测 nrm ──
echo_step "检测 nrm"
if command -v nrm &>/dev/null; then
    echo_ok "nrm 已安装：v$(nrm --version 2>/dev/null || echo '已安装')"
else
    echo_warn "nrm 未安装，正在安装..."
    npm install -g nrm
    echo_ok "nrm 安装完成"
fi

# ── 5. 切换淘宝源 ──
echo_step "切换 npm 源到淘宝镜像"
nrm use taobao 2>/dev/null || nrm use cnpm 2>/dev/null || true
echo_ok "当前 npm 源：$(npm config get registry)"

# ── 6. 检测 pnpm ──
echo_step "检测 pnpm"
if command -v pnpm &>/dev/null; then
    echo_ok "pnpm 已安装：v$(pnpm --version)"
else
    echo_warn "pnpm 未安装，正在安装..."
    npm install -g pnpm
    echo_ok "pnpm 安装完成"
fi

# ── 7. 安装 BFF 依赖 ──
echo_step "安装 BFF 依赖"
echo "  项目目录：$BFF_ROOT"
echo "  workspace 根目录：$REPO_ROOT"
cd "$REPO_ROOT"
pnpm install
echo_ok "依赖安装完成"

# ── 8. 启动 BFF ──
echo_step "环境检查完毕，启动 BFF"
echo -e "  \033[33m首次启动会自动生成 .env 配置文件模板\033[0m"
echo -e "  \033[33m请填写后重新运行本脚本\033[0m"
echo ""
cd "$BFF_ROOT"
pnpm start

# ── 9. 等待用户按键 ──
echo ""
echo -e "\033[36mBFF 已停止运行。\033[0m"
read -p "按回车键退出..."
