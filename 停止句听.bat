@echo off
chcp 65001 >nul
title JuTing Stopper
cd /d "%~dp0"

rem -- 与「启动句听.bat」相同的 Node 解析顺序：便携 Node 优先，系统 Node 兜底 --
set "NODE_EXE=%~dp0temp\runtime\node\node.exe"
if exist "%NODE_EXE%" goto :found_node
set "NODE_CMD=node"
goto :run

:found_node
set "NODE_CMD=%NODE_EXE%"

:run
echo 正在停止句听的所有服务...
"%NODE_CMD%" scripts\local\stop-all.mjs
echo 按任意键关闭窗口。
pause >nul
