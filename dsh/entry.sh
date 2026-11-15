#!/bin/bash
# TidyWork AI 助手 · 容器入口
# 0) 先安装 TidyWork 插件到 web profile（DSH 二开：侧边栏新增「工作区」入口）
# 1) dsh web（3080）：工作台/待办/会议/笔记 + 原生对话（模型可在 Models 页配置），
#    登录凭据写入 ~/.dsh（挂载到宿主机 data/dsh，跨容器重建保留）
# （v3.7：已移除原 FastAPI 桥接后端（8080），容器主进程改为 dsh web）
set -e
mkdir -p /root/.dsh /data

# DSH 拒绝通配符 0.0.0.0，动态绑定容器 IP；--trusted-host 显式豁免浏览器信任校验
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$IP" ] && IP=127.0.0.1

# 插件安装/同步：未装则安装；已装但代码有更新则移除重装；一致则跳过。
# （pnpm add file: 是拷贝副本，不重装不会带上最新代码）
PLUGIN_DIR=/root/.dsh/profiles/web/node_modules/@tidywork/dsh-plugin
PLUGIN_FAIL() {
  echo "TidyWork AI: plugin install failed"
  cat /root/.dsh/profiles/web/.plugin-manager/logs/*/pnpm.log 2>/dev/null | tail -20
  exit 1
}
if [ ! -e "$PLUGIN_DIR" ]; then
  echo "TidyWork AI: installing tidywork plugin into dsh web profile..."
  dsh plugin --profile web add file:/app/tidywork-plugin || PLUGIN_FAIL
  echo "TidyWork AI: tidywork plugin installed."
elif ! diff -rq "$PLUGIN_DIR" /app/tidywork-plugin >/dev/null 2>&1; then
  echo "TidyWork AI: plugin code changed, reinstalling into dsh web profile..."
  dsh plugin --profile web remove @tidywork/dsh-plugin || true
  dsh plugin --profile web add file:/app/tidywork-plugin || PLUGIN_FAIL
  echo "TidyWork AI: tidywork plugin updated."
else
  echo "TidyWork AI: tidywork plugin already installed and up to date, skipping."
fi

dsh web --host "$IP" --port 3080 --no-open --trusted-host "$IP:3080" > /dsh-web.log 2>&1 &
DSH_PID=$!
echo "TidyWork AI: dsh web pid=$DSH_PID ($IP:3080)"

# 日志转一份到容器 stdout：`docker compose logs` 也能看到插件请求日志；
# /dsh-web.log 仍保留，供下面解析 token
tail -n +1 -f /dsh-web.log 2>/dev/null &

# 等待 web 就绪，把带 token 的访问地址写到持久化目录（/data/dsh-web-url.txt）
# 只在 token 真正生成（长度足够）时才写入，避免写出 "?token=" 这种空地址
for i in $(seq 1 40); do
  HIT=$(grep -o "http://[^ ]*token=[A-Za-z0-9_-]\{10,\}" /dsh-web.log 2>/dev/null | head -1)
  if [ -n "$HIT" ]; then
    TOKEN=${HIT##*token=}
    # 写宿主机可达地址（容器 3080 已映射到宿主机）
    echo "http://localhost:3080/?token=$TOKEN" > /data/dsh-web-url.txt
    echo "TidyWork AI: dsh web ready -> http://localhost:3080/?token=$TOKEN"
    break
  fi
  sleep 1
done

# 容器生命周期跟随 dsh web：web 退出则容器退出（restart 策略会自动重启）
wait $DSH_PID
