@echo off
chcp 65001 >nul
title JuTing Launcher
cd /d "%~dp0"

rem -- control flow stays ASCII-only; Chinese text lives in bare echo lines --
rem -- (UTF-8 bytes inside parenthesized blocks get mis-decoded as GBK and break parsing) --

if not exist "scripts\local\start-all.mjs" goto :notextracted

set "NODE_EXE=%~dp0temp\runtime\node\node.exe"
if exist "%NODE_EXE%" goto :found_node
where node >nul 2>nul
if %errorlevel%==0 goto :sys_node
goto :no_node

:found_node
set "NODE_CMD=%NODE_EXE%"
goto :run

:sys_node
set "NODE_CMD=node"
goto :run

:notextracted
echo 【请先解压】检测到句听可能还在压缩包里直接运行。
echo 请把压缩包内的全部文件解压到任意文件夹，例如 D:\juting ，再双击「启动句听.bat」。
echo.
pause
exit /b 1

:no_node
echo 【缺少运行环境】未找到 Node.js，且包内没有携带便携版 Node。
echo 两种解决办法，任选其一：
echo   1. 重新下载「完整版」或「简洁版」安装包，内置 Node，无需任何安装；
echo   2. 手动安装 Node.js 后重试：https://nodejs.org/zh-cn
echo.
pause
exit /b 1

:run
echo 正在启动句听，首次运行需要初始化数据库，请耐心等待...
"%NODE_CMD%" scripts\local\start-all.mjs %*
echo.
echo 句听已停止。按任意键关闭窗口。
pause >nul
