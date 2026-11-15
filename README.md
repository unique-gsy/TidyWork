# TidyWork

给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 加一个工作区插件：侧边栏多一个「TidyWork」入口，里面是**工作台 / 待办 / 会议 / 笔记**四块。

不是 fork，不改 DSH 源码——插件通过 DSH 官方的 `dsh plugin` 机制挂进 `web` profile，UI 与数据通道全部复用宿主能力，所以 DSH 升级了插件也能跟着用。

四块面板都能就地编辑：待办可勾选/改优先级/删除，会议可增删改（「编辑」回填表单后 PATCH 局部更新），待办面板带搜索框与五种排序（智能 / 截止日 / 优先级 / 标题 / 创建顺序），会议卡还能一键「生成待办 →」把会后跟进落到清单。

工作台顶栏只有一个「＋ 新建工作项」：点它不会每次开新会话，而是回到 TidyWork 工作区里**今天**那个会话（没工作区就建、今天没会话就建，当天反复点都复用同一个）。进去后直接用自然语言交代「明天下午三点跟产品过一版」即可，会话的系统提示已经交代好待办/会议/笔记的归类与写入约定。

## 部署分两步

先起 DSH，确认能用，再叠插件。这样的好处是：DSH 本身出问题时，能立刻分清是 DSH 的问题还是插件的问题。

### 前置

装好 Docker（macOS 用 [OrbStack](https://orbstack.dev) 或 Docker Desktop 都行），有网。

### 第一步：部署 DSH

```bash
git clone git@github.com:unique-gsy/TidyWork.git
cd TidyWork
cp .env.example .env          # 填 DEEPSEEK_API_KEY，或留空后登录账号（见下）
bash scripts/up-dsh.sh         # 等同 docker compose up -d --build
```

拿到带 token 的地址：

```bash
cat data/context/dsh-web-url.txt
```

打开它，就是纯 DSH：侧边栏有对话、插件、自动化任务，**没有** TidyWork 入口。

> token 每次容器重启会轮换，重新 `cat` 一次即可。同一浏览器带 token 打开过一次后，30 天内直接访问 `http://localhost:3080` 也行。

### 第二步：叠加插件

```bash
bash scripts/up-plugin.sh      # 等同 docker compose -f docker-compose.yml -f docker-compose.plugin.yml up -d
```

容器会重建一次（挂载 `plugin/`），入口脚本检测到插件后自动装进 DSH 的 web profile。刷新页面，侧边栏出现「TidyWork」，点进去就是工作台。

## 已经装了 DSH 桌面版？用 `desktop/`

对方装的是 **DeepSeek Harness 桌面客户端**、不想折腾 Docker 时，用仓库里的 `desktop/` 目录，或者一个压缩包。脚本按平台分开：

| 系统 | 安装 | 卸载 |
| --- | --- | --- |
| macOS | 双击 `desktop/macOS/安装.command` | `desktop/macOS/卸载.command` |
| Windows | 双击 `desktop/Windows/安装.bat` | `desktop/Windows/卸载.bat` |

1. 先打开一次 DSH 桌面版（生成 `~/.dsh/profiles/desktop` 配置目录），然后退出。
2. 双击上表对应文件（macOS 被系统拦「无法验证开发者」时右键 → 打开；Windows 被 SmartScreen 拦时点「更多信息 → 仍要运行」）。
   终端里也行：`sh desktop/macOS/install.sh`。
3. 脚本自动重启 DSH，侧边栏出现「工作台 / 待办 / 会议 / 笔记」即成功。

脚本只做四件事：把插件复制到 `~/.dsh/plugins/tidywork-plugin`、再放一份到 `~/.dsh/profiles/desktop/node_modules/@tidywork/dsh-plugin`、备份并原地登记 `~/.dsh/profiles/desktop/package.json`（`dependencies` + `dsh.profile.bundles`）、重启应用。不改 `DeepSeek Harness.app` 本体，不需要 Node/pnpm，不需要管理员权限。卸载后数据保留。

## 模型凭据

两选一：

- **API Key**：`.env` 里填 `DEEPSEEK_API_KEY=sk-xxx`，容器启动即生效。
- **账号登录**：`.env` 留空，打开页面后在 Models 页登录 DeepSeek 账号。凭据保存在 `data/dsh/.credentials.yaml`，容器重建不丢。

## 数据在哪

全部落在宿主机 `./data`，你可以直接 Finder 打开、备份、迁移：

```
data/dsh/        DSH 数据：workspace、会话、登录凭据、插件安装结果
data/context/    个人上下文（可选，放 context.md 助手每次回答都会参考）
data/dsh/profiles/web/tidywork/{todos,meetings,notes}.json   工作区业务数据
```

`data/` 和 `.env` 都写在 `.gitignore` 里，不会被提交。

## 改插件代码

不用重建镜像：

```bash
vim plugin/lib/client.js
docker restart tidywork-assistant     # 入口脚本会 diff 插件目录并自动重装
```

## 目录结构

```
docker-compose.yml             第一步：DSH
docker-compose.plugin.yml      第二步：插件 override
dsh/Dockerfile                 DSH 镜像（不含插件）
dsh/entry.sh                   容器入口：装插件（若有）→ 起 dsh web
plugin/                        插件本体（零依赖，纯 JS，挂载即用）
scripts/up-dsh.sh              一键起 DSH
scripts/up-plugin.sh           一键叠插件
docs/                          改版方案、功能测试点与测试报告、各版本截图
```

## 常见问题

**3080 被占用**：`.env` 里改 `DSH_WEB_PORT=3081`，重跑第一步。

**拉不到基础镜像 / npm 超时**：基础镜像走国内代理 `docker compose build --build-arg BASE_IMAGE=dockerproxy.net/library/node:22-bookworm-slim`；npm 慢可在 `dsh/Dockerfile` 的安装行加 `--registry=https://registry.npmmirror.com`。

**想退回纯 DSH**：`docker compose -f docker-compose.yml up -d`（去掉 override 再重建），插件文件留在 `data/dsh` 里不影响，需要时再加回来。

**想看插件请求日志**：`docker compose logs dsh | grep tidywork`——一行一个请求（`[tidywork] INFO  GET /tidywork-api/todos?view=all -> 200 2ms`），出错走 `[tidywork] ERROR` 并带堆栈；容器内另有一份完整副本在 `/dsh-web.log`。

**插件装了但侧边栏没入口**：`docker compose logs dsh | grep TidyWork` 看是"已安装"还是"安装失败"；失败会把 pnpm 日志打出来。
