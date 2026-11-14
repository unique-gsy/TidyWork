#!/usr/bin/env bash
# 第二步：把插件叠加到已部署的 DSH 上（会自动重建容器以挂载 plugin/）
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJ"

docker compose -f docker-compose.yml -f docker-compose.plugin.yml up -d
echo "▶ 等待 DSH（含插件）就绪..."
for _ in $(seq 1 40); do
  docker compose logs --tail=200 dsh 2>/dev/null | grep -q "dsh web ready" && break
  sleep 1
done

URL="$(cat data/context/dsh-web-url.txt 2>/dev/null || true)"
[ -z "$URL" ] && { echo "✗ 未就绪，看日志：docker compose logs -f dsh"; exit 1; }
echo ""
echo "✅ TidyWork 插件已就位：$URL"
