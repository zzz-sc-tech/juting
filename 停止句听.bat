@echo off
chcp 65001 >nul
title 停止句听
cd /d "%~dp0"
echo 正在停止句听的所有服务...
node scripts\local\stop-all.mjs
echo 按任意键关闭窗口。
pause >nul
