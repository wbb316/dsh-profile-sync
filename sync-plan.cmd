@echo off
chcp 65001 >nul
title dsh-profile-sync 算差异
where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 node，请确认 Node.js 已装且在 PATH 上。
  pause
  exit /b 1
)
node "%~dp0bin\plan-cli.mjs" plan --write %*
echo.
pause