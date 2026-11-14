# TidyWork × DSH 集成方案 v2.0（DSH 原生二开）

> 结论先行：**以 DSH 为宿主应用做原生二开**——写一个 TidyWork 插件组合包（cordis bundle），
> 通过 `dsh plugin add` 装进 DSH 的 profile。对话、插件、自动化任务、设置、登录、模型、
> Agent预设等 DSH 全部能力保持原生不变、一个不少；只**新增**工作区（看板/待办/会议/笔记）入口与页面。

## 一、为什么是"DSH 原生二开"（已验证事实）

| 事实 | 证据 |
|---|---|
| DSH 是 MIT 开源 | `@deepseek-ai/dsh` 的 package.json：`repository: github.com/deepseek-ai/deepseek-harness`，MIT |
| DSH 是 cordis 插件架构，全部功能是插件组合包 | node_modules 下 `@deepseek-ai/dsh-*` 数十个包；`dsh plugin add <pkg>` 管理 profile 插件 |
| 支持安装**本地**插件包 | `dsh plugin add` 转发 pnpm，支持 `file:` / `link:` / git / registry（plugin-manager 文档） |
| 前端有官方扩展点 | `sidebar.panellist` list 注册侧边栏入口（id/order/label + main keyed slot 面板组件）；`sidebar.brand.mark/name` 可替换品牌 |
| 数据存储有现成服务 | `dsh-storage-json`（JSON KV）、`dsh-session-persistence-jsonl` 等 |
| 插件组合包格式明确 | `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`；patch 内 `- insert:` 插件条目 |
| 网络可达 | github.com 200、registry.npmjs.org 200（本机验证） |

## 二、架构

```
浏览器 → dsh web（3080，DSH 原生应用，主体）
           ├─ DSH 原生能力（零改动）：
           │    新会话/对话、插件、自动化任务、更多、工作区 root、
           │    设置（通用/模型/内置插件/Agent预设）、意见反馈、登录、主题/折叠
           └─ TidyWork 插件组合包（本次二开新增）：
                ├─ 服务端 lib/index.js：工作区数据服务（看板/待办/会议/笔记 CRUD，JSON 持久化）
                └─ 客户端 lib/client.js：注册 sidebar.panellist「工作区」分组
                      ├─ AI 助手（= DSH 原生新会话）
                      ├─ 工作看板 / 待办事项 / 会议安排 / 笔记（新增页面）
                      └─ 数据存 profile 数据目录（$DSH_HOME/profiles/<name>/ 下）
```

- 不再需要 FastAPI 桥接 + headless（对话直接用 DSH 原生会话）；不再需要 iframe 嵌入。
- DSH 侧边栏**折叠为 56px 轨道是 DSH 原生能力**，天然满足"收起/放开"需求。
- 品牌可保留 deepseek HARNESS，也可通过 `sidebar.brand.mark/name` 换成 TidyWork（可选，默认保留原生）。

## 三、UI 形态（对应已确认的交互需求）

| 需求（用户原话） | v2.0 实现 |
|---|---|
| ① 侧边栏收起/放开 | DSH 原生折叠（展开 ↔ 56px 轨道 + tooltip），零开发 |
| ② 设置里完整 DSH 设置 + DSH 登录 | 左下「设置」= DSH 原生设置页（通用/模型/内置插件/Agent预设 + 打开配置文件）；「登录」= DSH 原生账号登录（截图底部菜单） |
| ③ 插件、自动化任务完全用 DSH UI | 左侧栏「插件」「自动化任务」直接是 DSH 原生页（截图所示），零改动 |
| ④ 左侧增加 DSH 功能 | 侧边栏新增「工作区」分组（AI 助手 / 看板 / 待办 / 会议 / 笔记），由插件注册 |

**侧边栏最终结构（DSH 原生 + 新增分组）：**
```
┌ deepseek HARNESS（品牌行，含折叠控件）  [☰]
├ 新会话          ← DSH 原生（= AI 助手）
├── 工作区（新增组，插件注册）──────────
│  ├ AI 助手        → DSH 原生新会话
│  ├ 工作看板        → 插件页面
│  ├ 待办事项        → 插件页面
│  ├ 会议安排        → 插件页面
│  └ 笔记            → 插件页面
├ 插件            ← DSH 原生
├ 自动化任务      ← DSH 原生
├ 更多            ← DSH 原生
├ 工作区 root     ← DSH 原生
└ 底部：设置 / 意见反馈 / 登录  ← DSH 原生
```

## 四、TidyWork 插件组合包结构

```
tidywork-plugin/
├── package.json          # name: @tidywork/plugin；dsh.bundle.patch → ./cordis.patch.yml
├── cordis.patch.yml      # - insert: [tidywork-server, tidywork-client]
├── lib/
│   ├── index.js          # 服务端：注册数据服务（board/todos/calendar/notes JSON CRUD）
│   └── client.js         # 客户端：注入 sidebar.panellist「工作区」入口 + 4 个页面组件
├── locale/
│   └── zh.json           # 界面文案
└── README.md
```

- 参照模板：官方实验性插件（`dsh-experimental-client-ui-voice-input`、`dsh-experimental-auto-review`）的 bundle 写法。
- 数据：工作区 4 视图用 `dsh-storage-json`（JSON KV）或直接读写 profile 数据目录下的 JSON 文件，持久化、重建容器不丢。

## 五、部署（容器，与现状兼容）

```
Dockerfile：COPY tidywork-plugin /app/plugins/tidywork-plugin
entry.sh：  dsh plugin add file:/app/plugins/tidywork-plugin  （profile 初始化后）
            dsh web --profile web                            （DSH 原生 + 工作区插件一起启动）
```

- 镜像仍为 node:22 + 全局 `@deepseek-ai/dsh@0.2.1-rc.5`；`data/dsh` 挂载保持不变（凭据/插件配置持久化）。
- 分享：GitHub 上放整个项目（Dockerfile + compose + plugin 目录），对方 `docker compose up -d --build` 即得"DSH 原生 + 工作区"。

## 六、验证方案

1. 本地容器内 `dsh plugin add file:...` → `dsh web` 启动，侧边栏出现「工作区」分组。
2. 看板/待办/会议/笔记 4 页可增删改查，重启容器数据保留。
3. 回归：新会话对话、插件页开关、自动化任务、设置页、登录（DeepSeek 账号）全部为 DSH 原生行为。
4. 侧边栏折叠（56px 轨道）原生可用。
5. `/api` 能力走 DSH 原生 JSON-RPC，不再依赖自定义 FastAPI。

## 七、工作量与风险

| 项 | 评估 |
|---|---|
| 工作量 | 中：写 1 个 bundle（服务端数据服务 + 4 个页面组件 + 入口注册），复用 DSH UI 组件库；不 fork、不构建 DSH 本体 |
| 风险 1：DSH rc 版 API 变动 | 锁定 0.2.1-rc.5；插件机制本身稳定 |
| 风险 2：client 插件 API 学习成本 | 官方实验插件 + `dsh-client-ui-sidebar` README 提供确切写法（`sidebar.panellist` / `main` slot） |
| 风险 3：品牌/样式 | 默认保留 DSH 原生品牌与主题；如需 TidyWork 品牌，走 `sidebar.brand` 替换（可选） |

## 八、实施顺序

1. 搭插件骨架（package.json + cordis.patch.yml + 空 server/client）→ 容器内安装验证入口出现。
2. 服务端数据服务（4 视图 JSON CRUD）。
3. 客户端 4 页面组件 + 入口注册（沿用原型 UI 视觉）。
4. 容器重建 → 全量验证（新增 + 原生回归）→ 交付。

---
*方案 v2.0 · 2026-11-03 · 待确认后实施（v1 iframe 方案已备份至 _backup/）*

---

## 九、v3.1 落地记录（2026-11-04 已实施并部署验证）

按插件组合包路线（DSH 零 fork）落地，容器 `tidywork-assistant`（3080=DSH web + 8080=TidyWork 独立工作台）：

### 1. 品牌替换（用户第 1 项需求）
- 注册 DSH 官方品牌槽位 `sidebar.brand.mark` / `sidebar.brand.name`，`priority:-100`（低于 DSH 官方 0，确定性遮蔽、无同优先级冲突报错）。
- mark = 渐变蓝底白色 T 标；name = "Tidy"（黑）+ "Work"（蓝），即 8080 的 TidyWork 文字 logo。

### 2. 新增四个功能页（用户第 2/3/4 项需求）
- `tidywork-home`（工作台主面板，order -10，默认首屏，含看板/待办/会议/笔记四 Tab 与「＋ 开始对话」回 DSH 原生会话）。
- `tidywork-todos / -meetings / -notes` 三个侧边栏入口 + 主面板，视觉与交互逻辑逐行复刻 8080 独立工作台（frontend/index.html）：
  - 待办：左 200px 智能视图（全部/今天/本周/已完成，计数口径与 8080 一致：全部=未完成+已完成、今天=due=today、本周=week+done）+ 分类栏 + 右统计卡（今日待办-danger/本周已完成-success/完成率-accent）+ 优先级边框勾选圈、线划完成态、优先级/分类/截止 chips、新增弹窗、新建分类。
  - 会议：左快速导航（今天·周X/明天·周X/月历视图/本月会议前 3 条）+ 右 2026-11 月历（周一开头、上月末灰格、当天 accent 圆、每格前 2 条 +N 更多）+ 日视图（返回月历/本周 7 日条带/60px 时间线 70px 竖线/已结束·进行中·未开始 badge/删除）+ 新建弹窗（标题/日期/时间/时长/地点/参会人数）。
  - 笔记：notes-layout 双栏（220px 列表 + 1fr 编辑器），新建笔记、title/preview 列表、22px 粗标题、最后编辑·字数 meta、删除(ghost)/保存(primary)。
- 保留工作看板（旧版 /tidywork-api/data?kind=board 通道 + localStorage 回退）。

### 3. 服务端（体验一致，能力一个不少）
- `lib/index.js` 重写为 REST 路由：`/tidywork-api/data`（kind=board 兼容）+ `/tidywork-api/todos[/:id]`（view=all/today/week/done/category + category 筛选、POST、PATCH done/title/priority/category/due、DELETE）+ `/meetings[/:id]`（month 按月、date+time 排序、POST、DELETE）+ `/notes[/:id]`（列表仅 id/title/preview/updatedAt、详情、POST、PUT 重算 preview/updatedAt="刚刚"、DELETE）。
- 首启无文件自动写入与 8080 `_WORKSPACE_DEFAULTS` 相同的种子数据（todos 4 / meetings 7 / notes 4），数据落 `$DSH_HOME/profiles/web/tidywork/*.json`（宿主 `data/dsh/profiles/web/tidywork/`），跨重建存活。
- DSH 原生后端（会话/插件/自动化任务等）零改动，回归通过。

### 4. 部署与验证（已全量通过）
- `docker compose up -d --build` 重建；entry.sh diff 检测插件变更自动 `dsh plugin --profile web remove/add file:` 重装（日志 `tidywork plugin updated`）。
- 容器内 curl 验证：todos/meetings/notes 全路由 GET/POST/PATCH/DELETE 与种子数据正确，落盘持久化。
- 浏览器实测（DSH web 3080）：侧边栏 TidyWork 品牌 + 工作台/插件/自动化任务（原生）+ 工作看板/待办/会议/笔记（插件）全量入口；默认打开工作台；待办统计卡 4/1/3/1、25%，会议月历 7 场分布、笔记双栏编辑均与 8080 一致；控制台无品牌槽位冲突、无 404。

### 5. 访问方式
- DSH web：`data/context/dsh-web-url.txt`（`http://localhost:3080/?token=…`，容器重启 token 轮换，重启后重读该文件）。
- 8080 独立工作台：`http://localhost:8080`。

### 6. 后续升级 DSH 的改动面
- 插件组合包路线：升级 = 替换 DSH 镜像，`/app/tidywork-plugin` 与 entry.sh 自动 diff 重装；UI 变更只改 `tidywork-plugin/lib/*`，不触 DSH 源码。

### 7. v3.2 落地记录（侧边栏分组 + 分隔线）
- 需求：3080 左侧菜单"先是 TidyWork 功能、长线划分、再接 DSH 本身功能"（用户示意图：TidyWork 功能置顶 → 分隔线 → 插件/自动化任务 → 会话）。
- 实现（仅改 `tidywork-plugin/lib/client.js`，DSH 零改动）：
  - **分组置顶**：5 个 TidyWork 入口 order 调为 -10/-9/-8/-7/-6（低于官方 插件=0 / 自动化任务=10），排序后为 工作台·工作看板·待办·会议·笔记 → 插件·自动化任务 → 更多。源码依据：`ui-sidebar/src/client/index.ts` `syncPanels()` 按 `options.order ?? 0` 升序排序（`sidebar.panellist` 为平铺列表，无原生分组/分隔线能力）。
  - **长分隔线**：运行时 DOM 为 `nav > button.panelRow`（按钮直接是 nav 子元素，无包裹层；与源码 JSX 结构不同，以实测为准）；`sidebar.brand.mark` 组件内渲染 `<style>` 注入全局 CSS：`nav[aria-label] > button[aria-label="插件"]{ margin-top:12px; border-top:1px solid var(--dsw-alias-border-l2) }`，即第一个 DSH 原生入口上方一条 1px 主题色分隔线。
  - **坑（已修）**：① 初次用 `React.Fragment` 输出导致槽位崩溃（`ReferenceError: React is not defined`，factory 内未绑定 `React` 标识符）→ 改为单元素 `span` 包裹 logo + `<style>`；② 注入 CSS 选择器最初按源码 JSX 结构（`div:has(...)`）写，运行时 DOM 无 div 包裹层 → 改为直接匹配 `> button[aria-label=插件]`；③ 分隔线颜色用 `--dsw-alias-border-l1`（rgba 0.04）太淡 → 换官方组件同款 `--dsw-alias-border-l2`（rgba 0.1）。
- 验证（浏览器实测 3080）：侧边栏顺序 = 工作台/工作看板/待办/会议/笔记/插件/自动化任务/更多 ✅；插件按钮 computed `border-top:1px solid rgba(0,0,0,.1)`、`margin-top:12px` ✅；注入 style 在 DOM（1 个）✅；brand.mark 正常渲染（无槽位崩溃，控制台 0 错误）✅；DSH 原生入口与全部既有功能回归正常 ✅。
- 说明：分隔线锚定"插件"（DSH `FIXED_PANEL_ID='plugins'`，永不卸载/收起），对 unpin 到"更多"的入口免疫；收起态（窄轨道）同样显示分隔线（图标列分组），如需仅展开态显示可再按需调整。

### 8. v3.3 落地记录（待办页 UI 与交互优化）
- 需求：保持现有风格一致的前提下，优化 3080 待办页的 UI 与交互逻辑。
- 交互逻辑（P0）：
  - **完成可逆**：勾选圈完成/取消完成双向切换（PATCH done 布尔），完成时 toast 带「撤销」按钮可立即恢复。
  - **任务编辑**：行尾新增「编辑」，打开预填弹窗（标题/优先级/分类/截止），保存 PATCH 更新，toast「待办已更新」。
  - **分类一致性**：侧边栏分类区 = 固定三分类 + 数据中出现过的其他分类（自动推导），「新建分类/自定义分类」创建后自动出现在分类栏。
  - **行内删除二次确认**：点「删除」→ 变红色「确认删除？」（3 秒未确认自动恢复）→ 再点执行；弃用原生 confirm。
- UI 细节（P1）：未完成按 优先级+截止临近 排序、已完成沉底；行 hover 浅灰反馈；空状态升级（图标+引导文案+「+新增」按钮）；完成率统计卡加主题色进度条。
- 未做（取舍）：搜索/批量/子任务/提醒（需新数据模型，超出"优化"范畴）；统计口径（今日待办/本周已完成/完成率）与 8080 原生一致，不改。
- 验证（浏览器实测 3080）：新增（含自定义分类）→ 完成+撤销 → 取消完成 → 编辑保存 → 删除二次确认 → 排序（高优先/临近截止在前）全链路通过；统计计数与分类栏随数据动态更新；测试数据已清理、种子数据已还原（容器 todos.json 4 条）；控制台无报错。

### 9. v3.4 落地记录（+新增跳会话 + TidyWork 专属工作区）
- 需求：待办页「+新增」跳转到会话页面，通过自然语言新增待办；该会话工作区独属于 TidyWork（与个人会话隔离）。主路线仍为零 fork 插件 bundle。
- 方案（三通道，全部在插件内完成）：
  1. **TidyWork 专属工作区**：服务端 `apply()` 中先 `mkdir(dataRoot()/workspace, {recursive:true})` 再 `ctx.workspaceRegistry.create(wsDir, "TidyWork")`（幂等：已存在复用且不改标题；create 校验目录必须存在，目录创建仅在 `initializeDefault` 内，故必须显式 mkdir）。注册落盘 `/root/.dsh/storages/workspace.json`，会话树出现独立 TidyWork 分组，会话目录 `/root/.dsh/sessions/--root-.dsh-profiles-web-tidywork-workspace--/`。
  2. **自然语言落库（agent 工具）**：`ctx.tools.register()` 手工构造 ToolDefinition（不 import @deepseek-ai/dsh-tools）：name `tidywork_add_todo`，parameters 为 JSON Schema（title 必填，priority high/mid/low 默认 mid，category 默认 工作，due 默认 today），output.schema 合法对象 + render 返回 `{type:'text', text}` 文本块；execute 写 todos.json（与 POST /tidywork-api/todos 同语义），`ctx.effect` 卸载。会话中 agent 自动识别并调用。
  3. **跳转**：客户端待办页 `openAdd` 改为 `document.querySelector('button[aria-label="新建会话"]').click()`（DSH 顶部新建会话按钮，纯 SPA 无深链，模拟点击是唯一跳转姿势；按钮不存在时回退原弹窗）。工作区由用户在建会话面板首次选择 TidyWork 后 DSH 记忆，之后直达。
- 关键坑（均已修）：
  - **`ctx.ln` 是错误注入名**：WorkspaceRegistry 运行时注册名为 `workspaceRegistry`（`super(ctx,'workspaceRegistry')`，`declare module` 的 `Context.ln` 仅为类型/别名）。inject 写 `"ln"` 导致 cordis 找不到服务、插件激活失败、apply 不执行、/tidywork-api 全线 404（浏览器 UI 正常误导排查）。改为 inject `["webServer","tools","workspaceRegistry"]`。
  - **宿主日志不透传插件 console**：排障时给 apply 开头写 `apply-ran.txt`、错误写 `ws-error.log` 落盘定位。
  - **create 要求目录已存在**：`create()` 内 `realpathNormalize + stat().isDirectory()`，目录不存在必抛错；须先 mkdir。
- 验证（浏览器实测 3080，重启后复验）：
  - TidyWork 分组出现在会话树，会话隔离于未分组（个人）会话；重启后工作区持久，无 root/测试残留 ✅
  - 待办页「+新增」→ 进入 DSH 新建会话 composer，工作区默认/可选 TidyWork，新会话挂 TidyWork 分组 ✅
  - 输入「请帮我新增一条待办：周五前完成周报，优先级为高」→ agent 思考后调用 `tidywork_add_todo` → 落库 todos.json（周五前完成周报 / high / 工作 / 2026-11-06 / done=false）→ 待办页出现该任务（全部待办 5、分类 工作 1、统计联动）✅
  - 测试遗留清理：root 工作区（/root）注册与两个测试会话目录+projcache 已删，DSH 自带会话（未分组 Greeting 等）与 TidyWork 验证会话保留 ✅

### 9.1 v3.4 会议通道（会议「+新建」跳会话 + 自然语言新增会议）
- 需求：会议页「+新建」同样跳转新会话，自然语言新增会议，会话归档到 TidyWork 分组。
- 实现：客户端会议 `openAdd` 与待办一致（模拟点击 DSH「新建会话」按钮，按钮缺失回退原弹窗）；服务端新增 agent 工具 `tidywork_add_meeting`（title/date 必填，time 默认 09:00、duration 默认 "09:00 - 10:00"、location 默认 线上会议、participants 默认 1），与 POST /tidywork-api/meetings 同存储语义。
- 验证（浏览器实测 3080）：会议页「+新建」→ 进入 composer（工作区 TidyWork，会话挂 TidyWork 分组）；输入「帮我新建一场会议：产品评审会，11月8日 14:00，地点会议室A，3人参会」→ agent 调用 `tidywork_add_meeting` → 落库 meetings.json（m88d66c18 产品评审会/2026-11-08/14:00/会议室A/3）→ 会议页月历 11 月 8 日显示「14:00 产品评审会」✅

### 10. v3.5 落地记录（新增跳转：固定命名会话并复用）
- 需求：①新建待办：工作区无 TidyWork 则新建；无「新建待办事项」命名会话则新建并命名，后续所有自然语言新增待办全部复用该会话。②新建会议：同理，会话命名「新建会议管理」。保持零 fork 插件 bundle 主路线。
- 方案（纯客户端，仅改 `lib/client.js`，服务端零改动）：
  - **固定命名 = 首条消息 AI 摘要**：DSH 无原生会话重命名入口（grep rename/retitle/setTitle 无命中；悬停仅归档/置顶；SessionHeader 无 title 字段，标题由 AI 从首条消息自动摘要）。故首次新建会话后自动向 composer 发送标题锚定消息（待办=`新建待办事项`、会议=`新建会议管理`），标题即按该消息生成（实测精确生成）。
  - **复用 = localStorage 记会话 id + DOM 定位点击**：模块级 `SESSION_KEYS={todo:'tidywork.todoSessionId', meeting:'tidywork.meetingSessionId'}`、`SESSION_NAMES`；`openTidySession(kind, fallback)` 三阶段：①有记录 → `div[data-row-key="session:<sid>"]` 点击复用（行缺失先展开侧边栏+展开折叠区）；②无记录 → 收集发送前会话 key 集合 → 模拟点击 `button[aria-label="新建会话"]` → 等 composer → `sendToComposer(锚定文本)`；③轮询（60×500ms）找「发送后新增 + 标题含名称」的会话行 → 记 id → 完成。待办/会议 `openAdd` 接入（按钮缺失回退原弹窗）。
  - **composer 输入通道（关键）**：DSH composer 为 contenteditable div（aria-label 含「描述你想要构建」）。实测 `textContent 赋值+input`、`execCommand('insertText')`、`ClipboardEvent('paste')` 均无效（React/ProseMirror 类编辑器不响应合成事件）；`InputEvent('beforeinput',{inputType:'insertText',data})` 有效。注意：编辑器异步渲染，dispatch 后**不能立即校验文本**（会误判失败而双重插入），改为 dispatch 后 setTimeout 500ms 再点「发送消息」按钮。
  - **误匹配防护**：before 集合必须在**点击新建按钮之前**收集（点击后新会话行已入树、且点击后树收起）；匹配条件 = `key ∉ before` 且标题含会话名，防止把既有同名/相似标题会话（如残留「新建待办事项 paste测试」）误记为专用会话。
  - **侧边栏折叠**：TidyWork 分组会话多时折叠为「展开其余 N 个会话」，折叠区行不在 DOM → 复用/轮询前先 `ensureSidebarOpen()` + `expandCollapsedSessions()`。
- 验证（浏览器实测 3080）：
  - 待办首次：清 localStorage → 待办页「+新增」→ 自动新建会话并发送「新建待办事项」→ 标题生成「新建待办事项」→ localStorage 记录 `session-697dc2b7-…` ✅；二次「+新增」→ 直接打开该会话（无新会话、sid 不变）✅；折叠态复用 ✅；会话内输入「帮我新增一条待办：明天提交季度总结，优先级高」→ agent 调 `tidywork_add_todo` → 落库（提交季度总结/high/tomorrow）→ 待办页出现 ✅
  - 会议首次：会议页「+新建」→ 新建「新建会议管理」会话（`session-807a7c13-…`）标题精确生成 ✅；二次复用（含折叠态）✅；自然语言「帮我新建一个会议：季度复盘会，本周五下午3点」→ 落库 meetings.json（季度复盘会/2026-11-06）✅
  - 清理：测试污染的「paste测试」待办已删（DELETE）；污染会话 eca21bc8（「新建待办事项 paste测试」，由验证期误发消息产生）已归档。
- 遗留说明：验证期产生的重复「新建待办事项」会话（78e32204-…，无 localStorage 记录）未归档，不影响功能，用户可自行悬停归档；DSH 标题由 AI 摘要生成，锚定消息为「新建待办事项/新建会议管理」时实测标题精确匹配，若未来模型摘要行为变化导致标题偏离，复用仍按 localStorage id 定位不受影响（仅树中显示名不同）。

### 11. v3.6 落地记录（工作台概览化 + 提取工作看板）
- 需求：①把「工作看板」从工作台内提取为独立板块（工作台不再重复内嵌看板 Tab），同时保留工作台；②优化工作台的展示逻辑（不再做 4 Tab 容器，改为真正的聚合概览首页）。
- 实现（仅改 `tidywork-plugin/lib/client.js`，服务端/DSH 零改动）：
  - **工作台 = 概览首页**：HomePage 从「4 Tab 容器」重构为概览页——顶部品牌行（含「＋ 开始对话」回 DSH 原生会话）+ 当日日期问候（如「11月4日 周三 · 今天 1 条待办 · 1 场会议」）+ 四张聚合卡片 + 底部快捷入口。
  - **四张卡片**（并行拉取 `/tidywork-api`，进入面板实时刷新；单接口失败不影响其他卡片）：
    1. 今日待办：今日数（danger 大数字）+ 本周条数 + 完成率进度条；
    2. 今日会议：当天按时间排序的会议列表（时间/标题/人数，最多 3 条）+ 本月场数；
    3. 最近笔记：最新 3 条（标题/预览/更新时间）；
    4. 工作看板：待办/进行中/已完成三列计数（board.json 旧通道数据）。
  - **跳转**：卡片任意位置或「查看全部 →」点击 → `ctx.layout.selectPanel(id)` 切到对应独立面板（main slot inject 新增 `openPanel`）；底部快捷入口四按钮（工作看板/待办事项/会议安排/笔记）同源跳转。
  - **看板提取**：工作台不再内嵌「工作看板」Tab；侧边栏 `tidywork-board`（order -9）独立入口保留，看板功能与旧版通道不变。
- 验证（浏览器实测 3080，重建容器后）：
  - 默认打开工作台 = 概览页：11月4日 周三、今日 1 条待办 · 1 场会议 ✅
  - 卡片数据与 API 一致：今日待办 1（本周 4、完成率 57%）、今日会议 14:00 技术评审（7 人）、最近笔记 3 条、看板 2/0/0 ✅
  - 卡片点击跳转：今日待办卡 → 待办页（全部 7/今天 1/本周 8/已完成 4、完成率 57%）；今日会议卡 → 会议页月历（11 月 9 场分布正确）✅
  - 侧边栏「工作看板」独立入口 → 看板页（任务列表 + 开始/完成/删除）✅；工作台内已无看板 Tab ✅
  - 底部快捷入口「笔记」→ 笔记页双栏 ✅；「＋ 开始对话」→ DSH 原生会话 ✅
  - 控制台 0 报错、无 404；侧边栏顺序/品牌/分隔线回归正常 ✅
  - 清理：board.json 验证期测试任务已清空（回空态），概览截图存档 `docs/tidywork-home-v36.png` ✅

### 12. v3.7 落地记录（删除工作看板 + 移除 8080 独立 Web UI）
- 需求：①删除 DSH 插件里的「工作看板」（页面与后端通道），②删除 8080 那一整套（进程、代码及所有东西），只保留 DSH 插件（3080）。看板数据一并删除。
- 删除范围与改动：
  - **插件看板（client.js / index.js / locale）**：
    - 删除 `BoardPage` 组件、`loadBoardData` / `saveBoardData`（localStorage 回退同步移除）；
    - 删除侧边栏 `tidywork-board` 入口（原 order -9）、`Icons.board`、`PANELS` 中的 board 项、`dict`/`pages` 的 board 映射；余下入口 order 收拢为 -10..-7；
    - 工作台概览：删除「工作看板」聚合卡片与「工作看板」快捷入口 → 概览变为三卡（今日待办/今日会议/最近笔记）、快捷入口三按钮；
    - 服务端：删除 `/tidywork-api/data?kind=board` 通道（GET/POST/PUT）及注释，`handle()` 其余分支不变（未知路径仍走 404 兜底）；
    - `locale/zh.json`：删除 `"board": "工作看板"` 键，meta.description 同步更新；
    - 数据：删除 `data/dsh/profiles/web/tidywork/board.json`。
  - **8080 FastAPI 全套**：
    - 删除目录 `backend/`（main.py / dsh.py / dsh_bridge.py）、`frontend/`（index.html 独立工作台）、`data/app/`（8080 业务数据）与 `docs/8080-桥接技术方案.md`；
    - `Dockerfile`：移除 fastapi/uvicorn/pydantic 安装、`COPY backend`/`COPY frontend`、`EXPOSE 8080` → `EXPOSE 3080`；
    - `scripts/entry.sh`：移除末尾 `uvicorn main:app --port 8080`（原本是容器主进程），改为 `wait $DSH_PID`——容器生命周期跟随 dsh web，web 退出则容器退出并由 `restart: unless-stopped` 拉起；
    - `docker-compose.yml`：移除 8080 端口映射、`DATA_DIR=/tidywork-data`、`/tidywork-data` 卷、`DSH_HEADLESS_TIMEOUT`；仅保留 3080 映射 + `data/dsh`、`data/context` 两卷；
    - `.env.example`：移除 `PORT`、`DSH_HEADLESS_TIMEOUT`；
    - `README.md`：整篇按"仅 3080 + 插件"重写（架构图、目录结构、配置表、API、排障）。
- 验证（重建镜像并启动后实测）：
  - 容器只映射 `3080`（`docker compose ps` 无 8080）✅；`/app` 仅剩 `entry.sh` + `tidywork-plugin`（backend/frontend 不存在）✅
  - `curl localhost:8080` → 连接失败（端口已关闭）✅；`curl localhost:3080` 无 token → 401、带 token → 303 ✅
  - `GET /tidywork-api/data?kind=board`（带登录 cookie）→ `404 {"ok":false,"error":"not found"}`（通道彻底移除）✅；对照 `GET /tidywork-api/todos?view=today` → 200 ✅
  - 浏览器实测：侧边栏仅 工作台/待办/会议/笔记（无「工作看板」）✅；工作台概览三卡（今日待办 1/本周 4/57%、今日会议 14:00 产品评审会 3 人、最近笔记 3 条）+ 快捷入口三按钮（待办事项/会议安排/笔记）✅
  - 待办页（全部 7/今天 1/本周 8/已完成 4、分类与完成率正常）、会议页（月历/本月 9 场）、笔记页（双栏 4 篇）全部可用 ✅；控制台 0 报错 ✅
  - 截图存档 `docs/tidywork-home-v37.png` ✅

### 13. v3.8 落地记录（工作台一屏化）

- 背景：v3.7 工作台是「三卡 + 三个空快捷条 + 下半屏留白」，信息稀、无操作能力、无"今天"上下文。用户要求先出方案与可交互原型再实施，验收原话「你的UI没有问题，可以实施了」。
- 方案与原型（已交付并验收，保留在仓库内备查）：
  - `tidywork-assistant/docs/workbench-redesign/工作台改版方案.md`：7 条现状诊断、外部 UI 参考出处、改后信息架构、6 个模块设计、交互清单、视觉 token、实施计划。
  - `tidywork-assistant/docs/workbench-redesign/工作台改版原型.html`：单文件自包含原型，真实数据内联，5 个待办视图 / 时间轴 / 进度环 / 周节奏 / 笔记浮层 / toast 全部可点。
- 代码改动（仅 `tidywork-plugin/lib/client.js` 的 HomePage 段，其余面板不动）：
  - 删除 `QUICK_LINKS`、`OverviewCard`，HomePage 重写为「一屏工作台」，新增 `HIcon / HCard / HCardHead / HLink` 四个局部组件与日期工具 `pad2 / ymd / parseYmd / shiftYmd / dayDiff / weekStartOf / hm`。
  - 左栏：①「今日日程」09:00–18:00 时间轴（44px 刻度列 + 内容列，逐小时虚线，会议渲染为可展开色块，空档标「可专注 09:00–14:00」）；②「待办」清单，五个视图 近期/今天/逾期/本周/全部（各自带计数），行 = 可勾选方框 + 优先级色点 + 分类 + 到期文案（逾期红字）+「编辑」跳待办面板，底部行内输入回车即新增。
  - 右栏：④「本周进度」SVG 圆环（r=44 / stroke 10 / dashoffset 过渡），四行指标（已完成/全部、今天待办、逾期、本周会议）+ 一句话结论；⑤「最近笔记」4 条跳笔记面板；⑥「快捷操作」2×2（新建待办聚焦输入框 / 新建会议 / 新建笔记 / 开始对话）。
  - 底部：③「本周节奏」7 列点阵（实心=已完成、空心=未完成、红边=逾期），今天列高亮。
  - 交互：勾选走 `PATCH /tidywork-api/todos/:id {done}` + 本地乐观更新 + toast（带撤销）；新增走 `POST /tidywork-api/todos` + 本地追加。
  - 口径：`due` 归一为具体日期（today/tomorrow/yesterday/week/日期），"逾期"= 未完成且到期日早于今天；窄屏阈值 `window.innerWidth < 780` 切单列（`resize` 监听）。
- 实施中修掉的两个 bug：
  - `dayDiff(d, today)` 方向写反，导致"明天到期"显示成"昨天"；
  - 周区间副标题里 `getMonth() + 1` 在字符串链中被拼成 `101月`（补括号）。
- 验证（镜像重建 + 容器启动后浏览器实测）：
  - `docker compose ps` 仅 3080 ✅；日志 `tidywork plugin updated` + `dsh web ready` ✅；控制台 0 报错 ✅
  - 两栏在 789×811 视口正确排布（左栏时间轴 + 待办，右栏进度环 + 笔记 + 快捷，底部本周节奏）✅
  - 勾选「周五前完成周报」：未完成 3→2、逾期 1→0、进度 57%→71%（4/7→5/7）即时联动，写盘成功 ✅
  - 行内新增「TEMP 冒烟待办」：全部 7→8、"今天待办"1→2、进度 5/8=63%，随后清理 ✅（测试数据已还原）
  - 「逾期」tab 精确过滤到 1 条；会议块点击就地展开时长与提示 ✅
  - 截图存档 `docs/tidywork-home-v38.png`（首屏）、`docs/tidywork-home-v38-full.png`（含底部周节奏）✅

### 14. v3.9 落地记录（工作台交互修复）

- 背景：v3.8 一屏工作台交付后，用户在实际使用中发现多处交互问题。按要求走「先出测试点 → 实测 → 出修复方案 → 经批准再改代码」，批准原话「全部修改」（含两项待确认项）。
- 测试：`docs/workbench-redesign/工作台功能测试点.md`（10 组 38 项，P0 准入 / P1 体验阻断 / P2 可用性瑕疵）+ `工作台功能测试报告.md`。实测 30 项通过、8 项失败、2 项未覆盖，证据截图 5 张存于 `docs/workbench-redesign/screenshots/`。
- 8 项问题与根因：
  - **P1-1** 时间轴写死 09:00–18:00，超范围会议被钳到边界 → 08:00 的块盖住 09:30 会议标题、19:00 的块溢出到待办卡；
  - **P1-2** 会议块高度写死 46px，1 小时与 3 小时一样高，时长不可读；
  - **P1-3** 接口 500 被吞成空数据，页面显示「0 条 / 0%」且无任何提示；
  - **P2-4** 笔记时间存的是展示串（"今天 11:30"），跨天后失效；
  - **P2-5** 0 条待办时结论句写成「待办全部完成」；
  - **P2-6** 无会议时顶部「今天没有安排」与中部「可专注 09:00–18:00」重复；
  - **P2-7** 长标题换行把行高从 28px 撑到 50px；
  - **P2-8** 勾选框 18×18、toast 撤销热区 26×18.5，易点不中。
- 代码改动（`tidywork-plugin/lib/client.js` 18 处 + `lib/index.js` 6 处，仍零 fork、不引依赖）：
  1. 新增 `evBlocks` 派生数据：解析 `time + duration` 得 `start/end`，`lo = min(09:00, 最早开始)`、`hi = max(18:00, 最晚结束)`，重叠块按簇分 lane；
  2. `renderTimeline` 重写：刻度、空档、块全部按 `lo`/`hi` 换算；块高 `max(26, (end-start)*32-4)`；越界块加「早于视图 / 晚于视图」角标；重叠块左右分栏（`calc(lane/laneN*100%)`）；卡头 meta 改显真实范围 + 「含 N 场越界」；
  3. 新增「当前时刻」游标（1.5px 线 + 端点，仅当 `ymd(now)===today` 且在范围内）；
  4. 空档块文字在 `h2>=40` 时顶部对齐，避免在大空档里漂到中部；
  5. 全天无会议时不再渲染整段空档块，只留一条居中空态；
  6. `reload` 重写为三路结果收集：任一路失败则保留上次成功数据并置 `err`，页面顶部出警示条（`#fff5f3` 底 / `#b3271b` 字）+「重试」按钮，错误原文收进 `title`；
  7. 列表空态区分「加载失败」与「本来为空」两种；
  8. 0 条待办结论句改为「还没有待办，先加一条吧。」；
  9. 新增 `relTime()`：ISO 时间 → 今天/昨天/前天/M月D日 + HH:MM，非 ISO 旧数据原样透出；`index.js` 新增 `localStamp()`（本地 `YYYY-MM-DDTHH:mm:ss`），种子数据、新建、更新笔记统一写 ISO；
  10. 长标题 `nowrap + minWidth:0` 单行省略；
  11. 勾选框热区 34×34（视觉 18×18 不变）；toast 撤销改为 `<button>` + 内边距，热区 50×30，带动作的 toast 停留从 2.6s 延到 5s；
  12. 待办面板「本周」改名「近日」（该视图实为 today+tomorrow，与工作台「本周=本周区间」区分）；
  13. 数据迁移：`notes.json` 4 条 `updatedAt` 由展示串迁为本地 ISO。
- 复测（镜像重建 + `docker compose up -d` 后逐项实测）：
  - 注入 08:00 / 19:00 会议：刻度自适应 08:00–20:00（13 个），三块 top 197/245/549、高 26/28/28，底部 577 < 容器 579，无重叠无溢出；「早于视图 / 晚于视图」角标与 meta「08:00 – 20:00 · 含 2 场越界」正确；
  - 09:30–10:30 团队周会块高 28px（修复前 46px）；
  - 写坏 `todos.json` 造 500：顶部出现「待办数据加载失败，当前显示上一次成功的数据。」+「重试」，待办卡显示「待办数据未加载，请点上方「重试」」；修好文件后点「重试」立即恢复 7 条、警示条消失；
  - 清空待办：「还没有待办，先加一条吧。」+ 0% 环 + 0 / 0；
  - 清空会议：单条「今天没有会议，整段可专注 09:00 – 18:00」，重复提示已消除；
  - 笔记时间：「昨天 11:30 / 前天 18:00 / 11月1日 09:00 / 10月30日 15:20」；
  - 长标题单行省略；勾选框 34×34；撤销按钮 50×30，4.2s 时仍可点；
  - 待办面板显示「近期 2 今天 1 逾期 0 本周 4 全部 7」；
  - 当前时刻线：14:26 落在 14:00–15:00 之间；
  - 截图：`docs/tidywork-home-v39.png`（首屏）+ `docs/workbench-redesign/screenshots/fix-*.png`（5 张复测证据）。
- 数据还原：测试注入的 2 场会议、长标题待办、清空/写坏的 `todos.json` 全部还原（7 条待办 / 9 场会议 / 4 篇笔记），仅保留笔记 `updatedAt` 的 ISO 迁移。
- 已知遗留（非本次引入）：容器 restart 后首屏偶发 `ERR_INCOMPLETE_CHUNKED_ENCODING` 与 `remote.mux` 握手失败，刷新即恢复。

### 15. v3.10 落地记录（新建入口收敛）

- 背景：用户在实际使用中反馈三处入口重复——顶栏「＋ 开始对话」、标题行「＋ 新建待办 / 新建会议」、右栏「快捷操作」四宫格，同一动作散在三处；且点「新建待办」看不出任何反应。
- 根因：v3.8 把快捷操作当"兜底入口"，而顶栏与标题行又各自放了一份；「新建待办」只调了 `document.getElementById("tw-home-add").focus()`，输入框位于待办卡底部、常常在视口外，聚焦后既没滚动也没视觉提示，等同于无响应。
- 改动（`tidywork-plugin/lib/client.js`，仅 HomePage 段）：
  1. 顶栏只留一个主按钮「＋ 新建」，点开下拉：新建待办 / 新建会议 / 新建笔记 → 分隔线 → 开始对话（右侧标「DSH 原生」）。点外部或按 Esc 关闭（`mousedown` + `keydown` 监听，随菜单开关挂载/卸载）。
  2. 删除标题行右侧的「＋ 新建待办 / 新建会议」两个按钮。
  3. 删除右栏「快捷操作」四宫格卡（四项全部并入下拉）。
  4. 「新建待办」改为完整闭环：切回「近期」视图 → `scrollIntoView({block:"center"})` → `focus()` → 输入框背景高亮 `#e8f0ff` 1.4s 后恢复。
  5. 原底部全宽的「本周节奏」点阵改为右栏第三张卡的竖排 7 行（日期 · 点阵 · 文案，今天行高亮），顶掉原快捷操作的位置——既补上删卡后的右栏高度，也让整页从"最底部横跨一条"收进一屏。
- 验证（热替换 + 镜像重建后实测）：
  - 顶栏只剩「＋ 新建 ▾」，下拉四项齐全，控制台 0 报错；
  - 点「新建待办」：菜单自动关闭，`document.activeElement` 即行内输入框，背景为 `rgb(232,240,255)`；
  - 点「新建会议」：正确跳转会议面板（月历 9 场本月会议可见）；
  - 右栏变为 本周进度（6/7、86%）+ 最近笔记（4 条）+ 本周节奏（七行竖排，11/9 高亮「1/1 项 · 1 会」）。
- 顺带修掉一处测试期数据事故：验证撤销热区时把「提交季度总结」误置为已完成，已还原为未完成（7 条待办 / 6 完成 1 未完成），与原始数据一致。

### 16. v3.11 落地记录（新建入口改为对话式）

- 用户反馈：「新建待办 / 新建会议」应该直接跳到 DSH 会话页，用自然语言跟助手说要建什么，而不是走插件自己的表单。
- 行为改造（`tidywork-plugin/lib/client.js`）：
  - 下拉三项改为 `startWithDraft(prefix)`：先 `openConversation()` 回到会话面板，再在 320ms 后找到可见的会话输入框（`[contenteditable="true"]`，取最后一个），聚焦并预填一句草稿——「帮我新建一个待办：」/「帮我新建一个会议：」/「帮我记一条笔记：」，光标停在冒号后，用户补全内容回车即可。
  - 预填用 `document.execCommand("insertText")` 写入。实测该输入框是受控 contenteditable：直接改 DOM 会被 store 覆盖，`execCommand("delete")` 也不生效，只有 `insertText` 走编辑器自己的输入通道；因此「已有旧草稿」时采用 `selectAll` + `insertText` 整段替换，不拼接。
  - 草稿互不覆盖：仅当输入框为空、或已有内容以这三句草稿开头（说明是插件自己填的）时才写入；用户已经在写的任何其他内容原样保留。
- 验证（热替换实测）：
  - 工作台点「新建待办」→ 跳到会话页，输入框出现「帮我新建一个待办：」；
  - 再点「新建会议」→ 旧句式被整段替换为「帮我新建一个会议：」，无拼接残留；
  - 点「新建笔记」→「帮我记一条笔记：」；
  - 预先在输入框写入「今天下午三点评审」，再点「新建待办」→ 内容原样保留，未被覆盖。

### 17. v3.12 落地记录（数据可靠性 + 会议闭环）

- 起因：复盘 v3.11 期间的一次数据事故——测试把「提交季度总结」误置为已完成，事后才发现。追下去是三个叠加的薄弱点：`saveStore` 直接 `writeFile` 覆盖（写到一半进程退出就是半个 JSON）、HTTP 与 Agent 工具并发做"读-改-写"时互相覆盖（后写的拿走快照）、客户端撤销靠"再 toggle 一次"的反向操作（状态一旦漂移就写错方向）。
- 改动一：服务端写入串行化 + 原子落盘（`tidywork-plugin/lib/index.js`）
  1. 新增 `writeQueues` + `withQueue(key, fn)`：同一资源的写请求按 `todos / meetings / notes` 排队串行，前一个失败也继续（`prev.then(fn, fn)`），队列尾存 `next.then(()=>{},()=>{})` 防 unhandled rejection。
  2. 路由拆成 `routeCore`（原实现）+ 外层 `handle`：GET 直接读（原子写保证文件永远完整，不需排队），POST/PATCH/PUT/DELETE 一律入队。
  3. `saveStore` 改为原子写：写 `file + ".tmp-<pid>-<rand>"` 再 `rename` 覆盖，失败时先 `unlink` 临时文件再抛错，不留垃圾。
  4. Agent 工具 `addTodo` / `addMeeting` 的整段「读-改-写」也包进同一个队列，与 HTTP 写共用一把锁。
- 改动二：勾选语义改为显式设值（`tidywork-plugin/lib/client.js`，HomePage）
  - `setDone(id, done, title)`：PATCH `{done: !!done}` 显式写目标值，成功后再按返回值更新本地 + `load()` 回读一次校准；撤销直接调 `setDone(id, false)`，不再构造"反向 toggle"。
  - 待办面板的 `toggle(id, done)` 本来就是显式语义，保持不变。
- 改动三：会议 → 待办一条最小闭环（`tidywork-plugin/lib/client.js`，会议面板）
  - 会议卡底部新增「生成待办 →」（与「N 人参会」同行右对齐），点击 POST `/tidywork-api/todos`：标题 `会后跟进：<会议标题>`、`due` 沿用会议日期、`category` 固定「会议」，成功后 toast 回显。
  - 只做手动触发，不做自动生成：每场会都是跟进项的前提不成立，留给人决定。
- 验证（热替换 + 实测，测完数据已还原为空实例）
  - 并发 20 个 POST 同秒打进来 → 接口与文件均 20 条，一条不丢，目录无 `.tmp-*` 残留；
  - 同一条 PATCH `{done:true}` 连发两次 → 仍为 true（幂等，不会翻回去）；再 PATCH `{done:false}` → 正确回到未完成；
  - 会议面板点「生成待办 →」→ `todos.json` 新增 `会后跟进：季度复盘会`（category=会议，due=2026-11-14），总条数 20 → 21；
  - 页面点勾选 → 文件 `done:true`；点 toast「撤销」→ 文件回到 false，列表计数同步（load 回读生效）；
  - 镜像重建后容器内 `/app` 与 `node_modules` 两份代码均为新版本，干净实例页面 0 会议 / 0 待办 / 0 笔记正常。
