@echo off
rem Windows 等价启动脚本（无 Docker 备选路径）
cd /d %~dp0
if not exist .venv (
    python -m venv .venv
    .venv\Scripts\pip install --quiet -r requirements.txt
)
set WORKBENCH_HOST=0.0.0.0
set WORKBENCH_PORT=8080
.venv\Scripts\uvicorn app.main:app --host %WORKBENCH_HOST% --port %WORKBENCH_PORT%
