#!/bin/bash
# 方寸后端管理脚本（容器内）：重启并拉起 uvicorn:8080
# 用法: bash /home/guosy/fangcun/start-backend.sh
set -u
cd /home/guosy/fangcun/backend || exit 1
PIDS=$(pgrep -f "[u]vicorn app.main")
if [ -n "$PIDS" ]; then
  kill $PIDS 2>/dev/null
  sleep 2
fi
setsid nohup ./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8080 \
  > /home/guosy/fangcun/backend-server.log 2>&1 < /dev/null &
echo $! > /home/guosy/fangcun/backend.pid
sleep 4
curl -s -m 5 http://localhost:8080/api/health
echo
