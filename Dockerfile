# TidyWork AI 助手 · 单容器镜像
# 组成：DSH（DeepSeek Harness，全局 CLI）+ TidyWork 工作区插件
# （v3.7：已移除原 FastAPI 桥接后端与静态前端，仅保留 DSH web + 插件）
# 构建上下文 = 项目根目录；用法：docker compose up -d --build
# 基础镜像可替换：Docker Hub 不可达时用
#   docker compose build --build-arg BASE_IMAGE=dockerproxy.net/library/node:22-bookworm-slim
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

# 1) 基础依赖：curl / ca-certificates
RUN sed -i "s|http://deb.debian.org/debian|http://mirrors.tuna.tsinghua.edu.cn/debian|g; s|http://security.debian.org/debian-security|http://mirrors.tuna.tsinghua.edu.cn/debian-security|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null || true \
    && apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2) DSH 全局安装（npm 官方源可达时用默认源；慢可加 --registry=https://registry.npmmirror.com）
# 版本钉死是"契约"不是随意挑的：插件用到的 webServer.register / slots / locale /
# layout.selectPanel 都按 0.2.1-rc.5 的签名实现，换版要先跑 tests/server.test.mjs 回归。
RUN npm install -g @deepseek-ai/dsh@0.2.1-rc.5 pnpm

# 3) 应用代码：入口脚本 + TidyWork 插件组合包（装入 web profile，侧边栏新增「工作区」入口）
WORKDIR /app
COPY scripts/entry.sh /app/entry.sh
RUN chmod +x /app/entry.sh
COPY tidywork-plugin /app/tidywork-plugin

# 4) 运行环境
ENV DATA_DIR=/data
VOLUME ["/data", "/root/.dsh"]
EXPOSE 3080
CMD ["/app/entry.sh"]
