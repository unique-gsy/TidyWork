# 笔记编辑器 · Typora 手感 A/B

同一个 Markdown 文件，左边是现在的自研渲染，右边是 Vditor 的 `ir`（即时渲染）模式。
先看视觉和打字手感能不能接受，再决定换不换引擎；决定换的话，插件里已经接好了（v3.35.0）。

## 怎么跑

```bash
cd docs/notes-editor-demo
python3 -m http.server 8765
# 打开 http://127.0.0.1:8765/index.html
```

不能直接双击 `index.html`：Vditor 的引擎（lute）是通过 http 拉的，`file://` 会被拦。

页面上的开关：

- **对照现状**：左 42% 是自研渲染（只读），右边是可编辑的 Vditor ir。
- **专注**：只亮光标所在那一块，其余压到 30% 不透明。
- **打字机**：光标保持在视口中线附近滚动。
- 左栏三篇样例覆盖了标题 / 表格 / 嵌套列表 / 待办 / 代码块 / 公式，用来比"谁漏渲染"。

`vd-api-test.html` 是接口自检：`getValue` / `setValue` / `insertValue` / `destroy` / 换深浅色重建，
结果直接写在页面顶部，用来确认 Vditor 的这几个调用在这个版本上是可用的。

## 插件里对应哪几段

| demo 里的东西 | 插件里的位置 |
| --- | --- |
| 加载 Vditor（CSS + JS） | `lib/client.js` 的 `loadVditor()` |
| 单主题 CSS（去工具栏、去 H1/H2 角标） | `lib/client.js` 的 `VD_CSS` |
| 编辑区组件（受控值、专注、打字机、内链、图片粘贴） | `lib/client.js` 的 `TyporaNote` |
| 资源服务 | `lib/index.js` 的 `/tidywork-api/vendor/vditor/*` 路由 |
| 资源本体 | `lib/vendor/vditor/dist`（约 7.6MB，打包脚本已同步） |

## 在应用里怎么验

1. 笔记页工具栏点 **Typora**，看是否出现"即时渲染 · 点哪块编哪块"，没有报错条。
2. 光标点进任意一段：只露该段源码（`#`、`**`），移开即渲染。
3. 中文输入法连打一段话：不跳字、不丢光标。
4. 表格里 Tab 走格、Enter 换行、行内加一行。
5. 粘贴截图：图片落到 `/tidywork-api/attachments/`，插在光标处。
6. 点正文里的 `todo:` / `meeting:` 内链：跳对应面板。
7. 系统换深浅色：编辑器自动重建，正文不丢。
8. ⌘S 保存、⌘E 回预览态；切到别的笔记再切回来，内容和版本快照都对得上。
9. 加载失败时应当 toast 提示并自动退回「即时」模式，而不是白屏。

## 已经对齐的 Typora 细节

- 标题：去掉 Vditor 左侧的 `H1/H2` 层级角标和标题下那条横线。
- 公式：块级公式不套底色和边框，写成裸排版；顺带把公式块里那条"空行"归零，上下不再多出半行。
- 待办：复选框换成和插件 `tw-check` 同一套描边圆角，不用系统原生小方块。
- 代码块：保留 Vditor 的浅灰底 + 1px 描边，和 Typora 的观感基本一致。

## 已知取舍

- 只打包了 `ir` 模式必需的东西：lute、图标、i18n、KaTeX、highlight.js。Mermaid / ECharts / 各种流程图库没进包，写了会渲染成代码块。
- 只保留一套主题：Vditor 自带的工具栏、面板、计数器、`H1/H2` 层级角标全部关掉；深浅色跟宿主 `data-ds-dark-theme` 走。
- 正文仍是 Markdown 真源，但 Vditor 的 `getValue` 会做规范化（结尾补换行、列表符号统一），第一次保存会产生一次 diff，版本快照里能看到。
