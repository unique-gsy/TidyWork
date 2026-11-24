@echo off
REM TidyWorky 邮箱模块 - Windows 便捷入口（对标 run.sh）
REM 用法：run.cmd <子命令> [参数]，例如：run.cmd self-check
setlocal
python "%~dp0run.py" %*
endlocal
