#!/usr/bin/env bash
# 无 Docker 备选部署路径（架构 7.1）：建 venv、装依赖、准备前端静态产物
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
    python3 -m venv .venv
fi
./.venv/bin/pip install --quiet --upgrade pip
./.venv/bin/pip install --quiet -r requirements.txt

# 前端静态产物：发布包自带 frontend/dist 则直接使用；否则尝试现场构建
ROOT="$(cd .. && pwd)"
if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
    if command -v npm >/dev/null 2>&1; then
        echo "未找到 frontend/dist，尝试构建前端（需要 node/npm 与 npm 源可达）……"
        (cd "$ROOT/frontend" && npm install --no-audit --no-fund && npm run build)
    else
        echo "警告：未找到 frontend/dist 且无 npm，应用将以纯 API 模式启动（无页面）。"
    fi
fi

echo "安装完成。运行 ./start.sh 启动应用。"
