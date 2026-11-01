# 方寸 × DSH · 一键 Docker 部署（OrbStack / Docker 通用）

两个容器 **TidyWork**（方寸后端）与 **DSH**（DeepSeek Harness），一条命令起停。

## 一键部署

```bash
cd WorkBoard/docker
docker compose up -d --build
```

- OrbStack 与 Docker Desktop 均内置 `docker` CLI，命令完全一致
- 启动后浏览器打开 **http://localhost:8080**
- 页面上点「⇄ DSH」进入全量 DeepSeek Harness；DSH 右上角方形图标或 Esc 切回方寸

## 架构

```
docker/
├── docker-compose.yml      # 编排（项目名 tidywork）
├── tidywork/Dockerfile     # TidyWork 容器：方寸后端 + /dsh/* 代理（python:3.12）
└── dsh/Dockerfile          # DSH 容器：dsh web（node:22 + @deepseek-ai/dsh）
```

| 容器 | 端口 | 职责 |
|---|---|---|
| `TidyWork` | 8080（对外） | 方寸页面 + DSH 反向代理（HTTP/ws）+ token 解析 |
| `DSH` | 3080（仅内部） | DeepSeek Harness，由 TidyWork 经 `http://dsh:3080` 访问 |

## 数据放在宿主机

遵循「容器可丢弃、数据不丢」原则，**个人数据默认落在宿主机 `/Users/guosy/Documents/TidyWork/`**（可随时在 Finder 中查看/备份）：

```
/Users/guosy/Documents/TidyWork/
├── data/      # 方寸业务数据（待办/会议/记账/笔记）
└── dsh-log/   # DSH token 日志（DSH 写、TidyWork 读，自动解析认证）
```

**自定义数据位置**：复制 `docker/.env.example` 为 `docker/.env`，修改 `TIDYWORK_DATA_DIR` 为任意宿主机路径即可（无需改 yaml）；不设置时回退到上面的默认值。改后执行 `docker compose up -d` 重建容器生效。

- 重建/升级容器不影响数据
- 备份 = 拷贝这两个目录

## 常用运维

```bash
docker compose ps                 # 状态
docker compose logs -f tidywork   # TidyWork 日志
docker compose restart tidywork   # 重启 TidyWork
docker compose up -d --build dsh  # 仅升级 DSH（改 dsh/Dockerfile 后）
docker compose down               # 停止（数据保留在宿主机目录）
```

## 从当前 TidyWork 虚拟机迁移历史数据（可选）

历史数据位于 TidyWork 虚拟机后端数据目录（以下命令中的目录为虚拟机内**实际存储位置**，迁移用）：

```bash
# 1) 虚拟机内打包（目录为虚拟机实际路径）
orb run -m TidyWork bash -lc 'tar -C /home/guosy/fangcun -czf /tmp/tidywork-data.tgz data'

# 2) 拷出到宿主机并解压到 /Users/guosy/Documents/TidyWork/data/（目录需先存在）
mkdir -p /Users/guosy/Documents/TidyWork/data
scp -P 2200 guosy@192.168.139.29:/tmp/tidywork-data.tgz /tmp/ 2>/dev/null \
  || orb run -m TidyWork bash -lc 'cat /tmp/tidywork-data.tgz' > /tmp/tidywork-data.tgz
tar -C /Users/guosy/Documents/TidyWork/data -xzf /tmp/tidywork-data.tgz

# 3) 再启动容器（数据即出现在 TidyWork 中）
docker compose up -d --build
```

## 说明

- 端口 8080 被占用时，改 compose 中 `"8080:8080"` 为如 `"18080:8080"`
- 镜像架构自动匹配宿主（Apple Silicon → arm64）
- DSH 升级：改 `dsh/Dockerfile` 中的版本后 `docker compose up -d --build dsh`
- 频繁改前端：可在 compose 中追加 `- ./../backend/static:/app/static` 免重建
