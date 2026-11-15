#!/usr/bin/env bash
# 第一步：部署 DSH（纯 DSH，不含插件）
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJ"

docker compose up -d --build
echo "▶ 等待 DSH 就绪..."
for _ in $(seq 1 40); do
  docker compose logs --tail=200 assistant 2>/dev/null | grep -q "dsh web ready" && break
  sleep 1
done

URL="$(cat data/context/dsh-web-url.txt 2>/dev/null || true)"
[ -z "$URL" ] && { echo "✗ 未就绪，看日志：docker compose logs -f assistant"; exit 1; }
echo ""
echo "✅ DSH 已就绪：$URL"
echo "   下一步叠加插件：bash scripts/up-plugin.sh"
