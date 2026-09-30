@echo off
chcp 65001 >nul
title dsh-profile-sync 安装
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node，请确认 Node.js 已装且在 PATH 上。
  pause
  exit /b 1
)
echo 装 dsh-profile-sync 到 profile（默认 desktop）。
echo 如果报「目标端还在运行」，先把 DeepSeek Harness 完全退出再重来。
echo.
node "%~dp0bin\bootstrap.mjs" %*
echo.
pause