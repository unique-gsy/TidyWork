# 个人工作台

单机单人工作记录应用：一句话记录会议与待办（模型解析 + 确认落库）、待办按项目管理、
周报生成（数据事实与模型摘要分离）、图片上传识别。技术基线见架构方案 V0.1：
FastAPI + Vue 3 + SQLite(WAL) + 本地图片目录，单机单进程，Docker 打包，
模型接入走 OpenAI 兼容接口（文本 / 多模态分槽配置）。

## 功能一览

- **记录**：输入一句话 → 模型解析 → 确认卡片（相对时间回显绝对日期、缺失字段标注
  「待补全」、原文保留）→ 确认后落库为会议或待办；多事项提示拆分；解析失败原文兜底
- **待办与项目**：待办按项目分组；项目可新建 / 归档 / 恢复（不提供删除）
- **会议**：列表与状态管理；时间待补全的会议补时间后自动转待开
- **周报**：手动触发，统计周一 00:00 至周日 24:00；本地数据事实与模型摘要分离，
  空数据不调模型不编造；草稿可编辑、覆盖重新生成需二次确认、可定稿、可导出 Markdown
- **图片识别**：PNG / JPG / WebP，单张 ≤10MB（可在设置调整）；存图与识别解耦，
  识别失败图片保留可重试；多模态不可用时明确降级提示，文本功能不受影响
- **设置**：文本槽 / 多模态槽分别配置接口地址、密钥、模型名、超时；密钥保存后仅回显
  掩码（`****` + 末 4 位），留空表示保持不变，日志全程脱敏；一键测试连接；手动备份

## 部署（Docker 主路径，五步）

前置：已安装 Docker 与 Docker Compose。

```bash
# 1. 进入仓库根目录（本 README 所在目录）
cd workbench

# 2. 构建镜像（两阶段：node 构建前端 → python 运行后端并托管静态资源）
docker compose build

# 3. 启动（数据持久化挂载在 ./data）
docker compose up -d

# 4. 健康检查
curl http://localhost:8080/api/health
# 期望返回 {"status":"ok", ...}

# 5. 浏览器访问
# http://localhost:8080
```

首次进入后在「设置」页填写模型接口（OpenAI 兼容 `/v1` 地址、API Key、模型名），
文本槽与多模态槽可指向不同服务。

## 部署（无 Docker 备选路径）

前置：Python ≥ 3.10（建议 3.11+）、Node.js ≥ 18（仅构建前端需要）。

```bash
cd workbench

# 一键脚本（Linux/macOS）：建 venv、装依赖、构建前端、启动
./backend/install.sh && ./backend/start.sh

# Windows
backend\install.bat && backend\start.bat
```

或手动执行：

```bash
cd frontend && npm install && npm run build && cd ..   # 产物在 frontend/dist
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8080
```

访问 http://localhost:8080 。

## 数据目录结构

默认数据目录为仓库下 `data/`（可用环境变量 `WORKBENCH_DATA` 覆盖；
Docker 部署时为容器内 `/data`，已挂载到宿主机 `./data`）：

```
data/
├── app.db          # SQLite 数据库（WAL 模式；7 张表：
│                   #   projects / todos / meetings / weekly_reports /
│                   #   source_records（原文兜底）/ images / settings）
├── app.db-wal      # WAL 日志（正常现象，随检查点合并）
├── images/         # 图片文件，按 年/月 分目录，文件名为内容 SHA256（自动去重）
│   └── 2026/09/
├── backups/        # 手动备份产物（zip：VACUUM INTO 快照 + images/ + VERSION）
├── logs/           # 应用日志（密钥已脱敏）
└── VERSION         # 数据结构版本号（迁移标记）
```

### 备份与恢复

- 备份：设置页「立即备份」或 `POST /api/backup`，产出 `backups/backup-<时间戳>.zip`
- 恢复：停止应用 → 将 zip 内 `app.db` 与 `images/` 解压覆盖回数据目录 → 启动
  （启动时自动做 `integrity_check`，失败会在日志给出恢复指引）

## 配置项

| 配置 | 位置 | 说明 |
| --- | --- | --- |
| 文本槽（解析/周报摘要） | 设置页 | base_url、api_key、model、timeout（默认 60s） |
| 多模态槽（图片识别） | 设置页 | 同上（timeout 默认 120s），可与文本槽不同服务 |
| 图片大小上限 | 设置页 | 默认 10MB |
| 时区 | 设置页 | 默认 Asia/Shanghai，影响周报周界与时间显示 |
| `WORKBENCH_DATA` | 环境变量 | 数据目录覆盖 |
| `WORKBENCH_STATIC` | 环境变量 | 前端静态资源目录覆盖（默认 frontend/dist） |
| `WORKBENCH_RETRY_DELAYS` | 环境变量 | 模型调用重试退避秒数（默认 `1,4`，最多重试 2 次） |

## 开发

```bash
cd workbench
python -m pytest tests/ -q          # 单元/集成测试（含 mock OpenAI 兼容服务）
python tests/e2e_check.py           # 端到端验证（真实 uvicorn 进程 + mock 模型服务）
```

测试与自测记录详见 [SELFTEST.md](SELFTEST.md)。

## 边界说明（按需求文档 V0.2）

- 不含：语音输入（A6 已拒绝）、离线提醒推送（A5）、自动备份（A9，默认手动）、多人账号体系
- 模型接口按 OpenAI 兼容协议接入，任何兼容服务（含内网网关）填入设置页即可，无需改代码
