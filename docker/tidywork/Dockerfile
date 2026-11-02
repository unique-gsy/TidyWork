# TidyWork 容器：方寸后端（FastAPI + /dsh/* 反向代理 + ws 代理）
# 构建上下文为 WorkBoard 根目录（见 compose 中 context: ..），直接用 backend/ 最新代码
FROM python:3.12-slim

# backend 布局保持与代码假设一致（config.py BASE_DIR=parents[2] 解析为仓库根）：
#   /app/backend/app/config.py -> BASE_DIR=/app -> static=/app/static、data=/app/data
WORKDIR /app/backend

# 系统依赖（curl 用于调试探活）
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
# docker CLI（静态二进制，仅 CLI 无 daemon）：dsh_client 经 docker exec DSH 执行 dsh headless
ARG DOCKER_CLI_VERSION=27.5.1
RUN curl -fsSL https://download.docker.com/linux/static/stable/aarch64/docker-${DOCKER_CLI_VERSION}.tgz -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && mv /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

# Python 依赖（清华 PyPI 镜像，避免 pypi.org 直连慢）
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r /app/backend/requirements.txt

# 应用代码
COPY backend/app /app/backend/app

# 前端单文件在 WorkBoard 根目录（方寸.html，即 TidyWork 主页面）；
# 与虚拟机内 static/ 布局一致：index.html 与 方寸.html 双份
RUN mkdir -p /app/static
COPY 方寸.html /app/static/index.html
COPY 方寸.html /app/static/方寸.html

# TidyWork 业务数据目录（compose 中挂载宿主机 /Users/guosy/Documents/TidyWork/data，
# 并以环境变量 WORKBENCH_DATA 指向本目录，后端据此读写数据）
RUN mkdir -p /home/tidywork/data

EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
