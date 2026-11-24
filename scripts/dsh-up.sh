#!/usr/bin/env bash
# dsh-up.sh — 一键启用 TidyWork（容器 + DSH web）
#
# 用法：
#   bash scripts/dsh-up.sh               # 启动容器，等 DSH web 就绪，自动打开浏览器
#   bash scripts/dsh-up.sh --build       # 改过插件/代码后重建再启动
#
# 说明：
#   - 容器启动时 entry.sh 会自动拉起 dsh web（3080）并把带 token 的地址
#     写进 data/context/dsh-web-url.txt，无需手动进容器执行 dsh web。
#   - 同一浏览器带 token 打开过一次后，30 天内直接访问 http://localhost:3080 即可。
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJ"

BUILD_FLAG=""
if [[ "${1:-}" == "--build" ]]; then
  BUILD_FLAG="--build"
fi

echo "▶ 启动 TidyWork 容器（DSH web 随 entry.sh 自动拉起）..."
docker compose up -d $BUILD_FLAG

echo "▶ 等待 DSH web 就绪..."
for _ in $(seq 1 30); do
  if docker compose logs --tail=300 assistant 2>/dev/null | grep -q "dsh web ready"; then
    break
  fi
  sleep 1
done

URL="$(cat data/context/dsh-web-url.txt 2>/dev/null || true)"
if [[ -z "$URL" ]]; then
  echo "✗ 未找到访问地址，请检查：docker compose logs assistant"
  exit 1
fi

echo ""
echo "✅ TidyWork 已就绪"
echo "   访问地址：$URL"
echo "   （同一浏览器打开过一次后，30 天内直接访问 http://localhost:3080 即可）"
echo "   日志：docker compose logs -f assistant"

if command -v open >/dev/null 2>&1; then
  open "$URL"          # macOS
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL"      # Linux
fi
