@echo off
chcp 65001 >nul 2>&1
title BOOS BFF 启动器
color 0A

echo.
echo  ##########################################
echo  #                                        #
echo  #     BOOS Browser Extension BFF         #
echo  #                                        #
echo  ##########################################
echo.
echo  正在启动 PowerShell 脚本...
echo  如果看到安全提示，请选择"仍要运行"或按 Y。
echo.
echo  --------------------------------------------
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"

echo.
echo  --------------------------------------------
echo  脚本已结束。
pause
