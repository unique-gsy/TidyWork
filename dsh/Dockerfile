# TidyWork · 第一步：只装 DSH（DeepSeek Harness）的镜像
# 插件不在镜像里，由第二步 docker-compose.plugin.yml 以卷挂载注入。
#
# DSH 基础镜像从 Docker Hub 拉不到时，可换国内代理：
#   docker compose build --build-arg BASE_IMAGE=dockerproxy.net/library/node:22-bookworm-slim
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

# 1) 基础依赖（apt 换清华源，避免国内拉取超时）
RUN sed -i "s|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g; s|http://security.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
    && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2) DSH 全局安装（国内网络慢可加 --registry=https://registry.npmmirror.com）
RUN npm install -g @deepseek-ai/dsh@0.2.1-rc.5 pnpm

# 3) 容器入口
WORKDIR /app
COPY dsh/entry.sh /app/entry.sh
RUN chmod +x /app/entry.sh

# 4) 运行时
# TIDYWORK_PLUGIN_DIR：第二步挂载插件的位置；镜像里不存在 → 第一步只跑纯 DSH
ENV DATA_DIR=/data \
    TIDYWORK_PLUGIN_DIR=/opt/tidywork-plugin
VOLUME ["/data", "/root/.dsh"]
EXPOSE 3080
CMD ["/app/entry.sh"]
