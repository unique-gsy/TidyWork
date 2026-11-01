#!/usr/bin/env bash
# 启动应用：默认 0.0.0.0:8080，数据目录 ../data（可用 WORKBENCH_DATA 覆盖）
set -euo pipefail
cd "$(dirname "$0")"

PORT="${WORKBENCH_PORT:-8080}"
HOST="${WORKBENCH_HOST:-0.0.0.0}"

if [ -d .venv ]; then
    exec ./.venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT"
else
    echo "未发现 .venv，请先运行 ./install.sh"
    exit 1
fi
