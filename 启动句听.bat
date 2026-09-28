@echo off
chcp 65001 >nul
title 句听 JuTing
cd /d "%~dp0"
echo 正在启动句听（首次运行需要初始化数据库，请耐心等待）...
node scripts\local\start-all.mjs
echo.
echo 句听已停止。按任意键关闭窗口。
pause >nul
