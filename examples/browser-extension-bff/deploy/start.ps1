# BFF 启动脚本 (Windows PowerShell)
# 双击 start.bat 运行（推荐），或在 PowerShell 中执行：.\start.ps1
# 关闭窗口即停止 BFF，不做后台运行。

$ErrorActionPreference = "Stop"
$BFF_ROOT = Split-Path -Parent $PSScriptRoot

# ── 日志文件 ──
$LogFile = Join-Path $BFF_ROOT "deploy\bff-start.log"
function Log($msg) {
    $time = Get-Date -Format "HH:mm:ss"
    $line = "[$time] $msg"
    Add-Content -Path $LogFile -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
}

function Write-Step($msg) { Write-Host "`n========== $msg ==========" -ForegroundColor Cyan; Log "STEP: $msg" }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green; Log "OK: $msg" }
function Write-Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow; Log "WARN: $msg" }
function Write-Err($msg)  { Write-Host "  [XX] $msg" -ForegroundColor Red; Log "ERROR: $msg" }
function Write-Info($msg) { Write-Host "  ..  $msg" -ForegroundColor Gray; Log "INFO: $msg" }

# ── 启动横幅 ──
Write-Host ""
Write-Host "  ##########################################" -ForegroundColor Cyan
Write-Host "  #                                        #" -ForegroundColor Cyan
Write-Host "  #     BOOS Browser Extension BFF         #" -ForegroundColor Cyan
Write-Host "  #                                        #" -ForegroundColor Cyan
Write-Host "  ##########################################" -ForegroundColor Cyan
Write-Host ""
Log "===== BFF 启动脚本开始 ====="
Write-Info "脚本路径：$PSCommandPath"
Write-Info "BFF 目录：$BFF_ROOT"
Write-Info "日志文件：$LogFile"
Write-Info "操作系统：$([System.Environment]::OSVersion.VersionString)"
Write-Info "PowerShell：$($PSVersionTable.PSVersion)"

# ── 全局错误捕获 ──
try {

# ── 1. 检测 nvm ──
Write-Step "步骤 1/8：检测 nvm"
Write-Info "正在检查 nvm 命令是否可用..."
$nvmInstalled = $false
try {
    $nvmVersion = & nvm version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nvmVersion) {
        $nvmInstalled = $true
        Write-Ok "nvm 已安装：$nvmVersion"
    }
} catch {
    Write-Info "nvm 命令未找到（异常：$($_.Exception.Message)）"
}

if (-not $nvmInstalled) {
    Write-Warn "nvm 未安装，尝试通过 winget 安装..."
    Write-Info "执行：winget install CoreyButler.NVMforWindows"
    try {
        $wingetResult = & winget install CoreyButler.NVMforWindows --accept-package-agreements --accept-source-agreements 2>&1
        Write-Info "winget 输出：$wingetResult"
        # 刷新环境变量
        Write-Info "刷新环境变量..."
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
        $nvmVersion = & nvm version 2>$null
        if ($nvmVersion) {
            Write-Ok "nvm 安装成功：$nvmVersion"
        } else {
            Write-Err "nvm 安装失败。winget 可能不可用或网络问题。"
            Write-Err "请手动安装 nvm：https://github.com/coreybutler/nvm-windows/releases"
            Write-Host ""
            Write-Host "  下载 nvm-setup.exe，双击安装，安装完成后重新运行本脚本。" -ForegroundColor Yellow
            throw "nvm 安装失败"
        }
    } catch {
        if ($_.Exception.Message -ne "nvm 安装失败") {
            Write-Err "winget 不可用或安装出错：$($_.Exception.Message)"
        }
        Write-Err "请手动安装 nvm：https://github.com/coreybutler/nvm-windows/releases"
        Write-Host ""
        Write-Host "  下载 nvm-setup.exe，双击安装，安装完成后重新运行本脚本。" -ForegroundColor Yellow
        throw "nvm 安装失败"
    }
}

# ── 2. 安装 Node 22 ──
Write-Step "步骤 2/8：安装 Node.js 22"
Write-Info "执行：nvm install 22"
& nvm install 22
Write-Info "执行：nvm use 22"
& nvm use 22
# 刷新 PATH
Write-Info "刷新 PATH 环境变量..."
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")

# ── 3. 检测 node 和 npm 版本 ──
Write-Step "步骤 3/8：检测 Node 和 npm"
Write-Info "执行：node --version"
$nodeVersion = & node --version 2>&1
Write-Info "执行：npm --version"
$npmVersion = & npm --version 2>&1
Write-Ok "Node: $nodeVersion"
Write-Ok "npm: v$npmVersion"

if (-not $nodeVersion) {
    Write-Err "Node.js 未能正确安装或不在 PATH 中"
    throw "Node.js 不可用"
}

# ── 4. 检测 nrm ──
Write-Step "步骤 4/8：检测 nrm"
Write-Info "正在检查 nrm 命令是否可用..."
$nrmInstalled = $false
try {
    $nrmVersion = & nrm --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $nrmVersion) {
        $nrmInstalled = $true
        Write-Ok "nrm 已安装：v$nrmVersion"
    }
} catch {
    Write-Info "nrm 命令未找到"
}

if (-not $nrmInstalled) {
    Write-Warn "nrm 未安装，正在安装..."
    Write-Info "执行：npm install -g nrm"
    & npm install -g nrm 2>&1 | ForEach-Object { Write-Info $_ }
    Write-Ok "nrm 安装完成"
}

# ── 5. 切换淘宝源 ──
Write-Step "步骤 5/8：切换 npm 源到淘宝镜像"
Write-Info "执行：nrm use taobao"
& nrm use taobao 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Info "taobao 不可用，尝试 cnpm..."
    & nrm use cnpm 2>$null
}
$currentRegistry = & npm config get registry
Write-Ok "当前 npm 源：$currentRegistry"

# ── 6. 检测 pnpm ──
Write-Step "步骤 6/8：检测 pnpm"
Write-Info "正在检查 pnpm 命令是否可用..."
$pnpmInstalled = $false
try {
    $pnpmVersion = & pnpm --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $pnpmVersion) {
        $pnpmInstalled = $true
        Write-Ok "pnpm 已安装：v$pnpmVersion"
    }
} catch {
    Write-Info "pnpm 命令未找到"
}

if (-not $pnpmInstalled) {
    Write-Warn "pnpm 未安装，正在安装..."
    Write-Info "执行：npm install -g pnpm"
    & npm install -g pnpm 2>&1 | ForEach-Object { Write-Info $_ }
    Write-Ok "pnpm 安装完成"
}

# ── 7. 安装 BFF 依赖 ──
Write-Step "步骤 7/8：安装 BFF 依赖"
$repoRoot = Split-Path -Parent (Split-Path -Parent $BFF_ROOT)
Write-Info "BFF 目录：$BFF_ROOT"
Write-Info "workspace 根目录：$repoRoot"
Write-Info "切换到 workspace 根目录..."
Set-Location $repoRoot
Write-Info "执行：pnpm install（可能需要几分钟，请耐心等待...）"
& pnpm install 2>&1 | ForEach-Object { Write-Info $_ }
if ($LASTEXITCODE -ne 0) {
    Write-Err "依赖安装失败（退出码：$LASTEXITCODE）"
    throw "依赖安装失败"
}
Write-Ok "依赖安装完成"

# ── 8. 启动 BFF ──
Write-Step "步骤 8/8：环境检查完毕，启动 BFF"
Write-Host ""
Write-Host "  首次启动会自动生成 .env 配置文件模板" -ForegroundColor Yellow
Write-Host "  请填写后重新运行本脚本" -ForegroundColor Yellow
Write-Host ""
Write-Info "切换到 BFF 目录..."
Set-Location $BFF_ROOT
Write-Info "执行：pnpm start"
Write-Host ""
Log "BFF 进程启动中..."
& pnpm start

} catch {
    # ── 全局错误处理：确保窗口不关闭 ──
    Write-Host ""
    Write-Err "脚本执行出错：$($_.Exception.Message)"
    Write-Host ""
    Write-Host "  请截图此窗口内容反馈给开发者。" -ForegroundColor Yellow
    Write-Host "  日志文件：$LogFile" -ForegroundColor Yellow
    Write-Host ""
    Log "FATAL: $($_.Exception.Message)"
    Log "===== 脚本异常终止 ====="
}

# ── 等待用户按键 ──
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "BFF 已停止运行。" -ForegroundColor Cyan
Write-Host "日志文件：$LogFile" -ForegroundColor Gray
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Read-Host "按回车键关闭窗口"
