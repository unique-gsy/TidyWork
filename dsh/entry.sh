#!/bin/bash
# TidyWork · 容器入口
# 1) 若挂载了插件目录（第二步），先装进 DSH 的 web profile
# 2) 拉起 dsh web（3080），把带 token 的访问地址写进 /data/dsh-web-url.txt
set -e
mkdir -p /root/.dsh /data

# DSH 拒绝 0.0.0.0，动态取容器 IP；--trusted-host 显式豁免浏览器信任校验
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP=127.0.0.1

PLUGIN_SRC="${TIDYWORK_PLUGIN_DIR:-/opt/tidywork-plugin}"
PROFILE_PLUGIN=/root/.dsh/profiles/web/node_modules/@tidywork/dsh-plugin

if [ -f "$PLUGIN_SRC/package.json" ]; then
  # 拷贝到容器内可写副本再装：宿主机目录通常以只读方式挂载，pnpm 需要写权限
  rm -rf /tmp/tidywork-plugin.src
  cp -a "$PLUGIN_SRC" /tmp/tidywork-plugin.src
  if [ ! -e "$PROFILE_PLUGIN" ]; then
    echo "TidyWork: 安装插件到 dsh web profile..."
    dsh plugin --profile web add file:/tmp/tidywork-plugin.src || {
      echo "TidyWork: 插件安装失败"; cat /root/.dsh/profiles/web/.plugin-manager/logs/*/pnpm.log 2>/dev/null | tail -20; exit 1; }
    echo "TidyWork: 插件已安装。"
  elif ! diff -rq "$PROFILE_PLUGIN" /tmp/tidywork-plugin.src >/dev/null 2>&1; then
    echo "TidyWork: 插件代码有更新，重装..."
    dsh plugin --profile web remove @tidywork/dsh-plugin || true
    dsh plugin --profile web add file:/tmp/tidywork-plugin.src || {
      echo "TidyWork: 插件重装失败"; cat /root/.dsh/profiles/web/.plugin-manager/logs/*/pnpm.log 2>/dev/null | tail -20; exit 1; }
    echo "TidyWork: 插件已更新。"
  else
    echo "TidyWork: 插件已是最新，跳过。"
  fi
else
  echo "TidyWork: 未挂载插件目录，只启动纯 DSH。"
fi

dsh web --host "$IP" --port 3080 --no-open --trusted-host "$IP:3080" > /dsh-web.log 2>&1 &
DSH_PID=$!
echo "TidyWork: dsh web pid=$DSH_PID ($IP:3080)"

# 日志转一份到容器 stdout：`docker compose logs` 也能看到插件请求日志；
# /dsh-web.log 仍保留，供下面解析 token
tail -n +1 -f /dsh-web.log 2>/dev/null &

# 只在 token 真正生成（长度足够）时才写入，避免写出 "?token=" 这种空地址
for i in $(seq 1 40); do
  HIT=$(grep -o "http://[^ ]*token=[A-Za-z0-9_-]\{10,\}" /dsh-web.log 2>/dev/null | head -1)
  if [ -n "$HIT" ]; then
    TOKEN=${HIT##*token=}
    HPORT="${DSH_HOST_PORT:-3080}"
    echo "http://localhost:$HPORT/?token=$TOKEN" > /data/dsh-web-url.txt
    echo "TidyWork: dsh web ready -> http://localhost:$HPORT/?token=$TOKEN"
    break
  fi
  sleep 1
done

wait $DSH_PID
