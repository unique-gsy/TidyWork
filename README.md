# TidyWork AI 助手

基于 **DeepSeek Harness（DSH）** 的个人 AI 助手，容器化一键部署。**DSH 为宿主，TidyWork 以插件组合包形式二开**——不 fork、不改 DSH 源码，DSH 原生功能（对话、插件、自动化、设置、登录）完全保留。

- **AI 引擎**：DSH（DeepSeek Harness）web 模式，完整保留 DSH 全部原生能力
- **主界面**：打开 3080 默认进入 **TidyWork 工作台**——一屏可操作工作台：左栏今日日程时间轴（默认 09:00–18:00，遇超范围会议自动扩展到最早开始～最晚结束，会议块高按真实时长、重叠分栏、越界带角标、含当前时刻线）+ 可勾选待办清单（近日/今天/逾期/本周/全部 五视图、行内新增），右栏本周进度环 + 最近笔记 + 快捷操作，底部本周节奏七天点阵；右上「开始对话」直达 DSH 原生对话；侧边栏保持 DSH 原生（插件/自动化任务/工作区/更多/设置，一个不少）
- **二开方式**：`tidywork-plugin` 插件组合包（DSH 官方 `dsh.bundle.patch` 机制）装入 web profile——侧边栏「工作台」入口（order 最前）+ 3 个工作区入口（待办/会议/笔记）；面板切换走 DSH 原生 `ctx.layout.selectPanel`
- **工作区数据**：插件服务端半注册 `/tidywork-api` 路由（DSH webServer），数据以 JSON 落盘 DSH profile 数据目录，跨容器/会话存活
- **部署**：单容器（Docker / OrbStack），`docker-compose.yml` 一个文件分享给任何人

> v3.30 变更（安全与稳定性整改）：① `/tidywork-api` 全部写操作加来源校验（Host 白名单 + Origin 同源 + `Sec-Fetch-Site`，写请求必须 `application/json`，挡掉网页 CSRF）；② 错误统一分码（400/403/404/413/415/409/500），字段超长不再静默截断而是明确 400；③ `view` 口径重做（`all` 真正返回全部、`today/week/late/category` 统一按 due 归一日期算），客户端改为"一次拉全量 + 本地筛选"，切换视图不再闪重复行；④ 会议时间改结构化 `startTime/endTime`（仍兼容老 `time`+`duration`），状态按起止区间判定并每分钟重算；⑤ 笔记正文拆到 `notes/<id>.json`，`notes.json` 只留索引并自动迁移，列表不再把全文权重读进内存；⑥ 附件按引用回收 + 32 位 hex 文件名 + `private` 缓存；⑦ 新增 `/health`、`/export`（客户端顶栏「导出」）；⑧ 日志落 `logs/plugin.log` 并按 1MB 轮转；⑨ 客户端去掉 DOM 抓会话/"点两次才算删"的策略，改为 toast 撤销；⑩ 补齐键盘可达（焦点圈、按钮语义）、启动记住上次面板、英文 locale。
> v3.7 变更：已移除原 8080 FastAPI 桥接后端与静态前端、移除插件「工作看板」板块，仅保留 DSH web（3080）+ TidyWork 插件。
> v3.8 变更：工作台从「三卡概览 + 快捷入口条」重构为「一屏工作台」（时间轴 + 可勾选待办 + 进度环 + 本周节奏），见 `docs/workbench-redesign/`。
> v3.9 变更：按测试报告修复 8 项交互问题（时间轴自适应/块高按真实时长/加载失败警示与重试/笔记时间 ISO/零数据文案/空态去重/长标题单行/热区放大）+ 补当前时刻线与「近日」改名，见 `TidyWork-DSH-UI集成方案.md` §14。
> v3.18 变更：笔记默认改为「即时渲染」（Typora 式块级 render-as-you-type）——整篇按块渲染，点哪块哪块就地变成 Markdown 源码、离开即渲染回去，回车自动分块且列表续写（有序 +1 / 待办保 `[ ]`），`Cmd+B/I` 加粗斜体、`Esc` 提交，图片粘贴插到当前块，大纲跳转/勾选/内链在即时态沿用；源码仍是唯一真源，无 DOM↔Markdown 序列化，老的「编辑 / 分屏 / 预览」三态保留备用。
> v3.17 变更：笔记升级为 Markdown 富文本——正文按 Markdown 存（老笔记按纯文本渲染，零迁移），读态自研极简 GFM 渲染（标题/列表/任务清单/表格/代码块/图片/引用/粗斜体），写态为「编辑 / 分屏 / 预览」三态加工具栏；900ms 防抖自动保存 + localStorage 草稿恢复 + `rev` 冲突提示（409）；新增标签、置顶、搜索、大纲、版本历史（20 快照可回滚）、图片上传（正文只存 URL）、勾选项转待办、`todo:`/`meeting:` 内链。
> v3.10 变更：把「开始对话 / 新建待办 / 新建会议」三处重复入口收敛为顶栏一个「＋ 新建」下拉，删除右栏快捷操作卡，本周节奏点阵移入右栏竖排；「新建待办」改为切视图+滚动+聚焦+高亮。
> v3.11 变更：下拉的「新建待办 / 新建会议 / 新建笔记」不再打开插件表单，而是跳转 DSH 会话页并预填一句自然语言草稿（「帮我新建一个待办：」等），由助手在对话中完成创建。
> v3.12 变更：服务端写入改为「按资源串行 + 临时文件 rename 原子落盘」，勾选改为显式设值（撤销不再靠反向 toggle），会议卡新增「生成待办 →」把会后跟进落到待办清单，见 `TidyWork-DSH-UI集成方案.md` §17。
> v3.13 变更：会议卡支持「编辑」（服务端 PATCH 局部更新 + 前端回填弹窗）；待办面板加搜索框与五种排序（智能/截止日/优先级/标题/创建顺序）；`index.js` 统一请求日志与错误日志（`[tidywork] INFO/ERROR`，`docker compose logs` 可见），见 `TidyWork-DSH-UI集成方案.md` §18。
> v3.16 变更：顶栏「＋ 新建」下拉收成一个「＋ 新建工作项」按钮——点击不再开新会话，而是回到 TidyWork 工作区里「今天」的那个会话（没有工作区就建，该工作区下今天没有会话就建，之后当天反复点都复用同一个）；会话里由后台系统提示交代「用户会在这里新建/调整待办、会议、笔记」的约定与归类规则。下拉里的三个分项与「开始对话（DSH 原生）」一并删除，见 `TidyWork-DSH-UI集成方案.md` §22。
> v3.15 变更：工作台配色改为读 DSH 宿主设计 token（`--dsw-alias-*`），深浅主题共用一套色板——桌面端深色下不再「左黑右白」，卡片与底色保持层次；修侧栏品牌名用错变量导致深色下「Tidy」隐形；macOS 桌面端顶栏加窗口拖拽区（`data-window-drag`），下拉菜单显式 `no-drag`，见 `TidyWork-DSH-UI集成方案.md` §21。
> v3.14 变更：「＋ 新建」下拉的待办/会议/笔记改为点击即开新对话并预填工作区语境（"帮我新建一条待办（TidyWork 工作区）："等），插件同时向会话注入工作区系统提示，模型可直接把工作项写入数据；新增笔记写入通道，修标签页标题在后台标签页被节流后回滚的问题，见 `TidyWork-DSH-UI集成方案.md` §20。
> v3.13.1 变更：浏览器标签页换成 TidyWork（title + SVG favicon，与侧边栏品牌同源），DSH 路由切换后用 MutationObserver 守住不被改回。

```
浏览器 ──▶ DSH web (3080)：默认 TidyWork 一屏工作台 + DSH 原生侧边栏
              │
              ├─ 插件组合包 tidywork-plugin
              │   ├─ 客户端半：tidywork-home 主面板（默认打开）＋ 工作区 3 入口
              │   ├─ 服务端半：/tidywork-api 数据路由（JSON 落盘）
              │   └─ 面板切换：ctx.layout.selectPanel（DSH 原生机制）
              └── ~/.dsh（技能/工作区/profile，数据卷持久化）
```

## 快速开始

```bash
# 1. 克隆/拿到项目后：
cp .env.example .env

# 2. 配置 DeepSeek 凭据（二选一）：
#    A. 账号登录（推荐）：.env 里 DEEPSEEK_API_KEY 留空，启动后打开
#       http://localhost:3080（实际地址见 data/context/dsh-web-url.txt），在 Models 页登录
#       DeepSeek 账号即可，凭据自动保存在 data/dsh，无需粘贴 Key
#    B. API Key：在 .env 填入 DEEPSEEK_API_KEY（https://platform.deepseek.com 获取）

# 3. 构建并启动（自动把 tidywork-plugin 装入 DSH web profile）
docker compose up -d --build

# 4. 打开 http://localhost:3080（默认进入 TidyWork 工作台）
```

> 端口被占用时改 `.env` 里的 `DSH_WEB_PORT`（如 13080）。

## 目录结构

```
tidywork-assistant/
├── docker-compose.yml     # 一键部署（YAML 分享的核心）
├── Dockerfile             # 单容器镜像（node:22 + dsh + tidywork-plugin）
├── .env.example           # 环境配置模板（复制为 .env）
├── tidywork-plugin/       # ★ DSH 二开插件组合包
│   ├── package.json       #   dsh.bundle.patch → cordis.patch.yml；dsh.client → 客户端入口
│   ├── cordis.patch.yml   #   DSH profile 组合层的插入条目
│   ├── lib/index.js       #   服务端半：/tidywork-api 数据路由（webServer + JSON 落盘）
│   ├── lib/client.js      #   客户端半：侧边栏「工作区」3 入口 + 3 面板页面 + 一屏工作台（v3.9）
│   └── locale/zh.json     #   插件文案
├── scripts/
│   ├── entry.sh           # 容器入口（先装插件，再起 dsh web）
│   └── dsh-up.sh          # 一键启用（启动容器 + 等就绪 + 打印/打开带 token 地址）
├── docs/                  # 界面截图等文档
└── data/                  # 运行数据（不入 Git）
    ├── dsh/               # DSH 数据：workspace/sessions/skills/profile（重建容器不丢）
    └── context/           # 个人上下文：context.md（可选）+ dsh-web-url.txt（访问地址）
```

## 配置

| 变量 | 说明 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（方式 B；方式 A 账号登录则留空） | 空 |
| `DSH_WEB_PORT` | DSH Web 端口 | `3080` |
| `TIDYWORK_DATA_DIR` | 数据目录（可放其它路径） | `./data` |

## 访问鉴权（token）

DSH web 是官方原生鉴权：首次访问必须用 `data/context/dsh-web-url.txt` 里带 token 的完整地址；
浏览器打开过一次后会种下 30 天有效 cookie，之后直接访问 `http://localhost:3080` 即可。
容器重启后 token 会轮换（文件会自动更新），但已有 cookie 不受影响。

## 让助手了解你的背景

在 `data/context/context.md` 里写你的个人/工作信息（待办、偏好、项目背景…），
每次对话 DSH 都会自动参考。参考 `data/context/context.example.md` 的格式。

## 分享给其他人（YAML）

整个项目本身就是可分享单元，核心是根目录的 `docker-compose.yml`：

1. 把项目推到 GitHub（注意 `.gitignore` 已排除 `.env` 和 `data/`，密钥不会泄露）；
2. 对方 clone 后执行：
   ```bash
   cp .env.example .env   # 填自己的 DeepSeek Key
   docker compose up -d --build
   ```
3. 也可以把 `docker-compose.yml` 单独发给对方，放到项目根目录后执行同样的命令。

要求对方机器装有 Docker 或 OrbStack，且能访问 Docker Hub / npm（构建时拉取依赖）。

## API

- `GET  /tidywork-api/todos?view=all|today|week|done` — 待办列表
- `POST /tidywork-api/todos` — 新增待办；`PUT/DELETE /tidywork-api/todos/:id` — 修改/删除
- `GET  /tidywork-api/meetings?month=YYYY-MM` — 会议列表；`POST /tidywork-api/meetings` — 新增
- `GET  /tidywork-api/notes` — 笔记列表；`POST/PUT/DELETE /tidywork-api/notes[/:id]` — 增改删

> 以上接口由插件服务端半提供，均需 DSH web 的登录 cookie（同浏览器访问即有）。

## 排障

| 现象 | 处理 |
|---|---|
| 页面 401 / 打不开 | 用 data/context/dsh-web-url.txt 里带 token 的完整地址访问；或 `bash scripts/dsh-up.sh` 一键启动 |
| 容器没起来 | `docker compose ps` / `docker compose logs --tail=50 assistant` |
| 插件没生效 | 改代码后 `docker compose up -d --build`（entry.sh 会自动 diff 重装插件） |
| 想重置对话/数据 | 删除 `data/` 下对应目录（`dsh/` 或 `context/`），重建容器 |
