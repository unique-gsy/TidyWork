// TidyWork 工作区插件 · 客户端半（浏览器）
// 按 DSH 客户端插件契约：window.__ModuleLoader__.load({id, factory})，
// factory 接收 require，导出 apply/inject。
// v3.23 变更（品牌回退）：
//   0) 不再注册 sidebar.brand.mark / sidebar.brand.name，也不再改 title / favicon：
//      侧边栏顶部与标签页完整使用 DSH 原本的样子（DeepSeek 鲸鱼图标 + DeepSeek Harness）。
// v3.1 变更：
//   2) 待办 / 会议 / 笔记三个页面（智能视图/分类/统计/优先级勾选；月历/周条带/时间线/
//      新建删除；双栏笔记/保存删除/字数），数据走 /tidywork-api 路由（服务端半提供）。
//   3) 保留：工作台主面板（默认首屏）、3 个侧边栏入口。
// v3.2 变更（侧边栏分组）：
//   4) TidyWork 入口 order 改为 -10..-7（全部低于 DSH 官方 插件0/自动化任务10），
//      实现"先是 TidyWork 功能"置顶分组。
//   5) brand.mark 组件内渲染 <style>，注入全局 CSS：在第一个 DSH 原生入口（插件）之上
//      画一条 1px 主题分隔线（--dsw-alias-border-l1），实现"长线划分"。
// v3.6 变更（工作台概览化）：
//   6) 工作台（tidywork-home）从"4 Tab 容器"升级为概览式工作台：
//      默认展示 今日待办（含完成率进度条）/ 今日会议 / 最近笔记 三张聚合卡片，
//      每张卡片可点击跳转到对应功能面板；底部保留 待办/会议/笔记 快捷入口。
// v3.7 变更（删除工作看板）：
//   7) 移除工作看板：BoardPage、侧边栏 tidywork-board 入口、概览「工作看板」卡片、
//      快捷入口与 /tidywork-api/data?kind=board 通道一并删除；
//      插件仅保留 工作台 / 待办 / 会议 / 笔记 四个板块。
// v3.8 变更（工作台一屏化）：
//   8) 工作台从"三卡概览 + 三个快捷条（下半屏留白）"重构为一屏可操作工作台：
//      左栏 今日日程时间轴（09:00–18:00，会议定位成块、空档标为可专注 + 可勾选待办清单
//      （近期/今天/逾期/本周/全部 五个视图，勾选即时回写 PATCH）；
//      右栏 本周进度环 + 最近笔记 + 2×2 快捷操作；底部 本周节奏（7 天点阵）。
//      窄屏（窗口 <860px）自动切单列。
// v4.0 变更（笔记富文本）：
//   9) 笔记正文改为 Markdown 真源：新笔记 format="markdown"，老笔记 format="text" 继续按纯文本渲染，
//      不迁移数据。读态用插件内置的极简 GFM 渲染（标题/列表/表格/代码块/粗斜体/删除线/引用/
//      任务清单/图片/链接），写态仍是 textarea + 工具栏（插件保持零依赖直发，不引第三方编辑器）。
//  10) 编辑体验：编辑 / 分屏 / 预览三态、工具栏一键插入（标题/粗体/列表/待办/代码/表格/链接/图片）、
//      Cmd+B/I/S/E、Tab 缩进、粘贴或拖入图片自动上传并插入。
//  11) 保存与协同：900ms 防抖自动保存、localStorage 草稿恢复、rev 冲突提示（AI 写入同一篇时会提示
//      「加载最新 / 覆盖保存」，不再静默覆盖）。
//  12) 组织能力：标签、置顶、搜索、大纲跳转、版本历史（最多 20 个快照并可回滚）、
//      勾选清单一键转待办、笔记内链 todo:/meeting: 点击跳对应面板。
window.__ModuleLoader__.load({
	id: "@tidywork/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let { useEffect, useState, useCallback, useRef, useMemo } = react;

		// ===== 常量：工作台色板（跟随 DSH 宿主主题）=====
		// DSH 用 body[data-ds-dark-theme] 切换深浅，并把所有颜色发布成 --dsw-alias-* 设计 token。
		// 这里全部改读宿主的 token，插件就不再自绘一套浅色皮肤：侧栏深、工作台也深，
		// 卡片比底色亮一档、边框是半透明白，跟侧栏同一套语言。第二个参数是脱离宿主时的兜底原值。
		// --tw-*（强调色与状态色）由 injectThemeCss() 按主题注入两套，见下。
		const C = {
			// 页面底色不能用 bg-base：宿主浅色主题下它就是纯白，和卡片（layer-1 也是纯白）
			// 会糊成一片。这里按 4% 文字色压暗一档——浅色得到 #f4f4f4（正是原来的灰底），
			// 深色得到比 #151517 略亮的深灰，卡片仍亮一档，两种主题都有层次。
			page: "var(--tw-paper, #f7f8fa)",
			main: "var(--tw-panel, #ffffff)",
			// 宿主的 layer-2/3 在浅色主题下与 layer-1 同值，做不出 hover/active，
			// 因此改用文字色叠加：浅色叠黑、深色叠白，两个主题下都看得见。
			hover: "var(--tw-wash, #eef1f8)",
			active: "color-mix(in srgb, var(--tw-ink, #15181e) 9%, transparent)",
			input: "var(--tw-panel, #ffffff)",
			border: "var(--tw-rule, #e4e6ea)",
			borderLight: "var(--tw-rule, #e4e6ea)",
			text0: "var(--tw-ink, #15181e)",
			text1: "var(--tw-ink-2, #565d69)",
			text2: "var(--tw-muted, #8b919c)",
			accent: "var(--tw-accent, #3370ff)",
			accentHover: "var(--tw-accent-hover, #2860e1)",
			accentSoft: "var(--tw-accent-soft, rgba(51,112,255,0.08))",
			success: "var(--tw-success, #34c759)",
			warning: "var(--tw-warning, #ff9500)",
			danger: "var(--tw-danger, #ff3b30)",
			mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.4))",
			onAccent: "var(--tw-on-accent, #ffffff)"
		};

		// 强调色 / 状态色的深浅两套。宿主的 --dsw-alias-* 只管中性色，品牌色归插件自己，
		// 深色下必须提亮（#3370ff 在近黑背景上偏闷），沿用同一色相、只调亮度。
		const THEME_CSS = [
			":root{",
			"--tw-accent:#2f5bff;",
			"--tw-accent-hover:#2447e0;",
			"--tw-accent-soft:rgba(47,91,255,0.07);",
			"--tw-success:#1f9d63;",
			"--tw-warning:#c07a12;",
			"--tw-danger:#c0392b;",
			"--tw-on-accent:#ffffff;",
			"--tw-toast-bg:#1b1e26;",
			"--tw-paper:#f7f8fa;",
			"--tw-panel:#ffffff;",
			"--tw-rule:#e4e6ea;",
			"--tw-rule-2:#d5d8de;",
			"--tw-ink:#15181e;",
			"--tw-ink-2:#565d69;",
			"--tw-muted:#8b919c;",
			"--tw-wash:#eef1f8;",
			"}",
			"body[data-ds-dark-theme]{",
			"--tw-accent:#8aa6ff;",
			"--tw-accent-hover:#a6bbff;",
			"--tw-accent-soft:rgba(138,166,255,0.14);",
			"--tw-success:#3ddc97;",
			"--tw-warning:#e8b45a;",
			"--tw-danger:#ff6b5e;",
			"--tw-on-accent:#ffffff;",
			"--tw-toast-bg:#3a3a3c;",
			"--tw-paper:#121317;",
			"--tw-panel:#17181c;",
			"--tw-rule:#2a2c33;",
			"--tw-rule-2:#3a3d45;",
			"--tw-ink:#eceef2;",
			"--tw-ink-2:#a7adba;",
			"--tw-muted:#767c88;",
			"--tw-wash:#1d1f25;",
			"}",
			"html[data-platform='darwin'] .tw-frame-page{padding-top:var(--dsh-frame-top-clearance,0px);}",
			// v3.23：品牌 mark 交回宿主（原生 DeepSeek 图标），分隔线改为随主题一起注入
			"nav[aria-label] > button[aria-label=\"插件\"]{margin-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#e5e6eb);}",
			// 键盘可达：之前所有可点元素都没有焦点圈，纯键盘用户看不出当前在哪
			"button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible{outline:2px solid var(--tw-accent);outline-offset:2px;border-radius:6px;}",
			".tw-check:focus-visible{outline:2px solid var(--tw-accent);outline-offset:3px;}",
			"@media (prefers-reduced-motion:reduce){.tw-frame-page *{transition:none !important;animation:none !important;}}"
		].join("");
		const FONT = "'IBM Plex Sans', 'Familjen Grotesk', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif";
		const PRIORITY = {
			high: { color: C.danger, label: "高优先级" },
			mid: { color: C.warning, label: "中优先级" },
			low: { color: C.text2, label: "低优先级" }
		};
		const DUE_LABEL = { today: "今天截止", tomorrow: "明天截止", week: "本周截止", none: "无期限", yesterday: "昨天截止" };
		const WEEK_DAYS = ["一", "二", "三", "四", "五", "六", "日"];

		// ===== 工具 =====
		const h = react.createElement;
		// 半透明底色：直接写 rgba 在深色主题下叠不出来，用 color-mix 让它跟着主题变色。
		const tint = (color, pct) => "color-mix(in srgb, " + color + " " + pct + "%, transparent)";

		function esc(s) {
			return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
		}
		// ===== 会话跳转（v3.30）：全部走宿主服务，不再抓 DOM =====
		// 旧实现靠 aria-label「新建会话 / 打开侧边栏」+ contenteditable 点击 + 轮询 30s 找会话行：
		// 宿主改文案、切英文界面或改布局就整体失效，还会往会话里塞一条锚定消息。
		// 现在统一走 ctx.workspaces / ctx.uiWorkspace，拿不到服务时退回页内弹窗。
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		/** 宿主上下文：apply 时注入，页面里的「＋新建」用它打开今日会话。 */
		let hostCtx = null;

		// ===== v3.16：今日工作项会话 =====
		// 「＋ 新建工作项」不再每次开一个新会话，而是回到 TidyWork 工作区里"今天"的那个会话：
		//   ① 没有 TidyWork 工作区 → 建一个（目录由用户选，路径因机器而异，插件不猜）；
		//   ② 该工作区下今天还没有会话 → 建一个；
		//   ③ 直接打开它 —— 派什么活、怎么归类，由服务端的系统提示承载，不占对话。
		// 全程走宿主服务（ctx.workspaces / ctx.uiWorkspace），不再靠点 DOM 上的「新建会话」按钮。
		const TODAY_SESSION_KEY = "tidywork.todaySession";
		const WORKSPACE_TITLE = "tidywork";

		function ymdLocal(d) {
			const p = (n) => (n < 10 ? "0" + n : "" + n);
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
		}
		function readTodaySession() {
			try {
				const raw = localStorage.getItem(TODAY_SESSION_KEY);
				return raw ? JSON.parse(raw) : null;
			} catch (e) {
				return null;
			}
		}
		function writeTodaySession(id) {
			try {
				localStorage.setItem(TODAY_SESSION_KEY, JSON.stringify({ d: ymdLocal(new Date()), id: id }));
			} catch (e) {}
		}
		/** 找 TidyWork 工作区；快照可能还在 loading，等一小会再判。 */
		async function findTidyWorkspace(ctx) {
			let lastError = null;
			for (let i = 0; i < 12; i++) {
				let items = [];
				try {
					const snap = ctx.workspaces.list.getSnapshot();
					items = (snap && snap.items) || [];
				} catch (e) {
					lastError = e;
				}
				const exacts = items.filter((w) => String(w.title || "").trim().toLowerCase() === WORKSPACE_TITLE);
				if (exacts.length) {
					// 同名时取最早建的那个，避免用户后来手建同名工作区后命中错的那一份
					exacts.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
					return exacts[0];
				}
				if (items.length) {
					const loose = items.find((w) => String(w.title || "").toLowerCase().indexOf(WORKSPACE_TITLE) !== -1);
					if (loose) return loose;
					break;
				}
				await sleep(250);
			}
			console.warn("[tidywork] 未找到 TidyWork 工作区", lastError, describeWorkspaces(ctx));
			return null;
		}
		function describeWorkspaces(ctx) {
			try {
				const snap = ctx.workspaces.list.getSnapshot();
				return { state: snap && snap.state, phase: snap && snap.phase, items: ((snap && snap.items) || []).map((w) => String(w.title) + "|" + String(w.path)) };
			} catch (e) {
				return "workspaces 服务不可用：" + ((e && e.message) || e);
			}
		}
		/**
		 * 拿一个目录来承载 TidyWork 工作区。
		 * 桌面端有原生目录选择器；web 端 pick() 需要 native capability，只能用 browse 通道：
		 * 先读 home，再在 home 下建 TidyWork 目录。
		 */
		async function ensureWorkspaceDir(ctx) {
			try {
				const dir = await ctx.uiWorkspace.pickDirectory();
				if (dir) return dir;
			} catch (e) {
				console.warn("[tidywork] native picker 不可用：", e && e.message);
			}
			const listing = await ctx.uiWorkspace.listDirectory();
			return await ctx.uiWorkspace.createDirectory(listing.home, "TidyWork");
		}
		/** 会话快照（byId），拿不到就返回空对象——只用来读标题，不该因为快照没加载就报错。 */
		function sessionIndex(ctx) {
			try {
				const snap = ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot();
				return (snap && snap.byId) || {};
			} catch (e) {
				return {};
			}
		}
		/** 给会话改名（宿主 rename 走 workspaceOperation 通道，和它自己重命名弹窗同一个入口）。 */
		async function renameSessionTo(ctx, id, title) {
			if (!ctx.sessions || !ctx.sessions.using) throw new Error("宿主会话服务不可用");
			const res = await ctx.sessions.using(id, { source: "workspaceOperation" }, (ref) => {
				const b = ref && ref.binding;
				if (!b || !b.session || typeof b.session.rename !== "function") throw new Error("session.rename 不可用：" + Object.keys(b || {}).join(","));
				return b.session.rename(title);
			});
			if (res && res.ok === false) throw new Error((res.error && res.error.message) || "会话改名失败");
			return res;
		}
		/**
		 * TidyWork 工作区里"今天"的会话：标题就是 yyyy-mm-dd。
		 * 先按标题找（跨天/换机器后 localStorage 可能丢，标题才是真依据），再按本地记录找；
		 * 都没有就新建一个并改名，然后把 id 记下来。
		 */
		async function ensureTodaySession(ctx, ws, today) {
			const ids = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
			const byId = sessionIndex(ctx);
			const titleOf = (id) => String((byId[id] || {}).title || "").trim();
			const titled = ids.find((id) => byId[id] && titleOf(id) === today);
			if (titled) {
				writeTodaySession(titled);
				return titled;
			}
			let sid = null;
			const rec = readTodaySession();
			const reusable = rec && rec.d === today && ids.indexOf(rec.id) !== -1 ? rec.id : null;
			if (reusable) {
				// 同一天已记过这个会话：直接复用，但标题可能还是「新会话」，下面统一改名
				sid = reusable;
			} else {
				// 一律用 connectWorkspace：它只在指定工作区里建/复用空白会话；
				// sessions.create 会跨工作区复用"空白会话"，容易把别处的草稿连工作区一起拖过来。
				try {
					sid = await ctx.uiWorkspace.connectWorkspace(ws.workspaceId);
				} catch (e) {
					if (ctx.sessions && typeof ctx.sessions.create === "function") {
						sid = await ctx.sessions.create({ workspaceId: ws.workspaceId });
					} else {
						throw e;
					}
				}
				// 刚建出来的会话还没进客户端目录，这时 using() 拿不到 binding；
				// 先等它出现在会话列表里，再改名。
				for (let i = 0; i < 12; i++) {
					if (sessionIndex(ctx)[sid]) break;
					await sleep(150);
				}
			}
			if (titleOf(sid) !== today) {
				let renamed = false;
				let lastError = null;
				for (let i = 0; i < 6 && !renamed; i++) {
					try {
						await renameSessionTo(ctx, sid, today);
						renamed = true;
					} catch (e) {
						lastError = e;
						await sleep(300);
					}
				}
				if (!renamed) console.warn("[tidywork] 今日会话改名失败：", (lastError && lastError.message) || lastError);
			}
			writeTodaySession(sid);
			return sid;
		}
		/** 打开今天的 TidyWork 会话；没有就按 ①→②→③ 建出来。宿主服务不可用时退回页内弹窗。 */
		async function openTodayWorkItem(ctx, fallback) {
			try {
				if (!ctx || !ctx.workspaces || !ctx.uiWorkspace) throw new Error("宿主会话服务不可用");
				let ws = await findTidyWorkspace(ctx);
				if (!ws) {
					const dir = await ensureWorkspaceDir(ctx);
					if (!dir) throw new Error("没有可用的工作区目录");
					ws = await ctx.workspaces.create({ path: dir });
				}
				const today = ymdLocal(new Date());
				const sid = await ensureTodaySession(ctx, ws, today);
				toast("已打开今日工作项 " + today);
				ctx.uiWorkspace.openSession(sid);
			} catch (e) {
				// 桌面端 web/容器等拿不到工作区服务时，不要让「＋新增」变成点了没反应：直接开页内弹窗
				if (fallback) { fallback(); return; }
				toast("打开今日工作项失败：" + ((e && e.message) || "未知错误"));
			}
		}

		/**
		 * 宿主的「新会话」按钮不属于插件，但它最终调的是 ctx.uiWorkspace.startSession()：
		 * 不指定工作区时宿主会落到"当前/最近的工作区"——也就是 TidyWork，普通对话被混进工作项里。
		 * 这里包一层：不指定工作区的「新会话」改为开一个不属于任何工作区的普通会话（宿主默认目录），
		 * 于是「新会话」= DSH 普通会话，「＋ 新建工作项」= TidyWork 的 yyyy-mm-dd 会话，两边分开。
		 * 显式传 workspaceId 的调用原样放行；需要预填草稿的入口（首屏"开始任务"等）也不接管。
		 */
		function installNewSessionRouting(ctx) {
			const uw = ctx.uiWorkspace;
			if (!uw || typeof uw.startSession !== "function") return () => {};
			if (uw.__tidyworkRouted) return () => {};
			const orig = uw.startSession;
			const startPlain = (options) => {
				Promise.resolve()
					.then(() => {
						if (!ctx.sessions || typeof ctx.sessions.create !== "function") throw new Error("宿主会话服务不可用");
						return ctx.sessions.create({});
					})
					.then((id) => {
						if (!id) throw new Error("宿主没有返回新会话");
						ctx.uiWorkspace.openSession(id);
					})
					.catch((e) => {
						// 老宿主/降级环境：退回宿主原行为，至少不会点了没反应
						console.warn("[tidywork] 普通会话创建失败，退回宿主默认：", (e && e.message) || e);
						orig.call(uw, undefined, options);
					});
			};
			const patched = function (workspaceId, options) {
				if (workspaceId !== undefined) return orig.call(uw, workspaceId, options);
				if (options && (options.prompt !== undefined || options.agentPreset !== undefined)) {
					return orig.call(uw, undefined, options);
				}
				startPlain(options);
			};
			uw.startSession = patched;
			uw.__tidyworkRouted = true;
			return () => {
				if (uw.startSession === patched) uw.startSession = orig;
				delete uw.__tidyworkRouted;
			};
		}

		/** 页面里的「＋新增」统一入口：优先回到今日会话，拿不到就退回弹窗。 */
		async function openWorkItem(fallback) {
			if (!hostCtx) { if (fallback) fallback(); return; }
			await openTodayWorkItem(hostCtx, fallback);
		}

		/** 调用 /tidywork-api 路由（path 已含 /tidywork-api 前缀）：ok 时 resolve(data)，失败 reject(error)。
		 *  失败时 error 上带 status / payload —— 笔记的 409 冲突要靠它区分"被别处改过"和普通失败。
		 *  v3.30：加 15s 超时；非 JSON 响应（登录过期回来的 HTML、网关错误页）转成人话，
		 *  不再把 "Unexpected token '<'" 直接甩到 toast 上。 */
		const API_TIMEOUT = 15000;
		/** opts.timeoutMs 可为长任务（邮箱扫描）放宽超时，其余请求仍按 15 秒。 */
		function api(path, opts) {
			const init = Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {});
			const timeoutMs = Number(init.timeoutMs) > 0 ? Number(init.timeoutMs) : API_TIMEOUT;
			delete init.timeoutMs;
			const ctrl = typeof AbortController === "function" ? new AbortController() : null;
			let timer = null;
			if (ctrl) {
				init.signal = ctrl.signal;
				timer = setTimeout(() => ctrl.abort(), timeoutMs);
			}
			const settle = () => { if (timer) clearTimeout(timer); };
			return fetch(path, init).then(
				(r) => { settle(); return handle(r); },
				(e) => { settle(); throw friendlyNetError(e); }
			);
		}
		function friendlyNetError(e) {
			if (e && (e.name === "AbortError" || e.code === 20)) {
				const err = new Error("请求超时（服务端未响应），请稍后重试");
				err.status = 0;
				return err;
			}
			const err = new Error("网络请求失败，请检查插件服务端是否在运行");
			err.status = 0;
			err.cause = e;
			return err;
		}
		function handle(r) {
			const type = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
			if (type.indexOf("json") < 0) {
				const err = new Error(r.status === 401 || r.status === 403 ? "没有权限访问工作区接口，请重新登录 DSH" : "工作区接口返回了非 JSON 内容（HTTP " + r.status + "）");
				err.status = r.status;
				throw err;
			}
			return r.json().then((j) => {
				if (j && j.ok) return j.data;
				const err = new Error((j && j.error) || "请求失败（HTTP " + r.status + "）");
				err.status = r.status;
				err.payload = j && j.data;
				throw err;
			});
		}
		let __toastTimer = null;
		/** toast(msg, opts?)：opts.action 显示可点击动作（如"撤销"），点击触发 onAction 后立即隐藏。 */
		function toast(msg, opts) {
			let el = document.getElementById("tw-toast");
			if (!el) {
				el = document.createElement("div");
				el.id = "tw-toast";
				el.style.cssText =
					"position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(10px);background:var(--tw-toast-bg,#1f2329);color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;z-index:99999;opacity:0;transition:opacity .2s,transform .2s;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.18);font-family:" + FONT + ";display:flex;align-items:center;gap:12px;white-space:nowrap;";
				document.body.appendChild(el);
			}
			const hide = () => {
				el.style.opacity = "0";
				el.style.transform = "translateX(-50%) translateY(10px)";
				el.style.pointerEvents = "none";
			};
			el.textContent = "";
			el.appendChild(document.createTextNode(msg));
			if (opts && opts.action) {
				el.style.pointerEvents = "auto";
				const b = document.createElement("button");
				b.textContent = opts.action;
				b.style.cssText = "color:#6b9fff;font-weight:600;cursor:pointer;background:transparent;border:none;font-family:inherit;font-size:13px;line-height:1.2;padding:7px 12px;margin:-7px -8px -7px 0;border-radius:6px;";
				b.onclick = () => {
					hide();
					clearTimeout(__toastTimer);
					if (opts.onAction) opts.onAction();
				};
				el.appendChild(b);
			}
			el.style.opacity = "1";
			el.style.transform = "translateX(-50%) translateY(0)";
			clearTimeout(__toastTimer);
			// 带撤销动作时留更长窗口，避免手还没到就消失
			__toastTimer = setTimeout(hide, (opts && opts.action) ? 5000 : 2600);
		}

		/** 相对时间：本地 ISO（YYYY-MM-DDTHH:MM）→ 今天/昨天/前天/M月D日 + HH:MM；非 ISO 旧数据原样返回。 */
		function relTime(v) {
			const s = String(v || "");
			const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
			if (!m) return s;
			const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
			const now = new Date();
			const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const delta = Math.round((d - t0) / 86400000);
			const hhmm = m[4] + ":" + m[5];
			if (delta === 0) return "今天 " + hhmm;
			if (delta === -1) return "昨天 " + hhmm;
			if (delta === -2) return "前天 " + hhmm;
			return Number(m[2]) + "月" + Number(m[3]) + "日 " + hhmm;
		}

		// ===== 通用样式对象（8080 CSS 形状） =====
		const S = {
			page: { flex: 1, display: "flex", overflow: "hidden", height: "100%", background: C.page, color: C.text0, fontFamily: FONT, fontSize: 14, lineHeight: 1.6, boxSizing: "border-box" },
			sideBar: { width: 200, borderRight: "1px solid " + C.border, padding: "16px 12px", overflowY: "auto", flexShrink: 0, boxSizing: "border-box" },
			sectionLabel: { fontSize: 12, fontWeight: 600, color: C.text2, padding: "8px 8px 4px", textTransform: "uppercase", letterSpacing: 0.5 },
			menuItem: { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px", borderRadius: 8, color: C.text0, fontSize: 14, fontWeight: 500, cursor: "pointer", textAlign: "left", background: "transparent", border: "none", marginBottom: 2, boxSizing: "border-box" },
			menuItemActive: { background: C.active },
			menuIcon: { width: 18, height: 18, color: C.text1, flexShrink: 0 },
			menuIconActive: { color: C.accent },
			count: { marginLeft: "auto", fontSize: 11, color: C.text2, flexShrink: 0 },
			countToday: { marginLeft: "auto", fontSize: 11, color: C.danger, fontWeight: 600, flexShrink: 0 },
			countAccent: { marginLeft: "auto", fontSize: 11, color: C.accent, fontWeight: 600, flexShrink: 0 },
			right: { flex: 1, overflowY: "auto", padding: "20px 24px", boxSizing: "border-box" },
			statGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, marginBottom: 20, padding: "14px 0", borderTop: "1px solid " + C.border, borderBottom: "1px solid " + C.border },
			statCard: { background: "transparent", border: "none", borderLeft: "1px solid " + C.border, borderRadius: 0, padding: "4px 0 4px 18px" },
			statLabel: { fontSize: 12, color: C.text2, marginBottom: 4 },
			statValue: { fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.15 },
			headRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
			viewTitle: { fontSize: 18, fontWeight: 600 },
			chip: { padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 500, color: C.text1, background: "transparent", border: "1px solid " + C.border, cursor: "pointer", fontFamily: FONT },
			chipActive: { background: C.accentSoft, color: C.accent, borderColor: "transparent", fontWeight: 600 },
			card: { background: C.main, border: "1px solid " + C.border, borderRadius: 8, overflow: "hidden" },
			empty: { padding: 40, textAlign: "center", color: C.text2, background: "transparent", border: "1px dashed " + C.border, borderRadius: 8, fontSize: 13 },
			// 接口异常横幅（加载失败时保留旧数据并提示，不伪装成"暂无数据"）
			banner: { display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 12, borderRadius: 6, border: "1px solid transparent", fontSize: 12.5, lineHeight: 1.5 },
			bannerBtn: { marginLeft: "auto", flexShrink: 0, padding: "3px 10px", borderRadius: 5, border: "1px solid currentColor", background: "transparent", color: C.danger, fontSize: 12, cursor: "pointer", fontFamily: FONT },
			// 行内文字操作按钮（替代裸 span，键盘可达 + 有 focus 圈）
			linkBtn: { padding: "2px 4px", border: "none", background: "transparent", color: C.text2, fontSize: 11, cursor: "pointer", fontFamily: FONT, borderRadius: 4 },
			input: { width: "100%", padding: "8px 10px", border: "1px solid " + C.border, borderRadius: 6, background: C.input, fontSize: 13, color: C.text0, outline: "none", boxSizing: "border-box", fontFamily: FONT },
			select: { width: "100%", padding: "8px 10px", border: "1px solid " + C.border, borderRadius: 6, background: C.input, color: C.text0, fontSize: 13, boxSizing: "border-box", fontFamily: FONT },
			btnGhost: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", borderRadius: 6, border: "none", color: C.text1, fontSize: 13, cursor: "pointer", background: "transparent", fontFamily: FONT },
			btnPrimary: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 6, background: C.accent, color: C.onAccent, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", fontFamily: FONT },
			modalOverlay: { position: "fixed", inset: 0, background: C.mask, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 },
			modal: { width: 440, maxWidth: "92vw", background: C.main, border: "1px solid " + C.border, borderRadius: 8, boxShadow: "0 2px 8px rgba(0,0,0,0.16)", padding: 20, boxSizing: "border-box" },
			modalHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
			modalTitle: { fontSize: 16, fontWeight: 600 },
			field: { marginBottom: 10 },
			fieldLabel: { display: "block", fontSize: 12, color: C.text2, marginBottom: 4 },
			footRow: { display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }
		};

		/** 通用弹窗（8080 modal 形状）。 */
		function Modal(props) {
			if (!props.open) return null;
			return h(
				"div",
				{ style: S.modalOverlay },
				h(
					"div",
					{ style: S.modal },
					h(
						"div",
						{ style: S.modalHeader },
						h("span", { style: S.modalTitle }, props.title),
						h(
							"button",
							{
								onClick: props.onClose,
								style: { width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: C.text2, background: "none", border: "none", cursor: "pointer" }
							},
							h(
								"svg",
								{ width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
								h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }),
								h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })
							)
						)
					),
					props.children
				)
			);
		}

		function Field(props) {
			return h(
				"div",
				{ style: S.field },
				h("label", { style: S.fieldLabel }, props.label),
				props.children
			);
		}

		function Chip(props) {
			return h("button", { style: Object.assign({}, S.chip, props.active && S.chipActive, props.style || {}), onClick: props.onClick }, props.children);
		}

		function Btn(props) {
			const base = props.primary ? S.btnPrimary : S.btnGhost;
			return h("button", Object.assign({}, props, { style: Object.assign({}, base, props.style || {}) }), props.children);
		}

		// ===== 截止日选择器：日历弹层（新增/编辑待办、工作台行内新增共用） =====
		const DUE_WEEK_HEAD = ["一", "二", "三", "四", "五", "六", "日"];
		const CAL_ICON = "M4 5h16v15H4V5zm12-3v5M8 2v5M4 11h16";
		function shiftYm(ym, n) {
			const p = String(ym || "").split("-").map(Number);
			const d = new Date(p[0] || new Date().getFullYear(), (p[1] || 1) - 1 + n, 1);
			return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
		}
		/** 把 due 的简写（today/tomorrow/week）折算成具体日期；none 返回空串。 */
		function dueOfValue(due) {
			const s = String(due || "");
			const today = ymd(new Date());
			if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
			if (s === "today") return today;
			if (s === "tomorrow") return shiftYmd(today, 1);
			if (s === "week") return shiftYmd(weekStartOf(today), 4);
			return "";
		}
		/** 截止日的展示文案：简写给固定说法，具体日期给「11月20日 周五」并标注今天/明天/已逾期。 */
		function dueText(due) {
			const s = String(due || "");
			if (!s || s === "none") return "无期限";
			if (s === "today") return "今天截止";
			if (s === "tomorrow") return "明天截止";
			if (s === "week") return "本周截止";
			if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
			const d = parseYmd(s);
			const today = ymd(new Date());
			const base = (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + "日一二三四五六".charAt(d.getDay());
			if (s === today) return base + " · 今天";
			if (s === shiftYmd(today, 1)) return base + " · 明天";
			if (s < today) return base + " · 已逾期";
			return base;
		}

		/** 把 due 归一成具体日期（与服务端 dueDateOf 同口径）；无期限返回 null。 */
		function dueDateClient(due, today) {
			const t = today || ymd(new Date());
			const s = String(due == null ? "" : due);
			if (!s || s === "none") return null;
			if (s === "today") return t;
			if (s === "tomorrow") return shiftYmd(t, 1);
			if (s === "yesterday") return shiftYmd(t, -1);
			if (s === "week") return weekRangeClient(t).end;
			if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
			return null;
		}
		/** 本周区间（周一 ~ 周日）。 */
		function weekRangeClient(day) {
			const start = weekStartOf(day || ymd(new Date()));
			return { start: start, end: shiftYmd(start, 6) };
		}
		/** 会议状态：有结束时间按区间判，没有就按"开始后 1 小时"算结束。 */
		function meetingStatus(m) {
			const date = String(m.date || "");
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: "upcoming", statusText: "未开始" };
			const start = new Date(date + "T" + String(m.startTime || m.time || "00:00") + ":00");
			const endRaw = new Date(date + "T" + String(m.endTime || "") + ":00");
			const end = isNaN(endRaw.getTime()) ? new Date(start.getTime() + 3600000) : endRaw;
			const now = Date.now();
			const status = now >= end.getTime() ? "done" : now >= start.getTime() ? "now" : "upcoming";
			return { status, statusText: status === "done" ? "已结束" : status === "now" ? "进行中" : "未开始" };
		}

		/** 会议时间文本：优先结构化 startTime/endTime；开始等于结束时只显示一个时刻（老数据常见）。 */
		function meetingTimeText(m) {
			const s = String(m.startTime || m.time || "");
			const e = String(m.endTime || "");
			if (s && e && s !== e) return s + " - " + e;
			if (s) return s;
			return String(m.duration || "");
		}

		/** 导出全部数据为 JSON 备份（服务端已有 /export，之前没有任何入口能触发它）。 */
		function exportAll() {
			api("/tidywork-api/export")
				.then((data) => {
					const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = "tidywork-" + ymd(new Date()) + ".json";
					document.body.appendChild(a);
					a.click();
					a.remove();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
					// 不在这里弹「已导出」：系统保存对话框还没关，用户点取消就是一句假成功。
					// 是否真的落盘由保存对话框自己反馈，这里只在请求失败时提示。
				})
				.catch((e) => toast("导出失败：" + e.message));
		}

		/** 「来自邮箱」小标：只对 source.type === "mail" 的条目出现，hover 显示邮件主题与发件人。 */
		function MailTag(props) {
			const src = props && props.source;
			if (!src || src.type !== "mail") return null;
			const tip = "来自邮箱" + (src.subject ? "：" + src.subject : "") + (src.from ? "（" + src.from + "）" : "");
			return h(
				"span",
				{
					title: tip,
					"aria-label": tip,
					style: { padding: "1px 6px", background: tint(C.accent, 10), color: C.accent, borderRadius: 4, fontSize: 11, whiteSpace: "nowrap" }
				},
				"✉ 邮箱"
			);
		}

		/**
		 * 邮箱区（工作台顶栏）：状态 + 扫描 / 设置入口。
		 * - 扫描：POST /tidywork-api/mail/scan，服务端跑 Python 引擎，可能几十秒。
		 * - 设置：弹窗里填账号/授权码，POST /tidywork-api/mail/config，保存后顺手自检。
		 * 未配置时按钮变成「配置邮箱」并直接开弹窗，避免点出看不懂的报错。
		 */
		function MailBar(props) {
			const [status, setStatus] = useState(null);
			const [busy, setBusy] = useState(false);
			const [open, setOpen] = useState(false);
			const [email, setEmail] = useState("");
			const [code, setCode] = useState("");
			const [result, setResult] = useState("");
			const [saving, setSaving] = useState(false);

			const refresh = () =>
				api("/tidywork-api/mail/status")
					.then((d) => {
						setStatus(d || null);
						if (d && d.email) setEmail(d.email);
					})
					.catch(() => setStatus(null));

			useEffect(() => { refresh(); }, []);

			const configured = !!(status && status.configured);
			const hint = "QQ 邮箱 → 设置 → 账户 → 开启 IMAP/SMTP 服务 → 生成授权码；旧授权码请先在列表里作废";

			const scan = () => {
				if (busy) return;
				if (!configured) {
					setOpen(true);
					return;
				}
				setBusy(true);
				toast("正在扫描邮箱（邮件 + 日历），通常需要 10–60 秒…");
				api("/tidywork-api/mail/scan", { method: "POST", body: JSON.stringify({ days: 7 }), timeoutMs: 180000 })
					.then((d) => {
						const s = (d && d.sync) || {};
						toast("已扫描：待办 +" + (s.todos || 0) + " · 会议 +" + (s.meetings || 0));
						if (props && props.onDone) props.onDone();
					})
					.catch((e) => toast(e.message))
					.then(() => setBusy(false));
			};

			const save = () => {
				if (saving) return;
				setSaving(true);
				setResult("");
				api("/tidywork-api/mail/config", { method: "POST", body: JSON.stringify({ email: email, authCode: code, withSelfCheck: true }), timeoutMs: 120000 })
					.then((d) => {
						setResult((d && d.text) || "已保存");
						setCode("");
						toast(d && d.configured ? "邮箱已配置" : "账号已保存，授权码留空");
						if (d && d.configured && props && props.onDone) props.onDone();
						return refresh();
					})
					.catch((e) => setResult(e.message))
					.then(() => setSaving(false));
			};

			return h(
				"span",
				{ style: { display: "inline-flex", alignItems: "center", gap: 8 } },
				h(
					"button",
					{
						type: "button",
						onClick: scan,
						disabled: busy,
						title: configured ? "从邮箱抓取待办与会议" : "先配置邮箱账号与授权码",
						style: Object.assign({}, S.btnGhost, { opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" })
					},
					busy ? "扫描中…" : configured ? "扫描邮箱" : "配置邮箱"
				),
				h(
					"button",
					{ type: "button", onClick: () => setOpen(true), title: configured ? "修改邮箱账号或授权码" : hint, style: S.btnGhost },
					configured ? "邮箱设置" : "邮箱设置 ⚠"
				),
				h(
					Modal,
					{ open: open, title: "邮箱设置", onClose: () => { setOpen(false); setResult(""); } },
					h(
						Field,
						{ label: "邮箱账号" },
						h("input", {
							style: S.input,
							type: "email",
							maxLength: 120,
							autoComplete: "off",
							spellCheck: false,
							placeholder: "例如 737081914@qq.com",
							value: email,
							onChange: (e) => setEmail(e.target.value)
						})
					),
					h(
						Field,
						{ label: "授权码（16 位；留空 = 暂时关闭邮箱扫描）" },
						h("input", {
							style: S.input,
							type: "password",
							maxLength: 32,
							autoComplete: "new-password",
							spellCheck: false,
							placeholder: status && status.hasAuthCode ? "已保存，如需更换请重新填写" : "粘贴新的授权码",
							value: code,
							onChange: (e) => setCode(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") save(); }
						})
					),
					h("div", { style: { fontSize: 12, color: C.text2, lineHeight: 1.6, marginBottom: 8 } }, hint),
					h("div", { style: { fontSize: 12, color: C.text2, lineHeight: 1.6, marginBottom: 10 } }, "授权码只写进数据目录的 mail/config.ini（600 权限），不进插件包，也不随导出文件外发。"),
					result
						? h(
								"div",
								{
									style: {
										fontSize: 12, lineHeight: 1.6, color: C.text1, background: C.page, border: "1px solid " + C.border,
										borderRadius: 6, padding: 10, marginBottom: 10, maxHeight: 220, overflowY: "auto",
										whiteSpace: "pre-wrap", wordBreak: "break-word"
									}
								},
								result
							)
						: null,
					h(
						"div",
						{ style: S.footRow },
						h("button", { type: "button", onClick: () => { setOpen(false); setResult(""); }, style: S.btnGhost }, "关闭"),
						h(
							"button",
							{ type: "button", onClick: save, disabled: saving, style: Object.assign({}, S.btnPrimary, { opacity: saving ? 0.6 : 1, cursor: saving ? "default" : "pointer" }) },
							saving ? "保存中…" : "保存并自检"
						)
					)
				)
			);
		}

		function DuePicker(props) {
			const val = String(props.value || "");
			const [open, setOpen] = useState(false);
			const [ym, setYm] = useState((dueOfValue(val) || ymd(new Date())).slice(0, 7));
			const boxRef = useRef(null);
			const compact = !!props.compact;

			// 弹层打开时跟随当前值定位月份；点外部或按 Esc 关闭（不挡住弹窗里的保存按钮）
			useEffect(() => {
				if (!open) return;
				setYm((dueOfValue(val) || ymd(new Date())).slice(0, 7));
				const away = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
				const esc = (e) => { if (e.key === "Escape") setOpen(false); };
				document.addEventListener("mousedown", away);
				document.addEventListener("keydown", esc);
				return () => {
					document.removeEventListener("mousedown", away);
					document.removeEventListener("keydown", esc);
				};
			}, [open, val]);

			const pick = (due) => {
				if (props.onChange) props.onChange(due);
				setOpen(false);
			};

			const shown = dueOfValue(val);
			const today = ymd(new Date());
			const first = parseYmd(ym + "-01");
			const lead = (first.getDay() + 6) % 7;
			const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
			const cells = [];
			for (let i = 0; i < lead; i++) cells.push("");
			for (let d = 1; d <= days; d++) cells.push(ym + "-" + pad2(d));
			while (cells.length % 7 !== 0) cells.push("");

			const navBtn = { width: 24, height: 24, borderRadius: 6, border: "none", background: "transparent", color: C.text1, fontSize: 15, cursor: "pointer", fontFamily: FONT, lineHeight: "1" };
			const pop = {
				position: "absolute",
				bottom: "calc(100% + 6px)",
				left: 0,
				width: 262,
				background: C.main,
				border: "1px solid " + C.border,
				borderRadius: 10,
				boxShadow: "0 10px 30px rgba(0,0,0,0.16)",
				padding: 10,
				boxSizing: "border-box",
				zIndex: 60
			};

			return h(
				"div",
				{ ref: boxRef, style: { position: "relative", width: compact ? "auto" : "100%", flexShrink: compact ? 0 : 1 } },
				h(
					"button",
					{
						type: "button",
						onClick: () => setOpen((o) => !o),
						style: compact
							? { display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 6, border: "1px solid " + C.border, background: C.main, color: C.text1, fontSize: 11.5, cursor: "pointer", fontFamily: FONT, flexShrink: 0, whiteSpace: "nowrap" }
							: Object.assign({}, S.select, { display: "flex", alignItems: "center", gap: 8, textAlign: "left", cursor: "pointer" }),
						title: "选择截止日期"
					},
					h(
						"svg",
						{ width: compact ? 12 : 15, height: compact ? 12 : 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", style: { flexShrink: 0, color: C.accent } },
						h("path", { d: CAL_ICON })
					),
					h("span", { style: { flex: compact ? "0 0 auto" : 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, dueText(val)),
					compact
						? null
						: h(
								"svg",
								{ width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", style: { flexShrink: 0, color: C.text2 } },
								h("path", { d: "M6 9l6 6 6-6" })
							)
				),
				open
					? h(
							"div",
							{ style: pop },
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 } },
								h("button", { type: "button", style: navBtn, onClick: () => setYm(shiftYm(ym, -1)) }, "‹"),
								h("span", { style: { fontSize: 13, fontWeight: 600 } }, (parseYmd(ym + "-01").getMonth() + 1) + " 月 " + parseYmd(ym + "-01").getFullYear()),
								h("button", { type: "button", style: navBtn, onClick: () => setYm(shiftYm(ym, 1)) }, "›")
							),
							h(
								"div",
								{ style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 } },
								DUE_WEEK_HEAD.map((w) => h("div", { key: w, style: { textAlign: "center", fontSize: 10.5, color: C.text2, padding: "2px 0" } }, w))
							),
							h(
								"div",
								{ style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 } },
								cells.map((c, i) => {
									if (!c) return h("div", { key: "blank" + i });
									const isSel = shown === c;
									const isToday = c === today;
									return h(
										"button",
										{
											key: c,
											type: "button",
											onClick: () => pick(c),
											style: {
												height: 30,
												borderRadius: 6,
												border: "1px solid " + (isToday && !isSel ? C.accent : "transparent"),
												background: isSel ? C.accent : isToday ? C.accentSoft : "transparent",
												color: isSel ? C.onAccent : c < today ? C.text2 : C.text0,
												fontSize: 12.5,
												fontWeight: isSel || isToday ? 600 : 400,
												cursor: "pointer",
												fontFamily: FONT,
												padding: 0
											}
										},
										String(Number(c.slice(8)))
									);
								})
							),
							h(
								"div",
								{ style: { display: "flex", gap: 6, marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.border } },
								[
									["today", "今天"],
									["tomorrow", "明天"],
									["week", "本周"],
									["none", "无期限"]
								].map(([k, label]) =>
									h(
										"button",
										{
											key: k,
											type: "button",
											onClick: () => pick(k),
											style: { flex: 1, padding: "4px 0", borderRadius: 5, border: "1px solid " + (val === k ? "transparent" : C.border), background: val === k ? C.accentSoft : "transparent", color: val === k ? C.accent : C.text1, fontSize: 11.5, cursor: "pointer", fontFamily: FONT }
										},
										label
									)
								)
							)
						)
					: null
			);
		}

		// ===== 待办（智能视图/分类/统计/优先级勾选/新增弹窗） =====
		const TODO_ICONS = {
			list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
			clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v4l3 2",
			calendar: "M3 4h18v18H3V4zm13-2v4M8 2v4M3 10h18",
			check: "M20 6L9 17l-5-5",
			plus: "M12 5v14M5 12h14"
		};
		function TodosPage() {
			const [view, setView] = useState("all");
			const [category, setCategory] = useState("");
			const [items, setItems] = useState([]);
			const [stats, setStats] = useState(null);
			const [modal, setModal] = useState(false);
			const [editId, setEditId] = useState(null);
			const [form, setForm] = useState({ title: "", priority: "mid", category: "工作", due: "today" });
			const [hoverId, setHoverId] = useState(null);
			const [catOpen, setCatOpen] = useState(false);
			const [catDraft, setCatDraft] = useState("");
			const [q, setQ] = useState("");
			const [sortBy, setSortBy] = useState("smart");
			const [err, setErr] = useState(null);

			const load = useCallback(() => {
				// v3.30：一次拉全量（view=all 现在真的返回全部），筛选/统计都在本地算——
				// 旧实现发 5 个请求、还把 all(仅未完成)+done 拼起来，切换瞬间会出现重复行。
				api("/tidywork-api/todos?view=all")
					.then((list) => {
						const all = Array.isArray(list) ? list : [];
						const today = ymd(new Date());
						const wk = weekRangeClient(today);
						const doneList = all.filter((t) => t.done);
						const weekDone = doneList.filter((t) => { const d = dueDateClient(t.due, today); return !!d && d >= wk.start && d <= wk.end; });
						const weekOpen = all.filter((t) => { const d = dueDateClient(t.due, today); return !t.done && !!d && d >= wk.start && d <= wk.end; });
						const catCounts = {};
						all.forEach((t) => {
							if (t.category) catCounts[t.category] = (catCounts[t.category] || 0) + 1;
						});
						setStats({
							all: all.length,
							today: all.filter((t) => dueDateClient(t.due, today) === today).length,
							week: weekDone.length + weekOpen.length,
							late: all.filter((t) => { const d = dueDateClient(t.due, today); return !t.done && !!d && d < today; }).length,
							done: doneList.length,
							weekDone: weekDone.length,
							rate: all.length ? Math.round((doneList.length / all.length) * 100) : 0,
							catCounts,
							allItems: all
						});
						setItems(all);
						setErr(null);
					})
					.catch((e) => {
						// 静默失败会把"接口挂了"显示成"暂无待办"，这里保留旧数据 + 顶部提示
						setErr((e && e.message) || "加载待办失败");
					});
			}, []);
			useEffect(() => {
				load();
			}, [load]);

			const titles = { all: "全部待办", today: "今天", week: "本周", late: "逾期", done: "已完成", category: category || "分类" };
			const setViewTo = (v, cat) => {
				setView(v);
				setCategory(cat || "");
			};
			const toggle = (id, done) => {
				api("/tidywork-api/todos/" + id, { method: "PATCH", body: JSON.stringify({ done: !!done }) })
					.then(() => {
						toast(done ? "已完成" : "已恢复未完成", done ? { action: "撤销", onAction: () => toggle(id, false) } : null);
						load();
					})
					.catch((e) => toast(e.message));
			};
			const remove = (it) => {
				// v3.30：直接删 + toast 撤销（原先是"点两次才算删"，既慢又容易误删）
				api("/tidywork-api/todos/" + it.id, { method: "DELETE" })
					.then((removed) => {
						toast("已删除：" + it.title, {
							action: "撤销",
							onAction: () => {
								const src = removed && removed.title ? removed : it;
								api("/tidywork-api/todos", {
									method: "POST",
									body: JSON.stringify({ title: src.title, priority: src.priority, category: src.category, due: src.due, done: !!src.done })
								}).then(load).catch((e) => toast(e.message));
							}
						});
						load();
					})
					.catch((e) => toast(e.message));
			};
			const openAdd = () => {
				// v3.30：统一下到 TidyWork 今日会话（自然语言建待办）；拿不到宿主服务时退回弹窗
				openWorkItem(() => {
					setEditId(null);
					setForm({ title: "", priority: "mid", category: "工作", due: "today" });
					setModal(true);
				});
			};
			const openEdit = (it) => {
				setEditId(it.id);
				setForm({ title: it.title, priority: it.priority || "mid", category: it.category || "工作", due: it.due === "none" ? "none" : it.due || "today" });
				setModal(true);
			};
			const newCategory = () => {
				// 不用 prompt()：桌面端各平台的原生输入框表现不一致，统一走自己的弹窗
				setCatDraft("");
				setCatOpen(true);
			};
			const commitCategory = () => {
				const name = catDraft.trim().slice(0, 12);
				if (!name) return;
				setCatOpen(false);
				setForm((f) => Object.assign({}, f, { category: name }));
				setEditId(null);
				setModal(true);
			};
			const save = () => {
				if (!form.title.trim()) {
					toast("请输入待办内容");
					return;
				}
				const payload = {
					title: form.title.trim(),
					priority: form.priority,
					category: form.category.trim() || "工作",
					due: form.due === "none" ? "none" : form.due
				};
				const req = editId
					? api("/tidywork-api/todos/" + editId, { method: "PATCH", body: JSON.stringify(payload) })
					: api("/tidywork-api/todos", { method: "POST", body: JSON.stringify(payload) });
				req.then(() => {
					setModal(false);
					setEditId(null);
					setForm({ title: "", priority: "mid", category: "工作", due: "today" });
					toast(editId ? "待办已更新" : "待办已创建");
					load();
				}).catch((e) => toast(e.message));
			};
			// —— 排序：统一规则是先未完成、后已完成，再按选定维度 ——
			const PRIO_W = { high: 0, mid: 1, low: 2 };
			// 截止日折算成"距今天数"：today=0、tomorrow=1、week=5、具体日期按天数差（负数即逾期）
			const dueDays = (t) => {
				const d = String(t.due || "");
				if (d === "today") return 0;
				if (d === "tomorrow") return 1;
				if (d === "week") return 5;
				if (!d || d === "none") return 9999;
				const p = d.split("-");
				if (p.length !== 3) return 9999;
				const dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
				if (isNaN(dt.getTime())) return 9999;
				const now = new Date();
				return Math.round((new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
			};
			const prioW = (t) => (PRIO_W[t.priority] != null ? PRIO_W[t.priority] : 1);
			const doneW = (t) => (t.done ? 1 : 0);
			const byTitle = (a, b) => String(a.title || "").localeCompare(String(b.title || ""), "zh");
			const CMP = {
				smart: (a, b) => doneW(a) - doneW(b) || prioW(a) - prioW(b) || dueDays(a) - dueDays(b),
				due: (a, b) => doneW(a) - doneW(b) || dueDays(a) - dueDays(b) || prioW(a) - prioW(b),
				prio: (a, b) => doneW(a) - doneW(b) || prioW(a) - prioW(b) || dueDays(a) - dueDays(b),
				title: (a, b) => doneW(a) - doneW(b) || byTitle(a, b),
				created: (a, b) => doneW(a) - doneW(b) // items 本身即创建顺序
			};
			// —— 搜索：标题 / 分类 / 截止文案，大小写不敏感 ——
			const kw = q.trim().toLowerCase();
			// v3.30：view 筛选从前端算（服务端只负责"全部"），口径与服务端 view 一致
			const todayKey = ymd(new Date());
			const wk = weekRangeClient(todayKey);
			const inView = (t) => {
				const d = dueDateClient(t.due, todayKey);
				if (view === "done") return !!t.done;
				if (view === "all") return true;
				if (view === "today") return d === todayKey;
				if (view === "late") return !t.done && !!d && d < todayKey;
				if (view === "week") return !!d && d >= wk.start && d <= wk.end;
				if (view === "category") return t.category === category;
				return true;
			};
			const inQuery = (t) => (String(t.title || "") + " " + String(t.category || "") + " " + String(DUE_LABEL[t.due] || t.due || "")).toLowerCase().indexOf(kw) !== -1;
			const matched = items.filter((t) => inView(t) && (!kw || inQuery(t)));
			const sortedItems = matched.slice().sort(CMP[sortBy] || CMP.smart);
			// 分类栏：固定三分类 + 数据中出现过的其他分类
			const allItems = (stats && stats.allItems) || [];
			const extraCats = [];
			allItems.forEach((t) => {
				if (t.category && ["工作", "个人", "学习"].indexOf(t.category) === -1 && extraCats.indexOf(t.category) === -1) extraCats.push(t.category);
			});
			const catList = ["工作", "个人", "学习"].concat(extraCats);

			const catDot = (name) => ({ 工作: C.accent, 个人: C.success, 学习: C.warning }[name] || C.text2);

			return h(
				"div",
				{ className: "tw-frame-page", style: S.page },
				h(
					"div",
					{ style: S.sideBar },
					h("div", { style: S.sectionLabel }, "智能视图"),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, view === "all" && S.menuItemActive), onClick: () => setViewTo("all") },
						h("svg", { style: Object.assign({}, S.menuIcon, view === "all" && S.menuIconActive), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.list })),
						h("span", null, "全部待办"),
						h("span", { style: S.count }, stats ? stats.all : 0)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, view === "today" && S.menuItemActive), onClick: () => setViewTo("today") },
						h("svg", { style: Object.assign({}, S.menuIcon, view === "today" && S.menuIconActive), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.clock })),
						h("span", null, "今天"),
						h("span", { style: S.countToday }, stats ? stats.today : 0)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, view === "week" && S.menuItemActive), onClick: () => setViewTo("week") },
						h("svg", { style: Object.assign({}, S.menuIcon, view === "week" && S.menuIconActive), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.calendar })),
						h("span", null, "本周"),
						h("span", { style: S.count }, stats ? stats.week : 0)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, view === "late" && S.menuItemActive), onClick: () => setViewTo("late") },
						h("svg", { style: Object.assign({}, S.menuIcon, view === "late" && S.menuIconActive), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.clock })),
						h("span", null, "逾期"),
						h("span", { style: Object.assign({}, S.count, stats && stats.late ? { color: C.danger } : null) }, stats ? stats.late : 0)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, view === "done" && S.menuItemActive), onClick: () => setViewTo("done") },
						h("svg", { style: Object.assign({}, S.menuIcon, view === "done" && S.menuIconActive), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.check })),
						h("span", null, "已完成"),
						h("span", { style: S.count }, stats ? stats.done : 0)
					),
					h("div", { style: Object.assign({}, S.sectionLabel, { paddingTop: 16 }) }, "分类"),
					catList.map((cat) =>
						h(
							"button",
							{ key: cat, style: Object.assign({}, S.menuItem, view === "category" && category === cat && S.menuItemActive), onClick: () => setViewTo("category", cat) },
							h("span", { style: { width: 8, height: 8, borderRadius: 2, background: catDot(cat), flexShrink: 0 } }),
							h("span", null, cat),
							h("span", { style: S.count }, stats && stats.catCounts ? stats.catCounts[cat] || 0 : 0)
						)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, { color: C.text1 }), onClick: newCategory },
						h("svg", { style: Object.assign({}, S.menuIcon, { width: 16, height: 16 }), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.plus })),
						h("span", null, "新建分类")
					)
				),
				h(
					"div",
					{ style: S.right },
					h(
						"div",
						{ style: S.statGrid },
						h(
							"div",
							{ style: S.statCard },
							h("div", { style: S.statLabel }, "今日待办"),
							h("div", { style: Object.assign({}, S.statValue, { color: C.danger }) }, stats ? stats.today : 0)
						),
						h(
							"div",
							{ style: S.statCard },
							h("div", { style: S.statLabel }, "本周已完成"),
							h("div", { style: Object.assign({}, S.statValue, { color: C.success }) }, stats ? stats.weekDone : 0)
						),
						h(
							"div",
							{ style: S.statCard },
							h("div", { style: S.statLabel }, "完成率"),
							h("div", { style: Object.assign({}, S.statValue, { color: C.accent }) }, stats ? stats.rate + "%" : "0%"),
							h(
								"div",
								{ style: { height: 4, borderRadius: 2, background: C.hover, marginTop: 8, overflow: "hidden" } },
								h("div", { style: { height: "100%", width: (stats ? stats.rate : 0) + "%", background: C.accent, borderRadius: 2, transition: "width .3s" } })
							)
						)
					),
					h(
						"div",
						{ style: S.headRow },
						h("span", { style: S.viewTitle }, titles[view] || "待办"),
						kw ? h("span", { style: { fontSize: 12, color: C.text2, marginRight: "auto", marginLeft: 10 } }, "匹配 " + sortedItems.length + " 条") : null,
						h(Chip, { active: true, onClick: openAdd }, "+ 新增")
					),
					err
						? h(
								"div",
								{ role: "alert", style: Object.assign({}, S.banner, { background: tint(C.danger, 10), color: C.danger, borderColor: tint(C.danger, 26) }) },
								"接口异常：" + err + "（下方为上次加载的数据）",
								h("button", { type: "button", style: S.bannerBtn, onClick: load }, "重试")
							)
						: null,
					h(
						"div",
						{ style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 12 } },
						h("input", {
							style: Object.assign({}, S.input, { flex: 1, padding: "8px 12px", fontSize: 13 }),
							placeholder: "搜索待办（标题 / 分类 / 截止）",
							value: q,
							onChange: (e) => setQ(e.target.value)
						}),
						h(
							"select",
							{ style: Object.assign({}, S.input, { width: 120, padding: "8px 10px", fontSize: 13, cursor: "pointer" }), value: sortBy, onChange: (e) => setSortBy(e.target.value) },
							h("option", { value: "smart" }, "智能排序"),
							h("option", { value: "due" }, "按截止日"),
							h("option", { value: "prio" }, "按优先级"),
							h("option", { value: "title" }, "按标题"),
							h("option", { value: "created" }, "按创建顺序")
						),
						kw ? h(Chip, { onClick: () => setQ("") }, "清除") : null
					),
					h(
						"div",
						{ style: S.card },
						sortedItems.length === 0
							? kw
								? h(
										"div",
										{ style: { padding: "48px 24px", textAlign: "center", color: C.text2 } },
										h("div", { style: { fontSize: 14, fontWeight: 500, color: C.text1, marginBottom: 4 } }, "没有匹配的待办"),
										h("div", { style: { fontSize: 12, marginBottom: 16 } }, "关键词「" + q.trim() + "」在这个视图里没有命中"),
										h(Chip, { onClick: () => setQ("") }, "清除搜索")
									)
								: h(
									"div",
									{ style: { padding: "48px 24px", textAlign: "center", color: C.text2 } },
									h(
										"svg",
										{ width: 44, height: 44, viewBox: "0 0 24 24", fill: "none", stroke: C.border, strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", style: { marginBottom: 12 } },
										h("path", { d: TODO_ICONS.list })
									),
									h("div", { style: { fontSize: 14, fontWeight: 500, color: C.text1, marginBottom: 4 } }, "暂无待办"),
									h("div", { style: { fontSize: 12, marginBottom: 16 } }, "点右上角「+ 新增」，或用右下角的语音按钮说一句话创建"),
									h(Chip, { active: true, onClick: openAdd }, "+ 新增")
								)
							: sortedItems.map((it, idx) =>
									h(
										"div",
										{
											key: it.id,
											onMouseEnter: () => setHoverId(it.id),
											onMouseLeave: () => setHoverId(null),
											style: { padding: "14px 16px", display: "flex", alignItems: "center", gap: 12, borderBottom: idx < sortedItems.length - 1 ? "1px solid " + C.borderLight : "none", background: hoverId === it.id ? C.hover : "transparent", transition: "background .15s" }
										},
										it.done
											? h(
													"button",
													{
														type: "button",
														title: "取消完成",
														"aria-label": "取消完成：" + it.title,
														"aria-pressed": true,
														className: "tw-check",
														style: { width: 20, height: 20, background: C.success, border: "none", borderRadius: 6, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 },
														onClick: () => toggle(it.id, false)
													},
													h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: C.onAccent, strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }, h("polyline", { points: "20 6 9 17 4 12" }))
												)
											: h("button", {
													type: "button",
													title: "标记完成",
													"aria-label": "标记完成：" + it.title,
													"aria-pressed": false,
													className: "tw-check",
													style: { width: 20, height: 20, border: "2px solid " + (PRIORITY[it.priority] || PRIORITY.mid).color, background: "transparent", borderRadius: 6, flexShrink: 0, cursor: "pointer", padding: 0 },
													onClick: () => toggle(it.id, true)
												}),
										h(
											"div",
											{ style: { flex: 1 } },
											h("div", { style: { fontSize: 14, fontWeight: 500, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.text2 : "inherit" } }, it.title),
											h(
												"div",
												{ style: { fontSize: 12, color: C.text2, marginTop: 4, display: "flex", gap: 8, alignItems: "center" } },
												h("span", { style: { padding: "1px 6px", background: tint(C.danger, 12), color: (PRIORITY[it.priority] || PRIORITY.mid).color, borderRadius: 4, fontSize: 11 } }, (PRIORITY[it.priority] || PRIORITY.mid).label),
												h(MailTag, { source: it.source }),
												h("span", { style: { padding: "1px 6px", background: C.accentSoft, color: C.accent, borderRadius: 4, fontSize: 11 } }, esc(it.category || "")),
												h("span", null, esc(DUE_LABEL[it.due] || it.due || "")),
												h("button", { type: "button", style: S.linkBtn, onClick: () => openEdit(it) }, "编辑"),
												h("button", { type: "button", style: Object.assign({}, S.linkBtn, { color: C.danger }), onClick: () => remove(it) }, "删除")
											)
										)
									)
								)
					)
				),
				h(
					Modal,
					{ open: modal, title: editId ? "编辑待办" : "新增待办", onClose: () => { setModal(false); setEditId(null); } },
					h(
						Field,
						{ label: "待办内容" },
						h("input", { style: S.input, maxLength: 60, placeholder: "例如 写周报", value: form.title, onChange: (e) => setForm((f) => Object.assign({}, f, { title: e.target.value })) })
					),
					h(
						Field,
						{ label: "优先级" },
						h(
							"select",
							{ style: S.select, value: form.priority, onChange: (e) => setForm((f) => Object.assign({}, f, { priority: e.target.value })) },
							h("option", { value: "high" }, "高优先级"),
							h("option", { value: "mid" }, "中优先级"),
							h("option", { value: "low" }, "低优先级")
						)
					),
					h(
						Field,
						{ label: "分类" },
						h("input", { style: S.input, maxLength: 20, placeholder: "工作 / 个人 / 学习，可输入新分类", value: form.category, onChange: (e) => setForm((f) => Object.assign({}, f, { category: e.target.value })) })
					),
					h(
						Field,
						{ label: "截止" },
						// v3.22：截止从固定四个选项改成日历选择，可直接点具体日期（简写最近仍在弹层底部保留）
						h(DuePicker, { value: form.due, onChange: (due) => setForm((f) => Object.assign({}, f, { due: due })) })
					),
					h(
						"div",
						{ style: S.footRow },
						h(Btn, { onClick: () => { setModal(false); setEditId(null); } }, "取消"),
						h(Btn, { primary: true, onClick: save }, editId ? "保存" : "创建")
					)
				),
			h(
				Modal,
				{ open: catOpen, title: "新建分类", onClose: () => setCatOpen(false) },
				h(
					Field,
					{ label: "分类名称" },
					h("input", { style: S.input, maxLength: 12, autoFocus: true, placeholder: "例如 项目A / 读书", value: catDraft, onChange: (e) => setCatDraft(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") commitCategory(); } })
				),
				h(
					"div",
					{ style: S.footRow },
					h(Btn, { onClick: () => setCatOpen(false) }, "取消"),
					h(Btn, { primary: true, onClick: commitCategory }, "下一步")
				)
			)
			);
		}

		// ===== 会议（复刻 8080：月历/日视图/周条带/时间线/新建删除弹窗） =====
		function MeetingsPage() {
			const now0 = new Date();
			const [month, setMonth] = useState(now0.getFullYear() + "-" + String(now0.getMonth() + 1).padStart(2, "0"));
			const [allMeets, setAllMeets] = useState([]);
			const [dayView, setDayView] = useState(null);
			const [modal, setModal] = useState(false);
			const [editId, setEditId] = useState(null);
			const [err, setErr] = useState(null);
			const [tick, setTick] = useState(0);
			const [form, setForm] = useState({ title: "", date: "", start: "09:00", end: "10:00", location: "", participants: "1" });

			// v3.30：一次拿全量（月历、日视图、周条带共用一份），切月份不再重发请求，
			// 也不会因为"只拉当月"导致跨月的那一周少算几天。
			const load = useCallback(() => {
				api("/tidywork-api/meetings")
					.then((list) => {
						setAllMeets(Array.isArray(list) ? list : []);
						setErr(null);
					})
					.catch((e) => {
						// 失败不伪装成"没有会议"：保留上次数据 + 顶部横幅
						setErr((e && e.message) || "加载会议失败");
					});
			}, []);
			useEffect(() => {
				load();
			}, [load]);
			// 每 60 秒重算一次「进行中 / 已结束」（tick 触发重渲染，状态本身是纯函数算的）
			useEffect(() => {
				const timer = setInterval(() => setTick((t) => t + 1), 60000);
				return () => clearInterval(timer);
			}, []);

			const [y, mon] = month.split("-").map(Number);
			const monthTitle = y + "年" + mon + "月";
			// 按天分组：只取当前月的会议，状态用 meetingStatus 现算（tick 变化即刷新）
			const byDay = (() => {
				const map = {};
				allMeets.forEach((meet) => {
					if (String(meet.date || "").slice(0, 7) !== month) return;
					const day = Number(String(meet.date).slice(8, 10));
					if (!day) return;
					(map[day] = map[day] || []).push(Object.assign({}, meet, meetingStatus(meet)));
				});
				return map;
			})();
			const totalMeetings = Object.keys(byDay).reduce((n, d) => n + (byDay[d] || []).length, 0);

			const today = new Date();
			const todayCount = today.getFullYear() === y && today.getMonth() + 1 === mon ? (byDay[today.getDate()] || []).length : 0;
			const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
			const tomorrowCount = tomorrow.getFullYear() === y && tomorrow.getMonth() + 1 === mon ? (byDay[tomorrow.getDate()] || []).length : 0;
			const todayLabel = "今天 · 周" + WEEK_DAYS[(today.getDay() + 6) % 7];
			const tomorrowLabel = "明天 · 周" + WEEK_DAYS[(tomorrow.getDay() + 6) % 7];

			const shift = (offset) => {
				const d = new Date(y, mon - 1 + offset, 1);
				setMonth(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
			};
			const goToday = () => {
				const t = new Date();
				setMonth(t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"));
				setDayView(null);
			};
			const selectDate = (day) => setDayView(day);
			const backToMonth = () => setDayView(null);
			const openAdd = () => {
				// v3.30：统一下到 TidyWork 今日会话；拿不到宿主服务时退回弹窗
				openWorkItem(() => {
					const t = new Date();
					const prefill = t.getFullYear() === y && t.getMonth() + 1 === mon ? ymd(t) : y + "-" + String(mon).padStart(2, "0") + "-01";
					setForm({ title: "", date: prefill, startTime: "09:00", endTime: "10:00", location: "", participants: "1" });
					setModal(true);
				});
			};
			// 编辑：直接开弹窗并回填原值（新建才走"跳会话用自然语言建"那条路）
			const openEdit = (m) => {
				setEditId(m.id);
				setForm({
					title: m.title || "",
					date: m.date || "",
					start: m.startTime || m.time || "09:00",
					end: m.endTime || "",
					location: m.location || "",
					participants: String(m.participants == null ? 1 : m.participants)
				});
				setModal(true);
			};
			const save = () => {
				if (!form.title.trim()) {
					toast("请输入会议标题");
					return;
				}
				if (!form.date) {
					toast("请选择会议日期");
					return;
				}
				// v3.30：改成结构化的 startTime / endTime，服务端按区间算状态（旧字段 time+duration 仅兼容读取）
				const startTime = form.start || "09:00";
				const endTime = form.end || "";
				if (endTime && endTime <= startTime) {
					toast("结束时间要晚于开始时间");
					return;
				}
				const payload = {
					title: form.title.trim(),
					date: form.date,
					startTime,
					endTime,
					location: form.location.trim() || "线上会议",
					participants: parseInt(form.participants || "1", 10)
				};
				const req = editId
					? api("/tidywork-api/meetings/" + editId, { method: "PATCH", body: JSON.stringify(payload) })
					: api("/tidywork-api/meetings", { method: "POST", body: JSON.stringify(payload) });
				req.then(() => {
					const wasEdit = !!editId;
					setModal(false);
					setEditId(null);
					toast(wasEdit ? "会议已更新" : "会议已创建");
					// 日期改到别的月份时跟着跳过去，否则停在原地刷新
					const m2 = String(payload.date).slice(0, 7);
					if (m2 && m2 !== month) setMonth(m2);
					load();
				})
					.catch((e) => toast(e.message));
			};
			// 会议 → 待办：把这场会的跟进项落到待办清单（标题带上下文，日期沿用会议日期）
			const todoFromMeeting = (m) => {
				api("/tidywork-api/todos", {
					method: "POST",
					body: JSON.stringify({ title: "会后跟进：" + m.title, due: m.date, category: "会议" })
				})
					.then((created) => {
						// api() 已经直接返回资源对象，之前取 r.data 拿到的是 undefined
						const t = created || {};
						toast("已生成待办：" + (t.title || m.title));
						load();
					})
					.catch((e) => toast(e.message));
			};
			// 邮箱邀请：同意 / 拒绝（服务端交给引擎回执，再同步一次看板；拒绝的会从看板移出）
			const sendRsvp = (m, action) => {
				api("/tidywork-api/mail/rsvp", { method: "POST", body: JSON.stringify({ id: m.id, action: action }) })
					.then(() => {
						toast(action === "accept" ? "已确认参加：" + m.title : "已拒绝并移出：" + m.title);
						load();
					})
					.catch((e) => toast(e.message));
			};
			const remove = (m) => {				// 不用 confirm()：删完用 toast 撤销
				api("/tidywork-api/meetings/" + m.id, { method: "DELETE" })
					.then((removed) => {
						const src = removed && removed.title ? removed : m;
						toast("已删除：" + src.title, {
							action: "撤销",
							onAction: () =>
								api("/tidywork-api/meetings", {
									method: "POST",
									body: JSON.stringify({ title: src.title, date: src.date, startTime: src.startTime || src.time, endTime: src.endTime, location: src.location, participants: src.participants })
								}).then(() => load()).catch((e) => toast(e.message))
						});
						load();
					})
					.catch((e) => toast(e.message));
			};

			// 月历格子（8080 renderMonthGrid 逻辑）
			const first = new Date(y, mon - 1, 1);
			const daysInMonth = new Date(y, mon, 0).getDate();
			const lead = (first.getDay() + 6) % 7;
			const prevDays = new Date(y, mon - 1, 0).getDate();
			const todayIsCur = today.getFullYear() === y && today.getMonth() + 1 === mon;
			const lastRowCells = (daysInMonth + lead) % 7 || 7;
			const cells = [];
			for (let i = 0; i < lead; i++) {
				cells.push(h("div", { key: "p" + i, style: { minHeight: 90, padding: 8, borderRight: "1px solid " + C.borderLight, borderBottom: "1px solid " + C.borderLight, opacity: 0.4, boxSizing: "border-box" } }, h("div", { style: { fontSize: 12, fontWeight: 500 } }, prevDays - lead + 1 + i)));
			}
			for (let d = 1; d <= daysInMonth; d++) {
				const meets = byDay[d] || [];
				const isToday = todayIsCur && d === today.getDate();
				const lastCol = (lead + d) % 7 === 0;
				const lastRow = d > daysInMonth - lastRowCells;
				cells.push(
					h(
						"div",
						{
							key: d,
							style: { minHeight: 90, padding: 8, cursor: "pointer", boxSizing: "border-box", borderRight: lastCol ? "none" : "1px solid " + C.borderLight, borderBottom: lastRow ? "none" : "1px solid " + C.borderLight, background: isToday ? C.accentSoft : "transparent" },
							onClick: () => selectDate(d)
						},
						h("div", { style: { width: 24, height: 24, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, marginBottom: 4, background: isToday ? C.accent : "transparent", color: isToday ? C.onAccent : "inherit" } }, d),
						meets.slice(0, 2).map((m) =>
							h(
								"div",
								{ key: m.id, style: { fontSize: 11, padding: "1px 4px", borderRadius: 3, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: m.status === "done" ? C.text2 : C.accent, background: m.status === "done" ? "transparent" : tint(C.accent, 10) } },
								String(m.startTime || m.time || "") + " " + m.title
							)
						),
						meets.length > 2 && h("div", { style: { fontSize: 10, color: C.text2 } }, "+" + (meets.length - 2) + " 更多")
					)
				);
			}

			// 周条带（日视图）
			const strip = [];
			if (dayView != null) {
				const base = new Date(y, mon - 1, dayView);
				const monday = new Date(base);
				monday.setDate(base.getDate() - ((base.getDay() + 6) % 7));
				// 这一周可能跨月：按真实日期筛，不能只看"几号"（否则 31 号和 1 号会撞在一起）
				for (let i = 0; i < 7; i++) {
					const dt = new Date(monday);
					dt.setDate(monday.getDate() + i);
					const dayKey = ymd(dt);
					const d = dt.getDate();
					const meets = allMeets.filter((m) => String(m.date || "").slice(0, 10) === dayKey).map((m) => Object.assign({}, m, meetingStatus(m)));
					const isSel = dayKey === ymd(base);
					strip.push(
						h(
							"div",
							{ key: dayKey, style: { padding: 8, borderRadius: 8, cursor: "pointer", textAlign: "center", background: isSel ? C.accentSoft : C.hover, border: isSel ? "1px solid " + C.accent : "1px solid transparent", boxSizing: "border-box" }, onClick: () => selectDate(d) },
							h("div", { style: { fontSize: 11, color: C.text2, marginBottom: 2 } }, "周" + WEEK_DAYS[i]),
							h("div", { style: { fontSize: 16, fontWeight: isSel ? 700 : 500, color: isSel ? C.accent : C.text0, marginBottom: 4 } }, d),
							h("div", { style: { fontSize: 10, color: meets.length > 0 ? C.accent : C.text2 } }, meets.length > 0 ? meets.length + " 场" : "—")
						)
					);
				}
			}

			// 侧边栏「本月会议」前 3 条
			const sidebarMeetings = [];
			Object.keys(byDay)
				.map((d) => ({ day: parseInt(d, 10), meets: byDay[d] }))
				.sort((a, b) => a.day - b.day)
				.forEach(({ day, meets }) => {
					meets.forEach((m) => sidebarMeetings.push({ day, m }));
				});
			const meetColors = [C.accent, C.success, C.warning, C.danger];

			return h(
				"div",
				{ className: "tw-frame-page", style: S.page },
				h(
					"div",
					{ style: S.sideBar },
					h("div", { style: S.sectionLabel }, "快速导航"),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, dayView != null && dayView === today.getDate() && today.getFullYear() === y && today.getMonth() + 1 === mon && S.menuItemActive), onClick: () => today.getFullYear() === y && today.getMonth() + 1 === mon && selectDate(today.getDate()) },
						h("svg", { style: S.menuIcon, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.clock })),
						h("span", null, todayLabel),
						h("span", { style: S.countAccent }, todayCount)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, dayView != null && dayView === tomorrow.getDate() && tomorrow.getFullYear() === y && tomorrow.getMonth() + 1 === mon && S.menuItemActive), onClick: () => tomorrow.getFullYear() === y && tomorrow.getMonth() + 1 === mon && selectDate(tomorrow.getDate()) },
						h("svg", { style: S.menuIcon, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.calendar })),
						h("span", null, tomorrowLabel),
						h("span", { style: S.count }, tomorrowCount)
					),
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, dayView == null && S.menuItemActive), onClick: backToMonth },
						h("svg", { style: Object.assign({}, S.menuIcon, dayView == null && S.menuIconActive), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.calendar })),
						h("span", null, "月历视图"),
						h("span", { style: S.count }, totalMeetings)
					),
					h("div", { style: Object.assign({}, S.sectionLabel, { paddingTop: 16 }) }, "本月会议"),
					h(
						"div",
						null,
						sidebarMeetings.length === 0
							? h("div", { style: { padding: 8, fontSize: 12, color: C.text2 } }, "本月暂无会议")
							: sidebarMeetings.slice(0, 3).map((it, idx) =>
									h(
										"button",
										{ key: it.m.id, style: Object.assign({}, S.menuItem, { fontSize: 13 }), onClick: () => selectDate(it.day) },
										h("span", { style: { width: 6, height: 6, borderRadius: "50%", background: meetColors[idx % 4], flexShrink: 0 } }),
										h(
											"div",
											{ style: { flex: 1, textAlign: "left", minWidth: 0 } },
											h("div", { style: { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, it.m.title),
											h("div", { style: { fontSize: 11, color: C.text2 } }, mon + "月" + it.day + "日 " + meetingTimeText(it.m))
										)
									)
								)
					)
				),
				h(
					"div",
					{ style: S.right },
					err
						? h(
								"div",
								{ role: "alert", style: Object.assign({}, S.banner, { background: tint(C.danger, 10), color: C.danger, borderColor: tint(C.danger, 26) }) },
								"会议接口异常：" + err + "（下方为上次加载的数据）",
								h("button", { type: "button", style: S.bannerBtn, onClick: load }, "重试")
							)
						: null,
					dayView == null
						? h(
								"div",
								null,
								h(
									"div",
									{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 } },
									h(
										"div",
										null,
										h("div", { style: { fontSize: 18, fontWeight: 600 } }, monthTitle),
										h("div", { style: { fontSize: 13, color: C.text2, marginTop: 2 } }, "点击任意日期查看当天详情")
									),
									h(
										"div",
										{ style: { display: "flex", gap: 8, alignItems: "center" } },
										h(Chip, { onClick: () => shift(-1) }, "‹"),
										h(Chip, { onClick: goToday }, "今天"),
										h(Chip, { onClick: () => shift(1) }, "›"),
										h(Chip, { active: true, onClick: openAdd }, "+ 新建")
									)
								),
								h(
									"div",
									{ style: Object.assign({}, S.card, { overflow: "hidden" }) },
									h(
										"div",
										{ style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", borderBottom: "1px solid " + C.border, background: C.hover } },
										WEEK_DAYS.map((w) => h("div", { key: w, style: { padding: 10, textAlign: "center", fontSize: 12, fontWeight: 600, color: C.text2 } }, w))
									),
									h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)" } }, cells)
								)
							)
						: h(
								"div",
								null,
								h(
									"div",
									{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 } },
									h(
										"div",
										{ style: { display: "flex", alignItems: "center", gap: 12 } },
										h(Chip, { onClick: backToMonth }, "‹ 返回月历"),
										h(
											"div",
											null,
											h("div", { style: { fontSize: 18, fontWeight: 600 } }, mon + "月" + dayView + "日 周" + WEEK_DAYS[(new Date(y, mon - 1, dayView).getDay() + 6) % 7]),
											h("div", { style: { fontSize: 13, color: C.text2, marginTop: 2 } }, (todayIsCur && dayView === today.getDate() ? "今天 · " : "") + (byDay[dayView] || []).length + " 场会议")
										)
									),
									h(Chip, { active: true, onClick: openAdd }, "+ 新建")
								),
								h(
									"div",
									{ style: Object.assign({}, S.card, { padding: 12, marginBottom: 20 }) },
									h("div", { style: { fontSize: 12, fontWeight: 600, color: C.text2, marginBottom: 12, padding: "0 4px" } }, "本周安排"),
									h("div", { style: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 } }, strip)
								),
								h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 12 } }, "当天日程"),
								h(
									"div",
									{ style: { position: "relative", paddingLeft: 60 } },
									(byDay[dayView] || []).length === 0
										? h(
												"div",
												{ style: { padding: 40, textAlign: "center", color: C.text2, background: C.hover, borderRadius: 12 } },
												h("div", { style: { fontSize: 14, marginBottom: 4 } }, "当天没有会议安排"),
												h("div", { style: { fontSize: 12 } }, "点击右上角「+ 新建」创建会议")
											)
										: h(
												"div",
												null,
												h("div", { style: { position: "absolute", left: 70, top: 0, bottom: 0, width: 2, background: C.border } }),
												(byDay[dayView] || []).map((m) => {
													let borderColor = C.border;
													let badgeBg = C.hover;
													let badgeColor = C.text1;
													let dotColor = C.text2;
													if (m.status === "now") {
														borderColor = C.accent;
														badgeBg = C.accentSoft;
														badgeColor = C.accent;
														dotColor = C.accent;
													}
													return h(
														"div",
														{ key: m.id, style: { position: "relative", marginBottom: 20, opacity: m.status === "done" ? 0.7 : 1 } },
														h("div", { style: { position: "absolute", left: -60, top: 0, width: 50, textAlign: "right", fontSize: 12, color: m.status === "now" ? C.accent : C.text2, fontWeight: 500 } }, String(m.startTime || m.time || "")),
														h("div", { style: { position: "absolute", left: -22, top: 4, width: 12, height: 12, borderRadius: "50%", background: dotColor, border: "2px solid " + C.main } }),
														h(
															"div",
															{ style: { background: C.main, border: "1px solid " + borderColor, borderRadius: 12, padding: 16 } },
															h(
																"div",
																{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
																h("div", { style: { fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, minWidth: 0 } }, m.title, h(MailTag, { source: m.source })),
																h(
																	"span",
																	{ style: { display: "flex", gap: 8, alignItems: "center" } },
																	h("span", { style: { fontSize: 11, padding: "2px 8px", background: badgeBg, color: badgeColor, borderRadius: 10 } }, m.statusText),
																	m.rsvp === "confirmed" ? h("span", { title: "已在邮件里确认参加", style: { fontSize: 11, padding: "2px 8px", background: tint(C.success, 12), color: C.success, borderRadius: 10 } }, "已确认参加") : null,
																	m.rsvp === "pending" ? h("button", { type: "button", title: "确认参加这场会议（更新看板状态，不发邮件）", style: Object.assign({}, S.linkBtn, { color: C.success, fontWeight: 600 }), onClick: () => sendRsvp(m, "accept") }, "接受") : null,
																	m.rsvp === "pending" ? h("button", { type: "button", title: "拒绝这场会议并从看板移出", style: Object.assign({}, S.linkBtn, { color: C.danger }), onClick: () => sendRsvp(m, "decline") }, "拒绝") : null,
																	h("button", { type: "button", style: Object.assign({}, S.linkBtn, { color: C.accent }), onClick: () => openEdit(m) }, "编辑"),
																	h("button", { type: "button", style: Object.assign({}, S.linkBtn, { color: C.danger }), onClick: () => todoFromMeeting(m) }, "转待办"),
																	h("button", { type: "button", style: Object.assign({}, S.linkBtn, { color: C.text2 }), onClick: () => remove(m) }, "删除")
																)
															),
															h("div", { style: { fontSize: 12, color: C.text2, marginBottom: 12 } }, esc(meetingTimeText(m)) + " · " + esc(m.location)),
														 h(
																"div",
																{ style: { display: "flex", gap: 16, alignItems: "center", fontSize: 12, color: C.text1 } },
																h(
																	"span",
																	{ style: { display: "flex", gap: 4, alignItems: "center" } },
																	h(
																		"svg",
																		{ width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
																		h("path", { d: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" }),
																		h("circle", { cx: 9, cy: 7, r: 4 }),
																		h("path", { d: "M23 21v-2a4 4 0 0 0-3-3.87" }),
																		h("path", { d: "M16 3.13a4 4 0 0 1 0 7.75" })
																	),
																	m.participants + " 人参会"
																)
															)
														)
													);
												})
											)
								)
							)
				),
				h(
					Modal,
					{ open: modal, title: editId ? "编辑会议" : "新建会议", onClose: () => { setModal(false); setEditId(null); } },
					h(
						Field,
						{ label: "会议标题" },
						h("input", { style: S.input, maxLength: 60, placeholder: "例如 产品规划会", value: form.title, onChange: (e) => setForm((f) => Object.assign({}, f, { title: e.target.value })) })
					),
					h(
						Field,
						{ label: "日期" },
						h("input", { style: S.input, type: "date", value: form.date, onChange: (e) => setForm((f) => Object.assign({}, f, { date: e.target.value })) })
					),
					h(
						Field,
						{ label: "开始时间" },
						h("input", { style: S.input, type: "time", value: form.start, onChange: (e) => setForm((f) => Object.assign({}, f, { start: e.target.value })) })
					),
					h(
						Field,
						{ label: "结束时间" },
						h("input", { style: S.input, type: "time", value: form.end, onChange: (e) => setForm((f) => Object.assign({}, f, { end: e.target.value })) })
					),
					h(
						Field,
						{ label: "地点" },
						h("input", { style: S.input, maxLength: 40, placeholder: "线上会议", value: form.location, onChange: (e) => setForm((f) => Object.assign({}, f, { location: e.target.value })) })
					),
					h(
						Field,
						{ label: "参会人数" },
						h("input", { style: S.input, type: "number", min: 1, max: 1000, value: form.participants, onChange: (e) => setForm((f) => Object.assign({}, f, { participants: e.target.value })) })
					),
					h(
						"div",
						{ style: S.footRow },
						h(Btn, { onClick: () => setModal(false) }, "取消"),
						h(Btn, { primary: true, onClick: save }, editId ? "保存" : "创建")
					)
				)
			);
		}

		// ===== 笔记：Markdown 富文本（v4.0）=====
		// 之前正文是一段裸 textarea，列表里的"预览"是对源码前 24 个字符硬截断。现在：
		//   1) content 仍是纯文本，但新笔记按 Markdown 存（format="markdown"），老笔记 format="text" 仍按纯文本渲染；
		//   2) 读态用插件自带的 Markdown 渲染（标题/列表/表格/代码/粗斜体/链接/图片/任务清单/引用），
		//      写态是 textarea + 工具栏 —— 不引第三方编辑器，插件继续保持零依赖直发；
		//   3) 自动保存（900ms 防抖）+ localStorage 草稿 + rev 冲突提示（AI 刚写过同一篇时不会再被静默覆盖）；
		//   4) 标签、置顶、搜索、大纲、版本历史、图片粘贴上传、勾选清单转待办、笔记内链到待办/会议。
		const DRAFT_PREFIX = "tidywork.draft.";
		const MD_CSS = [
			".tw-md{font-size:14px;line-height:1.78;color:var(--dsw-alias-label-primary,#1f2329);word-break:break-word;overflow-wrap:anywhere}",
			".tw-md h1,.tw-md h2,.tw-md h3,.tw-md h4,.tw-md h5,.tw-md h6{margin:20px 0 10px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,#1f2329)}",
			".tw-md h1{font-size:24px}.tw-md h2{font-size:20px}.tw-md h3{font-size:17px}.tw-md h4,.tw-md h5,.tw-md h6{font-size:15px}",
			".tw-md p{margin:10px 0}",
			".tw-md a{color:var(--tw-accent,#3370ff);text-decoration:none}.tw-md a:hover{text-decoration:underline}",
			".tw-md code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 7%,transparent);padding:2px 5px;border-radius:4px}",
			".tw-md pre{position:relative;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 6%,transparent);border:1px solid var(--dsw-alias-border-l1,#f0f0f0);border-radius:8px;padding:12px 14px;margin:12px 0;overflow:auto}",
			".tw-md pre code{background:none;padding:0;font-size:12.5px;line-height:1.6;white-space:pre}",
			".tw-md .tw-copy{position:absolute;top:8px;right:8px;font-size:11px;padding:2px 8px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#646a73);cursor:pointer;opacity:0;transition:opacity .15s;font-family:inherit}",
			".tw-md pre:hover .tw-copy{opacity:1}",
			".tw-md table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}",
			".tw-md th,.tw-md td{border:1px solid var(--dsw-alias-border-l2,#e5e6eb);padding:6px 10px;text-align:left;vertical-align:top}",
			".tw-md th{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 6%,transparent);font-weight:600}",
			".tw-md blockquote{margin:12px 0;padding:2px 0 2px 12px;border-left:3px solid var(--dsw-alias-border-l2,#e5e6eb);color:var(--dsw-alias-label-secondary,#646a73)}",
			".tw-md ul,.tw-md ol{margin:8px 0;padding-left:22px}",
			".tw-md li{margin:3px 0}",
			".tw-md li.tw-task{list-style:none;margin-left:-22px;display:flex;gap:8px;align-items:flex-start}",
			".tw-md .tw-check{width:15px;height:15px;flex:0 0 auto;margin-top:4px;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:4px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1;color:transparent;cursor:pointer;background:transparent}",
			'.tw-md .tw-check[data-check="1"]{background:var(--tw-accent,#3370ff);border-color:var(--tw-accent,#3370ff);color:#fff}',
			".tw-md img{max-width:100%;border-radius:8px;margin:10px 0;display:block}",
			".tw-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0);margin:18px 0}",
			".tw-plain{white-space:pre-wrap;font-size:14px;line-height:1.78;word-break:break-word}",
			".tw-tool{display:inline-flex;align-items:center;padding:4px 9px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#646a73);font-size:12.5px;cursor:pointer;font-family:inherit;line-height:1.5}",
			".tw-tool:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 6%,transparent);color:var(--dsw-alias-label-primary,#1f2329)}",
			".tw-live-b{cursor:text;border-radius:6px}",
			".tw-live-b:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 4%,transparent)}",
			".tw-live-empty{color:var(--dsw-alias-label-tertiary,#8f959e);font-size:13px;padding:20px 0;cursor:text}",
			".tw-live .tw-live-ta::placeholder{color:var(--dsw-alias-label-tertiary,#8f959e)}",
			".tw-live .tw-live-ta{font-size:14px}"
		].join("");

		/** Markdown 渲染样式一次性注入 head；DSH 重建 head 后由 applyBranding 的观察器补回。 */
		function ensureMdCss() {
			if (document.getElementById("tidywork-md-css")) return;
			const st = document.createElement("style");
			st.id = "tidywork-md-css";
			st.textContent = MD_CSS;
			document.head.appendChild(st);
		}

		function mdEscape(s) {
			return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
		}

		/** 链接白名单：内链 todo:/meeting:、站内相对路径、http(s)、mailto；其余（javascript/data 等）不渲染。 */
		function mdUrl(u) {
			const s = String(u || "").trim();
			if (!s) return "";
			if (/^(todo|meeting):/i.test(s)) return s;
			if (s.startsWith("/")) return s;
			if (/^(https?:|mailto:)/i.test(s)) return s;
			return "";
		}

		function mdImgUrl(u) {
			const s = String(u || "").trim();
			if (s.startsWith("/") && !s.startsWith("//")) return location.origin + s;
			if (/^https?:/i.test(s)) return s;
			return "";
		}

		/** 行内语法：代码 > 图片 > 链接 > 强调。代码先占位，避免后续替换破坏已生成的标签。 */
		function mdInline(raw) {
			const slots = [];
			let s = String(raw == null ? "" : raw);
			s = s.replace(/`([^`]+)`/g, (m, code) => {
				slots.push("<code>" + mdEscape(code) + "</code>");
				return "\u0000" + (slots.length - 1) + "\u0001";
			});
			s = mdEscape(s);
			s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, url) => {
				const src = mdImgUrl(url.replace(/&amp;/g, "&"));
				if (!src) return "";
				return '<img src="' + mdEscape(src) + '" alt="' + alt + '" loading="lazy" />';
			});
			s = s.replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, text, url) => {
				const u = url.replace(/&amp;/g, "&");
				if (/^(todo|meeting):/i.test(u)) {
					const kind = u.split(":")[0].toLowerCase();
					return '<a href="#" data-tw-link="1" data-kind="' + kind + '" data-id="' + mdEscape(u.slice(kind.length + 1)) + '">' + text + "</a>";
				}
				const safe = mdUrl(u);
				if (!safe) return text;
				return '<a href="' + mdEscape(safe) + '" target="_blank" rel="noopener noreferrer">' + text + "</a>";
			});
			s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
			s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
			s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
			s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
			return s.replace(/\u0000(\d+)\u0001/g, (m, i) => slots[Number(i)] || "");
		}

		const MD_LIST = /^\s*(?:[-*+]|\d+\.)\s+/;
		const MD_BLOCK = /^ {0,3}(?:#{1,6}\s|>|```)/;

		/** 极简 GFM 渲染（纯字符串输出，全部文本已转义，不走 innerHTML 注入）。plain=true 时按纯文本展现。
		 *  opt.baseLine  —— 这段内容在原文档里的起始行号（任务清单的 data-line 要用全局行号）
		 *  opt.hnStart   —— 这段内容之前的标题数（标题 id/data-h 用全文序号，大纲才找得到）
		 *  opt.idPrefix  —— 标题 id 前缀（分块渲染时每块各用各的，避免 id 重复 */
		function mdToHtml(md, plain, opt) {
			const o = opt || {};
			const base = o.baseLine || 0;
			const pre = o.idPrefix || "tw-h-";
			const src = String(md == null ? "" : md).replace(/\r\n?/g, "\n");
			if (plain) return '<div class="tw-plain">' + mdEscape(src).replace(/\n/g, "<br />") + "</div>";
			const lines = src.split("\n");
			const out = [];
			let i = 0;
			let hn = o.hnStart || 0;
			while (i < lines.length) {
				const line = lines[i];
				if (!line.trim()) { i += 1; continue; }
				const fence = line.match(/^ {0,3}```\s*([\w+#.-]*)\s*$/);
				if (fence) {
					const lang = fence[1] || "";
					const buf = [];
					i += 1;
					while (i < lines.length && !/^ {0,3}```/.test(lines[i])) buf.push(lines[i++]);
					i += 1;
					out.push("<pre><code" + (lang ? ' data-lang="' + mdEscape(lang) + '"' : "") + ">" + mdEscape(buf.join("\n")) + '</code><button class="tw-copy" type="button">复制</button></pre>');
					continue;
				}
				const head = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
				if (head) {
					const lv = head[1].length;
					hn += 1;
					out.push("<h" + lv + ' id="' + pre + hn + '" data-h="' + hn + '">' + mdInline(head[2].replace(/\s+#+\s*$/, "")) + "</h" + lv + ">");
					i += 1;
					continue;
				}
				if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr />"); i += 1; continue; }
				if (/^ {0,3}>/.test(line)) {
					const buf = [];
					while (i < lines.length && /^ {0,3}>/.test(lines[i])) buf.push(lines[i++].replace(/^ {0,3}> ?/, ""));
					out.push("<blockquote>" + mdToHtml(buf.join("\n"), false) + "</blockquote>");
					continue;
				}
				if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0) {
					const split = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
					const headCells = split(lines[i]);
					const aligns = split(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
					i += 2;
					const rows = [];
					while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(split(lines[i++]));
					let t = "<table><thead><tr>";
					headCells.forEach((c, k) => { t += "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + mdInline(c) + "</th>"; });
					t += "</tr></thead><tbody>";
					rows.forEach((r) => {
						t += "<tr>";
						headCells.forEach((c, k) => { t += "<td>" + mdInline(r[k] == null ? "" : r[k]) + "</td>"; });
						t += "</tr>";
					});
					out.push(t + "</tbody></table>");
					continue;
				}
				if (MD_LIST.test(line)) {
					const items = [];
					while (i < lines.length && MD_LIST.test(lines[i])) {
						const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
						items.push({ indent: m[1].replace(/\t/g, "  ").length, ordered: /\d+\./.test(m[2]), text: m[3], line: i, num: /\d+\./.test(m[2]) ? Number(m[2].replace(/\.$/, "")) : null });
						i += 1;
					}
					let html = "";
					const stack = [];
					for (const it of items) {
						let depth = it.indent >= 4 ? 2 : it.indent >= 2 ? 1 : 0;
						depth += 1;
						if (depth > stack.length + 1) depth = stack.length + 1;
						while (stack.length && (stack.length > depth || (stack.length === depth && stack[stack.length - 1].ordered !== it.ordered))) {
							html += stack.pop().ordered ? "</ol>" : "</ul>";
						}
						if (stack.length < depth) {
							html += it.ordered ? "<ol" + (it.num && it.num !== 1 ? ' start="' + it.num + '"' : "") + ">" : "<ul>";
							stack.push({ ordered: it.ordered });
						}
						const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
						if (task) {
							const on = task[1].toLowerCase() === "x";
							html += '<li class="tw-task"><span class="tw-check" data-check="' + (on ? 1 : 0) + '" data-line="' + (it.line + base) + '" role="checkbox" aria-checked="' + (on ? "true" : "false") + '">✓</span><span>' + mdInline(task[2]) + "</span></li>";
						} else {
							html += "<li>" + mdInline(it.text) + "</li>";
						}
					}
					while (stack.length) html += stack.pop().ordered ? "</ol>" : "</ul>";
					out.push(html);
					continue;
				}
				const buf = [];
				while (i < lines.length && lines[i].trim() && !MD_BLOCK.test(lines[i]) && !MD_LIST.test(lines[i]) && !/^\s*\|/.test(lines[i]) && !/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
					buf.push(lines[i++]);
				}
				if (!buf.length) buf.push(lines[i++]);
				out.push("<p>" + mdInline(buf.join("\n")).replace(/\n/g, "<br />") + "</p>");
			}
			return out.join("\n");
		}

		const MD_IS_FENCE = (l) => /^ {0,3}(?:```|~~~)/.test(l);
		const MD_IS_HEAD = (l) => /^ {0,3}#{1,6}\s/.test(l);
		const MD_IS_QUOTE = (l) => /^ {0,3}>/.test(l);
		const MD_IS_LI = (l) => /^\s*(?:[-*+]|\d+\.)\s+/.test(l);
		const MD_IS_TABLE = (l) => /^\s*\|/.test(l);
		const MD_IS_HR = (l) => /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(l);

		/** 把 Markdown 源码切成"块"（即时渲染按块编辑的最小单位）。
		 *  返回 [{start,end,hn}]：start/end 为源码行号（含），hn 为块之前的标题数。 */
		function mdBlocks(src) {
			const lines = String(src == null ? "" : src).split("\n");
			const out = [];
			let hn = 0;
			let i = 0;
			while (i < lines.length) {
				const l = lines[i];
				if (!l.trim()) { i += 1; continue; }
				if (MD_IS_FENCE(l)) {
					let j = i + 1;
					while (j < lines.length && !MD_IS_FENCE(lines[j])) j += 1;
					const end = j < lines.length ? j : lines.length - 1;
					out.push({ start: i, end, hn });
					i = end + 1;
					continue;
				}
				if (MD_IS_TABLE(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf("-") >= 0) {
					let j = i + 2;
					while (j < lines.length && MD_IS_TABLE(lines[j]) && lines[j].trim()) j += 1;
					out.push({ start: i, end: j - 1, hn });
					i = j;
					continue;
				}
				if (MD_IS_HEAD(l)) { out.push({ start: i, end: i, hn }); hn += 1; i += 1; continue; }
				if (MD_IS_HR(l)) { out.push({ start: i, end: i, hn }); i += 1; continue; }
				if (MD_IS_QUOTE(l)) {
					let j = i + 1;
					while (j < lines.length && MD_IS_QUOTE(lines[j])) j += 1;
					out.push({ start: i, end: j - 1, hn });
					i = j;
					continue;
				}
				if (MD_IS_LI(l)) {
					let j = i + 1;
					while (j < lines.length && (MD_IS_LI(lines[j]) || (/^\s{2,}/.test(lines[j]) && lines[j].trim()))) j += 1;
					out.push({ start: i, end: j - 1, hn });
					i = j;
					continue;
				}
				let j = i + 1;
				while (j < lines.length && lines[j].trim() && !MD_IS_FENCE(lines[j]) && !MD_IS_HEAD(lines[j]) && !MD_IS_QUOTE(lines[j]) && !MD_IS_LI(lines[j]) && !MD_IS_TABLE(lines[j]) && !MD_IS_HR(lines[j])) j += 1;
				out.push({ start: i, end: j - 1, hn });
				i = j;
			}
			return out;
		}

		/** 渲染后的可见字符位置 → 源码位置：跳过 #、-、*、`、|、链接括号等标记字符。 */
		function mdRawOffset(raw, vis) {
			const s = String(raw == null ? "" : raw);
			let ri = 0;
			let vi = 0;
			const lineStart = () => ri === 0 || s.charAt(ri - 1) === "\n";
			while (ri < s.length && vi < vis) {
				const rest = s.slice(ri);
				if (lineStart()) {
					const m = rest.match(/^(?:#{1,6}\s+|> |- \[[ xX]\] |[-*+]\s+|\d+\.\s+|```[\w+#.-]*\s*\n)/);
					if (m) { ri += m[0].length; continue; }
				}
				if (rest.charAt(0) === "|") { ri += 1; continue; }
				if (rest.startsWith("**") || rest.startsWith("__") || rest.startsWith("~~")) { ri += 2; continue; }
				if (rest.charAt(0) === "*" || rest.charAt(0) === "_" || rest.charAt(0) === "`") { ri += 1; continue; }
				if (rest.startsWith("](")) {
					const m2 = rest.match(/^\]\([^)]*\)/);
					if (m2) { ri += m2[0].length; continue; }
				}
				if (rest.startsWith("![")) { ri += 2; continue; }
				if (rest.charAt(0) === "[") { ri += 1; continue; }
				if (rest.charAt(0) === "\n") { ri += 1; continue; }
				ri += 1;
				vi += 1;
			}
			return ri;
		}

		/** 去 Markdown 标记（与 server 的 mdPlain 同口径），用于实时字数统计。 */
		function mdPlainClient(src) {
			return String(src == null ? "" : src)
				.replace(/```[\w+#.-]*\n([\s\S]*?)```/g, "$1")
				.replace(/`([^`]*)`/g, "$1")
				.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
				.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
				.replace(/^ {0,3}#{1,6}\s+/gm, "")
				.replace(/^ {0,3}> ?/gm, "")
				.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
				.replace(/\|/g, " ")
				.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
				.replace(/\[[ xX]\]\s*/g, "")
				.replace(/[*_~]{1,3}/g, "")
				.replace(/\s+/g, " ")
				.trim();
		}

		/** 光标处插入：有选区就用 before/after 包裹，否则插入 ph 占位并选中它。 */
		function mdApply(value, start, end, before, after, ph) {
			const sel = value.slice(start, end);
			const body = sel || ph || "";
			const next = value.slice(0, start) + before + body + after + value.slice(end);
			const s = start + before.length;
			return { next, start: s, end: s + body.length };
		}

		/** 给选区覆盖的每一行加/去前缀（标题 / 列表 / 引用 / 待办共用）。 */
		function mdPrefix(value, start, end, prefix) {
			const ls = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
			let le = value.indexOf("\n", end);
			if (le < 0) le = value.length;
			const lines = value.slice(ls, le).split("\n");
			const strip = (l) => l.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/, "");
			const all = lines.every((l) => l.startsWith(prefix) || !l.trim());
			const nextLines = lines.map((l) => (all ? l.slice(prefix.length) : prefix + strip(l)));
			const block = nextLines.join("\n");
			return { next: value.slice(0, ls) + block + value.slice(le), start: ls, end: ls + block.length };
		}

		/** 毫秒时间戳 → 本地 ISO（YYYY-MM-DDTHH:MM），喂给现有的 relTime。 */
		function stampOf(ts) {
			const d = new Date(Number(ts) || Date.now());
			const p = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
		}

		function splitTags(v) {
			return String(v == null ? "" : v).split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
		}

		function NotesPage(props) {
			const [notes, setNotes] = useState([]);
			const [current, setCurrent] = useState(null);
			const [title, setTitle] = useState("");
			const [content, setContent] = useState("");
			const [format, setFormat] = useState("markdown");
			const [tagsText, setTagsText] = useState("");
			const [pinned, setPinned] = useState(false);
			const [rev, setRev] = useState(0);
			const [mode, setMode] = useState("live");
			const [blocks, setBlocks] = useState([]);
			const [act, setAct] = useState(null);
			const [query, setQuery] = useState("");
			const [dirty, setDirty] = useState(false);
			const [saving, setSaving] = useState(false);
			const [conflict, setConflict] = useState(null);
			const [draft, setDraft] = useState(null);
			const [histOpen, setHistOpen] = useState(false);
			const [versions, setVersions] = useState([]);
			const [linkOpen, setLinkOpen] = useState(false);
			const [linkItems, setLinkItems] = useState({ todos: [], meetings: [] });

			const taRef = useRef(null);
			const previewRef = useRef(null);
			const fileRef = useRef(null);
			const caretRef = useRef(null);
			const actRef = useRef(null);
			const liveCaretRef = useRef(null);
			const live = useRef({});
			live.current = { current, title, content, format, tagsText, pinned, rev, dirty };

			const plainLen = mdPlainClient(content).replace(/\s+/g, "").length;
			const headings = useMemo(() => {
				const out = [];
				String(content).split("\n").forEach((l, idx) => {
					const m = l.match(/^ {0,3}(#{1,6})\s+(.*)$/);
					if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`~]/g, "").trim(), idx, ord: out.length + 1 });
				});
				return out;
			}, [content]);
			const outlineVisible = headings.length >= 2 && mode !== "edit";

			useEffect(() => { ensureMdCss(); }, []);

			/** 即时渲染：只在"没有正在编辑的块"时按源码重算分块，打字期间保持结构稳定。 */
			useEffect(() => {
				if (mode !== "live" || act) return;
				setBlocks(mdBlocks(content));
			}, [content, mode, act]);

			/** 块被激活后：聚焦、还原光标、按内容撑高。 */
			useEffect(() => {
				if (!act || !actRef.current) return;
				const ta = actRef.current;
				if (document.activeElement !== ta) ta.focus();
				const c = liveCaretRef.current;
				if (c && c.off != null) {
					const off = Math.min(c.off, ta.value.length);
					ta.selectionStart = off;
					ta.selectionEnd = off;
					liveCaretRef.current = null;
				}
				ta.style.height = "auto";
				ta.style.height = ta.scrollHeight + "px";
				if (typeof ta.scrollIntoView === "function") {
					const box = previewRef.current;
					const top = ta.getBoundingClientRect().top;
					const bTop = box ? box.getBoundingClientRect().top : 0;
					const bBottom = box ? box.getBoundingClientRect().bottom : 0;
					if (top < bTop + 24 || top > bBottom - 60) ta.scrollIntoView({ block: "center" });
				}
			}, [act]);

			const srcLines = () => String(live.current.content).split("\n");
			const offAt = (ls, lineIdx, ch) => {
				let n = 0;
				for (let k = 0; k < lineIdx && k < ls.length; k += 1) n += ls[k].length + 1;
				return n + (ch || 0);
			};
			const adjustTa = (ta) => {
				if (!ta) return;
				ta.style.height = "auto";
				ta.style.height = ta.scrollHeight + "px";
			};

			/** 用 newLines 替换源码里正在编辑的那几行；caretOff 为块内字符偏移（null 表示保留 DOM 选区）。 */
			const liveReplace = (newLines, actStart, caretOff) => {
				if (!act) return;
				const start = actStart == null ? act.start : actStart;
				const end = act.end;
				const lines = srcLines();
				const delta = newLines.length - (end - start + 1);
				setContent(lines.slice(0, start).concat(newLines, lines.slice(end + 1)).join("\n"));
				setDirty(true);
				if (delta) setBlocks((bs) => bs.map((b) => (b.start > end ? { start: b.start + delta, end: b.end + delta, hn: b.hn } : b)));
				if (caretOff != null) liveCaretRef.current = { off: caretOff };
				setAct({ start, end: start + newLines.length - 1 });
			};

			/** 列表行拆解：缩进 / 标记 / 标记后空白 / 任务框 / 正文。 */
			const liParts = (line) => {
				const m = String(line).match(/^(\s*)([-*+]|\d+\.)([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/);
				if (!m) return null;
				return { indent: m[1], marker: m[2], gap: m[3], task: m[4] || "", text: m[5] || "", ordered: /^\d/.test(m[2]) };
			};

			const liNextLine = (p) => {
				const marker = p.ordered ? String(Number(p.marker.replace(/\.$/, "")) + 1) + "." : "-";
				return p.indent + marker + (p.gap || " ") + (p.task ? "[ ] " : "");
			};

			/** 空项回车：顶层退出列表留空段落；嵌套层先退一级并保留列表标记（再按一次才退出）。 */
			const liExitLine = (p) => {
				const ind = p.indent.replace(/\t/g, "  ");
				if (ind.length >= 2) return ind.slice(2) + (p.ordered ? "1." : "-") + (p.gap || " ") + (p.task ? "[ ] " : "");
				return "";
			};

			/** 有序编号按 Markdown 语义重算：连续同级列表以首项数字为起点逐项 +1，子层独立计数，
			 *  空行或非列表段落打断后重新起算（渲染层同样以首项数字为 start）。 */
			const renumberOrdered = (lines) => {
				const ctx = [];
				let fence = false;
				for (let i = 0; i < lines.length; i += 1) {
					const line = lines[i];
					if (/^ {0,3}(?:```|~~~)/.test(line)) { fence = !fence; ctx.length = 0; continue; }
					if (fence) { ctx.length = 0; continue; }
					const p = liParts(line);
					if (!p) { ctx.length = 0; continue; }
					const indent = p.indent.replace(/\t/g, "  ").length;
					while (ctx.length && ctx[ctx.length - 1].indent > indent) ctx.pop();
					if (!ctx.length || ctx[ctx.length - 1].indent < indent) {
						ctx.push({ indent, ordered: p.ordered, num: p.ordered ? Number(p.marker.replace(/\.$/, "")) : 0 });
					} else {
						const top = ctx[ctx.length - 1];
						if (top.ordered !== p.ordered) { top.ordered = p.ordered; top.num = p.ordered ? Number(p.marker.replace(/\.$/, "")) : 0; }
						else if (p.ordered) top.num += 1;
					}
					if (p.ordered) {
						const num = ctx[ctx.length - 1].num;
						lines[i] = p.indent + num + "." + (p.gap || " ") + p.task + p.text;
					}
				}
				return lines;
			};

			/** 光标所在行与列（ta.value 内）。 */
			const caretLineCol = (ta) => {
				const raw = ta.value;
				const pos = ta.selectionStart == null ? raw.length : ta.selectionStart;
				const lines = raw.split("\n");
				let li = 0;
				let col = pos;
				while (li < lines.length - 1 && col > lines[li].length) { col -= lines[li].length + 1; li += 1; }
				return { lines, li, col };
			};

			/** 把块内的新行写回源码：重排编号 → 重算分块 → 还原光标。
			 *  caret 模式：lineStart（行首）/ textStart（标记之后正文起点）/ textRel（相对正文起点偏移）。 */
			const commitLiveLines = (outLines, caret) => {
				if (!act) return;
				const lines = srcLines();
				const full = renumberOrdered(lines.slice(0, act.start).concat(outLines, lines.slice(act.end + 1)));
				const nextSrc = full.join("\n");
				const absLine = act.start + caret.line;
				const lineText = full[absLine] || "";
				const p = liParts(lineText);
				const markerEnd = p ? lineText.length - p.text.length : 0;
				let col = 0;
				if (caret.mode === "textStart") col = markerEnd;
				else if (caret.mode === "textRel") col = Math.max(0, markerEnd + (caret.rel || 0));
				const nextBlocks = mdBlocks(nextSrc);
				setContent(nextSrc);
				setDirty(true);
				setBlocks(nextBlocks);
				const cover = nextBlocks.filter((b) => b.start <= absLine && absLine <= b.end)[0];
				if (cover) {
					const bLines = nextSrc.split("\n").slice(cover.start, cover.end + 1);
					setAct({ start: cover.start, end: cover.end });
					liveCaretRef.current = { off: offAt(bLines, absLine - cover.start, col) };
				} else {
					setAct({ start: absLine, end: absLine });
					liveCaretRef.current = { off: col };
				}
			};

			const onLiveInput = (value) => {
				if (!act) return;
				const ta = actRef.current;
				let out = value;
				let caretOff = null;
				if (ta) {
					const { li, col } = caretLineCol(ta);
					const arr = value.split("\n");
					const cur = arr[li] || "";
					// 行首标记自动规范化：* / + → -，1) / 1、 / 1． → 1.
					const norm = cur
						.replace(/^(\s*)(\*|\+)([ \t]+)(.*)$/, (m, a, b, c, d) => a + "-" + c + d)
						.replace(/^(\s*)(\d+)[)）、][ \t]+(.*)$/, (m, a, n, d) => a + n + ". " + d)
						.replace(/^(\s*)(\d+)[.．][ \t]+(.*)$/, (m, a, n, d) => a + n + ". " + d);
					if (norm !== cur) {
						arr[li] = norm;
						out = arr.join("\n");
						caretOff = offAt(arr, li, Math.max(0, col + (norm.length - cur.length)));
					}
				}
				liveReplace(out.split("\n"), act.start, caretOff);
			};

			const liveWrap = (before, after, ph) => {
				const ta = actRef.current;
				if (!ta || !act) return;
				const res = mdApply(ta.value, ta.selectionStart, ta.selectionEnd, before, after, ph);
				ta.value = res.next;
				ta.selectionStart = res.start;
				ta.selectionEnd = res.end;
				adjustTa(ta);
				liveReplace(res.next.split("\n"), act.start, null);
			};

			/** 回车（Typora 语义）：行尾续同级新项（任务项默认未勾选）；空项回车退出列表（嵌套先退一级）；
			 *  行中回车拆项、后半段顺延成新项；普通段落行中拆分、行尾开新段；代码块与表格走原生换行。 */
			const liveEnter = (ta) => {
				if (!act) return false;
				const { lines, li, col } = caretLineCol(ta);
				const cur = lines[li] || "";
				if (MD_IS_FENCE(cur) || MD_IS_TABLE(cur)) return false;
				const head = cur.slice(0, col);
				const tail = cur.slice(col);
				const p = liParts(cur);
				const out = lines.slice();
				let caret = { line: li + 1, mode: "lineStart" };
				if (p) {
					if (tail.trim() !== "") {
						out[li] = head.replace(/[ \t]+$/, "");
						out.splice(li + 1, 0, p.indent + (p.ordered ? String(Number(p.marker.replace(/\.$/, "")) + 1) + "." : "-") + (p.gap || " ") + (p.task ? "[ ] " : "") + tail);
						caret = { line: li + 1, mode: "textStart" };
					} else if (p.text.trim() === "") {
						out[li] = liExitLine(p);
						caret = { line: li, mode: out[li] ? "textStart" : "lineStart" };
					} else {
						out.splice(li + 1, 0, liNextLine(p));
						caret = { line: li + 1, mode: "textStart" };
					}
				} else if (tail === "") {
					out.splice(li + 1, 0, "");
				} else {
					out[li] = head;
					out.splice(li + 1, 0, "", tail);
					caret = { line: li + 2, mode: "lineStart" };
				}
				commitLiveLines(out, caret);
				return true;
			};

			/** 退格（Typora 语义）：行首退格 → 嵌套先退一级、顶层去掉列表标记变段落；
			 *  标记后正文起点退格 → 整个标记去掉变段落（空项则直接退出列表）。 */
			const liveBackspace = (ta) => {
				if (!act) return false;
				if (ta.selectionStart !== ta.selectionEnd) return false;
				const { lines, li, col } = caretLineCol(ta);
				const cur = lines[li] || "";
				if (MD_IS_FENCE(cur) || MD_IS_TABLE(cur)) return false;
				const p = liParts(cur);
				if (!p) return false;
				const indentLen = p.indent.length;
				const markerEnd = cur.length - p.text.length;
				if (col === 0) {
					const out = lines.slice();
					out[li] = indentLen >= 2 ? cur.slice(2) : p.text;
					commitLiveLines(out, { line: li, mode: "lineStart" });
					return true;
				}
				if (col === markerEnd) {
					const out = lines.slice();
					out[li] = p.indent + p.text;
					commitLiveLines(out, { line: li, mode: "textRel", rel: 0 });
					return true;
				}
				return false;
			};

			/** Tab / Shift+Tab：列表项整行缩进或反缩进（2 空格一层），编号随后重排。 */
			const liveTab = (ta, shift) => {
				if (!act) return false;
				const { lines, li, col } = caretLineCol(ta);
				const cur = lines[li] || "";
				const p = liParts(cur);
				if (!p) return false;
				const markerEnd = cur.length - p.text.length;
				const rel = col - markerEnd;
				const out = lines.slice();
				if (shift) {
					if (!p.indent) return false;
					out[li] = cur.slice(Math.min(2, p.indent.length));
				} else {
					out[li] = "  " + (p.ordered ? cur.replace(/^(\s*)\d+\./, (m, s) => s + "1.") : cur);
				}
				commitLiveLines(out, rel <= 0 ? { line: li, mode: "lineStart" } : { line: li, mode: "textRel", rel });
				return true;
			};

			const onLiveKey = (e) => {
				const meta = e.metaKey || e.ctrlKey;
				const ta = e.target;
				if (meta && (e.key === "b" || e.key === "B")) { e.preventDefault(); liveWrap("**", "**", "加粗文字"); return; }
				if (meta && (e.key === "i" || e.key === "I")) { e.preventDefault(); liveWrap("*", "*", "斜体文字"); return; }
				if (meta && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveNow(false); return; }
				if (meta && (e.key === "e" || e.key === "E")) { e.preventDefault(); setAct(null); setMode("preview"); return; }
				if (e.key === "Escape") { e.preventDefault(); setAct(null); return; }
				if (e.key === "Tab") {
					if (ta && ta.selectionStart != null && liveTab(ta, e.shiftKey)) { e.preventDefault(); return; }
					e.preventDefault();
					const r = mdApply(ta.value, ta.selectionStart, ta.selectionEnd, "  ", "", "");
					ta.value = r.next;
					ta.selectionStart = r.end;
					ta.selectionEnd = r.end;
					adjustTa(ta);
					liveReplace(r.next.split("\n"), act ? act.start : null, null);
					return;
				}
				if (e.key === "Backspace" && ta && liveBackspace(ta)) { e.preventDefault(); return; }
				if (e.key === "Enter" && !e.shiftKey && liveEnter(ta)) e.preventDefault();
			};

			const activateBlock = (b, vis) => {
				const raw = srcLines().slice(b.start, b.end + 1).join("\n");
				liveCaretRef.current = { off: vis == null ? raw.length : mdRawOffset(raw, vis) };
				setAct({ start: b.start, end: b.end });
			};

			const onLiveClick = (e) => {
				const t = e.target;
				if (!t || !t.closest) return;
				const a = t.closest("a[data-tw-link]");
				if (a) {
					e.preventDefault();
					const kind = a.getAttribute("data-kind");
					if (props.openPanel) props.openPanel(kind === "meeting" ? "tidywork-meetings" : "tidywork-todos");
					return;
				}
				const chk = t.closest(".tw-check");
				if (chk) { toggleTask(Number(chk.getAttribute("data-line"))); return; }
				const copy = t.closest(".tw-copy");
				if (copy) {
					const code = copy.parentNode && copy.parentNode.querySelector("code");
					if (code && navigator.clipboard) navigator.clipboard.writeText(code.textContent || "").then(() => toast("代码已复制")).catch(() => {});
					return;
				}
				const blk = t.closest("[data-b]");
				if (!blk) return;
				const start = Number(blk.getAttribute("data-b"));
				const b = blocks.filter((x) => x.start === start)[0];
				if (!b) return;
				let vis = null;
				try {
					const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
					if (r && blk.contains(r.startContainer)) {
						const rr = document.createRange();
						rr.selectNodeContents(blk);
						rr.setEnd(r.startContainer, r.startOffset);
						vis = rr.toString().length;
					}
				} catch (err) {}
				activateBlock(b, vis);
			};

			/** 光标/选区操作统一走这里：改内容 + 记光标，渲染完再还原选区。 */
			const applyEdit = (res) => {
				caretRef.current = { start: res.start, end: res.end };
				setContent(res.next);
				setDirty(true);
			};
			const selRange = () => {
				const ta = taRef.current;
				const len = live.current.content.length;
				if (!ta) return { start: len, end: len };
				return { start: ta.selectionStart == null ? len : ta.selectionStart, end: ta.selectionEnd == null ? len : ta.selectionEnd };
			};
			const insertText = (before, after, ph) => {
				const r = selRange();
				applyEdit(mdApply(live.current.content, r.start, r.end, before, after, ph));
			};
			const wrapSelection = (before, after, ph) => insertText(before, after, ph);
			const applyPrefix = (prefix) => {
				const r = selRange();
				applyEdit(mdPrefix(live.current.content, r.start, r.end, prefix));
			};

			useEffect(() => {
				const c = caretRef.current;
				if (!c || !taRef.current) return;
				caretRef.current = null;
				const ta = taRef.current;
				ta.focus();
				ta.selectionStart = c.start;
				ta.selectionEnd = c.end;
			}, [content]);

			const readDraft = (key) => {
				try { const raw = localStorage.getItem(DRAFT_PREFIX + key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
			};
			const clearDraft = (key) => {
				try { localStorage.removeItem(DRAFT_PREFIX + key); } catch (e) {}
			};

			const refreshList = (q) => {
				api("/tidywork-api/notes" + (q ? "?q=" + encodeURIComponent(q) : ""))
					.then((list) => setNotes(list || []))
					.catch(() => {});
			};

			const loadNote = (id) => {
				api("/tidywork-api/notes/" + id)
					.then((n) => {
						setCurrent(n);
						setTitle(n.title || "");
						setContent(n.content || "");
						setFormat(n.format === "text" ? "text" : "markdown");
						setTagsText((n.tags || []).join(", "));
						setPinned(Boolean(n.pinned));
						setRev(n.rev || 0);
						setDirty(false);
						setConflict(null);
						setAct(null);
						setBlocks(mdBlocks(n.content || ""));
						const d = readDraft(n.id);
						const base = new Date(String(n.updatedAt || "").replace(" ", "T")).getTime();
						if (d && d.ts && Number(d.ts) > (Number.isFinite(base) ? base : 0) && (d.content || "") !== (n.content || "")) setDraft(d);
						else setDraft(null);
					})
					.catch(() => toast("笔记加载失败"));
			};

			const openAdd = () => {
				if (dirty) saveNow(false);
				setAct(null);
				setBlocks([]);
				setCurrent(null);
				setTitle("");
				setContent("");
				setFormat("markdown");
				setTagsText("");
				setPinned(false);
				setRev(0);
				setDirty(false);
				setConflict(null);
				setMode("live");
				const d = readDraft("new");
				if (d && (d.content || "").trim()) setDraft(d);
				else setDraft(null);
			};

			const selectNote = (id) => {
				if (current && current.id === id) return;
				if (dirty) saveNow(false);
				loadNote(id);
			};

			useEffect(() => {
				api("/tidywork-api/notes")
					.then((list) => {
						setNotes(list || []);
						if (list && list.length) loadNote(list[0].id);
						else openAdd();
					})
					.catch(() => {});
			}, []);

			useEffect(() => {
				const timer = setTimeout(() => refreshList(query), 300);
				return () => clearTimeout(timer);
			}, [query]);

			/** 自动保存：内容一停 900ms 就落盘，同时把草稿写进 localStorage 兜住异常关闭。 */
			useEffect(() => {
				if (!dirty || conflict) return;
				if (!String(content || "").trim() && !String(title || "").trim()) return;
				const key = current ? current.id : "new";
				try {
					localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ title, content, format, tagsText, pinned, ts: Date.now() }));
				} catch (e) {}
				const timer = setTimeout(() => saveNow(false), 900);
				return () => clearTimeout(timer);
			}, [title, content, format, tagsText, pinned, dirty, conflict]);

			const saveNow = (force) => {
				const l = live.current;
				const c = l.current;
				if (!c && !String(l.content || "").trim() && !String(l.title || "").trim()) return Promise.resolve(null);
				setSaving(true);
				const body = {
					title: (l.title || "").trim() || "未命名笔记",
					content: l.content,
					format: l.format,
					tags: splitTags(l.tagsText),
					pinned: Boolean(l.pinned)
				};
				if (c) {
					body.rev = l.rev;
					if (force) body.force = true;
				}
				const req = c
					? api("/tidywork-api/notes/" + c.id, { method: "PUT", body: JSON.stringify(body) })
					: api("/tidywork-api/notes", { method: "POST", body: JSON.stringify(body) });
				return req
					.then((n) => {
						setSaving(false);
						// 保存期间用户可能已经切到别的笔记：只在"还停在这一篇"时才回写状态，
						// 否则刚加载的那篇会被上一笔保存的响应覆盖。
						const still = live.current.current;
						if (!still || still.id === n.id) {
							setDirty(false);
							setConflict(null);
							setCurrent(n);
							setRev(n.rev || 0);
						}
						clearDraft(n.id);
						clearDraft("new");
						refreshList(query);
						return n;
					})
					.catch((e) => {
						setSaving(false);
						if (e && e.status === 409) {
							setConflict(e.payload || {});
							return null;
						}
						toast("保存失败：" + e.message);
						return null;
					});
			};

			const remove = () => {
				if (!current) { toast("请先选择笔记"); return; }
				// v3.30：删完给撤销（确认框挡不住误操作，撤销才是真的兜底）
				const gone = { title: current.title, content: content || "" };
				const preview = (gone.content || "").slice(0, 20000);
				api("/tidywork-api/notes/" + current.id, { method: "DELETE" })
					.then(() => {
						clearDraft(current.id);
						setDirty(false);
						setCurrent(null);
						toast("已删除笔记：" + gone.title, {
							action: "撤销",
							onAction: () =>
								api("/tidywork-api/notes", { method: "POST", body: JSON.stringify({ title: gone.title, content: preview }) })
									.then((n) => {
										api("/tidywork-api/notes").then((list) => {
											setNotes(list || []);
											if (n && n.id) loadNote(n.id);
										}).catch(() => {});
										toast("已恢复");
									})
									.catch((e) => toast("恢复失败：" + e.message))
						});
						api("/tidywork-api/notes").then((list) => {
							setNotes(list || []);
							if (list && list.length) loadNote(list[0].id);
							else openAdd();
						}).catch(() => {});
					})
					.catch((e) => toast(e.message));
			};

			const uploadImage = (file) => {
				if (!file) return;
				if (!/^image\//.test(file.type)) { toast("只支持图片文件"); return; }
				if (file.size > 6 * 1024 * 1024) { toast("单张图片不能超过 6MB"); return; }
				const liveTa = actRef.current;
				const liveSel = liveTa ? { start: liveTa.selectionStart || 0, end: liveTa.selectionEnd || 0 } : null;
				const liveAct = act;
				const r = selRange();
				const reader = new FileReader();
				reader.onload = () => {
					api("/tidywork-api/attachments", { method: "POST", body: JSON.stringify({ name: file.name || "image", dataUrl: String(reader.result) }) })
						.then((res) => {
							const alt = String(file.name || "图片").replace(/[\[\]]/g, "");
							const snippet = "![" + alt + "](" + res.url + ")\n";
							if (liveAct && liveTa && liveSel) {
								const out = mdApply(liveTa.value, liveSel.start, liveSel.end, snippet, "", "");
								liveTa.value = out.next;
								liveTa.selectionStart = out.end;
								liveTa.selectionEnd = out.end;
								adjustTa(liveTa);
								liveReplace(out.next.split("\n"), liveAct.start, null);
							} else {
								applyEdit(mdApply(live.current.content, r.start, r.end, snippet, "", ""));
							}
							toast("图片已插入");
						})
						.catch((e) => toast("图片上传失败：" + e.message));
				};
				reader.readAsDataURL(file);
			};

			const onPaste = (e) => {
				const files = e.clipboardData && e.clipboardData.files;
				if (files && files.length && /^image\//.test(files[0].type)) {
					e.preventDefault();
					uploadImage(files[0]);
				}
			};
			const onDrop = (e) => {
				const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
				if (f && /^image\//.test(f.type)) {
					e.preventDefault();
					uploadImage(f);
				}
			};

			const onKeyDown = (e) => {
				const meta = e.metaKey || e.ctrlKey;
				if (meta && (e.key === "b" || e.key === "B")) { e.preventDefault(); wrapSelection("**", "**", "加粗文字"); return; }
				if (meta && (e.key === "i" || e.key === "I")) { e.preventDefault(); wrapSelection("*", "*", "斜体文字"); return; }
				if (meta && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveNow(false); return; }
				if (meta && (e.key === "e" || e.key === "E")) { e.preventDefault(); setMode(mode === "preview" ? "edit" : "preview"); return; }
				if (e.key === "Tab") { e.preventDefault(); insertText("  ", "", ""); }
			};

			const toggleTask = (line) => {
				const lines = String(live.current.content).split("\n");
				if (line < 0 || line >= lines.length) return;
				if (!/\[[ xX]\]/.test(lines[line])) return;
				lines[line] = lines[line].replace(/\[([ xX])\]/i, (m, s) => (s.trim() ? "[ ]" : "[x]"));
				setContent(lines.join("\n"));
				setDirty(true);
			};

			const onPreviewClick = (e) => {
				const t = e.target;
				if (!t || !t.closest) return;
				const a = t.closest("a[data-tw-link]");
				if (a) {
					e.preventDefault();
					const kind = a.getAttribute("data-kind");
					if (props.openPanel) props.openPanel(kind === "meeting" ? "tidywork-meetings" : "tidywork-todos");
					return;
				}
				const chk = t.closest(".tw-check");
				if (chk) { toggleTask(Number(chk.getAttribute("data-line"))); return; }
				const copy = t.closest(".tw-copy");
				if (copy) {
					const code = copy.parentNode && copy.parentNode.querySelector("code");
					if (code && navigator.clipboard) {
						navigator.clipboard.writeText(code.textContent || "").then(() => toast("代码已复制")).catch(() => {});
					}
				}
			};

			const jumpHeading = (hd) => {
				if (mode === "live") {
					setAct(null);
					requestAnimationFrame(() => {
						const root = previewRef.current;
						const el = root && root.querySelector('[data-h="' + hd.ord + '"]');
						if (el && el.scrollIntoView) el.scrollIntoView({ block: "start", behavior: "smooth" });
					});
					return;
				}
				if (mode === "edit") {
					const ta = taRef.current;
					if (!ta) return;
					const lines = String(live.current.content).split("\n");
					let off = 0;
					for (let k = 0; k < hd.idx; k += 1) off += lines[k].length + 1;
					caretRef.current = null;
					ta.focus();
					ta.selectionStart = off;
					ta.selectionEnd = off;
					ta.scrollTop = Math.max(0, hd.idx * 25 - 24);
					return;
				}
				const root = previewRef.current;
				if (!root) return;
				const hs = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
				const el = hs[hd.ord - 1];
				if (el && el.scrollIntoView) el.scrollIntoView({ block: "start", behavior: "smooth" });
			};

			const tasksToTodos = () => {
				const lines = String(live.current.content).split("\n");
				const picked = [];
				lines.forEach((l, i) => {
					const m = l.match(/^\s*[-*+]\s+\[( ?)\]\s+(.*)$/);
					if (m && (!m[1] || m[1] === " ")) picked.push({ line: i, text: m[2].trim() });
				});
				if (!picked.length) { toast("正文里没有未勾选的待办项（- [ ]）"); return; }
				Promise.all(picked.map((p) => api("/tidywork-api/todos", { method: "POST", body: JSON.stringify({ title: p.text.slice(0, 60), due: "today" }) }).catch(() => null)))
					.then((rs) => {
						const ok = rs.filter(Boolean).length;
						const hit = new Set(picked.map((p) => p.line));
						const next = lines.map((l, i) => (hit.has(i) ? l.replace(/\[( ?)\]/, "[x]") : l)).join("\n");
						setContent(next);
						setDirty(true);
						toast(ok ? "已创建 " + ok + " 条待办" : "待办创建失败");
					});
			};

			const openHistory = () => {
				if (!current) { toast("请先选择笔记"); return; }
				api("/tidywork-api/notes/" + current.id + "?versions=1")
					.then((n) => { setVersions((n && n.versions) || []); setHistOpen(true); })
					.catch((e) => toast(e.message));
			};

			const restoreVersion = (v) => {
				if (!current || !v) return;
				api("/tidywork-api/notes/" + current.id + "/restore", { method: "POST", body: JSON.stringify({ rev: v.rev }) })
					.then(() => { setHistOpen(false); loadNote(current.id); toast("已恢复到该版本"); })
					.catch((e) => toast(e.message));
			};

			const openLinkPicker = () => {
				setLinkOpen(true);
				api("/tidywork-api/todos?view=all").then((d) => setLinkItems((x) => ({ todos: (d || []).slice(0, 12), meetings: x.meetings }))).catch(() => {});
				api("/tidywork-api/meetings").then((d) => setLinkItems((x) => ({ todos: x.todos, meetings: (d || []).slice(0, 12) }))).catch(() => {});
			};

			const insertInternalLink = (kind, item) => {
				insertText("[" + String(item.title || "").replace(/[\[\]]/g, "") + "](" + kind + ":" + item.id + ")", "", "");
				setLinkOpen(false);
				toast("已插入内链");
			};

			const statusText = saving ? "保存中…" : conflict ? "有冲突" : dirty ? "未保存" : "已保存";
			const statusColor = conflict ? C.danger : dirty || saving ? C.warning : C.text2;
			const metaLine = "最后编辑：" + (current ? relTime(current.updatedAt || "—") : "—") + " · " + plainLen + " 字";

			const banner = (bg, color, text, actions) =>
				h(
					"div",
					{ style: { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 8, borderRadius: 8, background: bg, color, fontSize: 12 } },
					h("span", { style: { flex: 1, minWidth: 0 } }, text),
					actions
				);

			const toolbar = h(
				"div",
				{ "data-window-drag-exclude": true, style: { display: "flex", flexWrap: "wrap", gap: 2, padding: "6px 0 8px", borderBottom: "1px solid " + C.borderLight } },
				(mode === "preview" || mode === "live" ? [] : [
					{ label: "标题", run: () => applyPrefix("## ") },
					{ label: "粗体", run: () => wrapSelection("**", "**", "加粗文字") },
					{ label: "斜体", run: () => wrapSelection("*", "*", "斜体文字") },
					{ label: "删除线", run: () => wrapSelection("~~", "~~", "文字") },
					{ label: "引用", run: () => applyPrefix("> ") },
					{ label: "列表", run: () => applyPrefix("- ") },
					{ label: "待办", run: () => applyPrefix("- [ ] ") },
					{ label: "行内代码", run: () => wrapSelection("`", "`", "code") },
					{ label: "代码块", run: () => insertText("\n```\n", "\n```\n", "") },
					{ label: "表格", run: () => insertText("\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n", "", "") },
					{ label: "链接", run: () => insertText("[", "](https://)", "链接文字") },
					{ label: "内链", run: openLinkPicker },
					{ label: "图片", run: () => fileRef.current && fileRef.current.click() }
				]).map((it) => h("button", { key: it.label, className: "tw-tool", onClick: it.run, type: "button" }, it.label)),
				h("div", { style: { flex: 1 } }),
				[
					{ id: "live", label: "即时" },
					{ id: "edit", label: "编辑" },
					{ id: "split", label: "分屏" },
					{ id: "preview", label: "预览" }
				].map((it) =>
					h("button", { key: it.id, className: "tw-tool", onClick: () => setMode(it.id), type: "button", style: mode === it.id ? { background: C.accentSoft, color: C.accent, fontWeight: 600 } : null }, it.label)
				)
			);

			const textarea = h("textarea", {
				ref: taRef,
				value: content,
				spellCheck: false,
				placeholder: "在这里输入笔记内容…支持 Markdown：# 标题、- 列表、- [ ] 待办、| 表格 |、``` 代码块 ```、![图片](url)",
				onChange: (e) => { setContent(e.target.value); setDirty(true); },
				onPaste,
				onDrop,
				onKeyDown,
				style: { flex: 1, minWidth: 0, width: "100%", height: "100%", border: "none", outline: "none", resize: "none", background: "transparent", font: "inherit", lineHeight: 1.8, color: C.text1, fontFamily: FONT, boxSizing: "border-box", padding: "10px 0" }
			});

			const preview = h("div", {
				ref: previewRef,
				className: "tw-md",
				onClick: onPreviewClick,
				style: { flex: 1, minWidth: 0, overflowY: "auto", padding: "6px 0 24px", boxSizing: "border-box" },
				dangerouslySetInnerHTML: { __html: mdToHtml(content, format === "text") }
			});

			/** 正在编辑的那一块：等高 textarea，和渲染块共用字体与行高，视觉上不跳。 */
			const liveEditorNode = () => {
				const val = act ? srcLines().slice(act.start, act.end + 1).join("\n") : "";
				return h("textarea", {
					key: "e" + (act ? act.start + "-" + act.end : "none"),
					ref: actRef,
					defaultValue: val,
					className: "tw-live-ta",
					spellCheck: false,
					placeholder: "开始写…",
					onInput: (ev) => { adjustTa(ev.target); onLiveInput(ev.target.value); },
					onKeyDown: onLiveKey,
					onBlur: () => setAct(null),
					onPaste,
					onDrop,
					style: { display: "block", width: "100%", border: "none", outline: "none", resize: "none", background: "transparent", color: C.text1, fontFamily: FONT, boxSizing: "border-box", overflow: "hidden", padding: "2px 0", margin: 0, minHeight: 26, lineHeight: 1.78 }
				});
			};

			const liveNodes = [];
			let livePlaced = false;
			if (mode === "live") {
				blocks.forEach((b) => {
					if (act && !livePlaced && act.start < b.start) {
						liveNodes.push(liveEditorNode());
						livePlaced = true;
					}
					if (act && act.start === b.start) {
						liveNodes.push(liveEditorNode());
						livePlaced = true;
						return;
					}
					const raw = srcLines().slice(b.start, b.end + 1).join("\n");
					liveNodes.push(
						h("div", {
							key: "b" + b.start,
							"data-b": b.start,
							className: "tw-live-b",
							dangerouslySetInnerHTML: { __html: mdToHtml(raw, format === "text", { baseLine: b.start, idPrefix: "hb" + b.start + "-", hnStart: b.hn }) }
						})
					);
				});
				if (act && !livePlaced) liveNodes.push(liveEditorNode());
				if (!blocks.length && !act) liveNodes.push(h("div", { className: "tw-live-empty", onClick: () => setAct({ start: 0, end: 0 }) }, "点这里开始写…"));
			}
			const livePane = h(
				"div",
				{ ref: previewRef, className: "tw-md tw-live", onClick: onLiveClick, style: { flex: 1, minWidth: 0, overflowY: "auto", padding: "6px 0 48px", boxSizing: "border-box" } },
				liveNodes
			);

			const sidebar = h(
				"div",
				{ style: { borderRight: "1px solid " + C.borderLight, overflowY: "auto", padding: 10, boxSizing: "border-box" } },
				h("input", { style: Object.assign({}, S.input, { fontSize: 12.5, padding: "7px 9px", marginBottom: 8 }), placeholder: "搜索标题或正文…", value: query, onChange: (e) => setQuery(e.target.value) }),
				h(
					"button",
					{ style: Object.assign({}, S.menuItem, { color: C.accent, fontWeight: 600 }), onClick: openAdd },
					h("svg", { style: Object.assign({}, S.menuIcon, { width: 16, height: 16, color: C.accent }), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.plus })),
					h("span", null, "新建笔记")
				),
				notes.length === 0
					? h("div", { style: { padding: 8, fontSize: 12, color: C.text2 } }, query ? "没有匹配的笔记" : "暂无笔记")
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 2 } },
							notes.map((n) =>
								h(
									"div",
									{ key: n.id, style: { padding: "9px 10px", borderRadius: 8, cursor: "pointer", background: current && current.id === n.id ? C.active : "transparent" }, onClick: () => selectNote(n.id) },
									h(
										"div",
										{ style: { display: "flex", alignItems: "center", gap: 4, marginBottom: 3 } },
										n.pinned ? h("span", { style: { fontSize: 11, color: C.accent, flexShrink: 0 } }, "★") : null,
										h("div", { style: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, n.title),
										n.format === "markdown" ? h("span", { style: { fontSize: 10, color: C.text2, flexShrink: 0, letterSpacing: 0.5 } }, "MD") : null
									),
									h("div", { style: { fontSize: 11, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, n.preview || ""),
									(n.tags || []).length
										? h("div", { style: { display: "flex", gap: 4, marginTop: 4, flexWrap: "wrap" } }, n.tags.map((tg) => h("span", { key: tg, style: { fontSize: 10, padding: "1px 6px", borderRadius: 4, background: C.accentSoft, color: C.accent } }, tg)))
										: null
								)
							)
						)
			);

			const main = h(
				"div",
				{ style: { display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" } },
				h(
					"div",
					{ "data-window-drag": true, style: { padding: "18px 24px 0", flexShrink: 0 } },
					h(
						"div",
						{ style: { display: "flex", alignItems: "flex-start", gap: 6 } },
						h("input", { style: { flex: 1, minWidth: 0, background: "none", border: "none", outline: "none", fontSize: 22, fontWeight: 700, color: C.text0, marginBottom: 6, fontFamily: FONT }, placeholder: "笔记标题", value: title, onChange: (e) => { setTitle(e.target.value); setDirty(true); } }),
						h("button", { type: "button", title: pinned ? "取消置顶" : "置顶", onClick: () => { setPinned(!pinned); setDirty(true); }, style: { border: "none", background: "transparent", cursor: "pointer", fontSize: 18, lineHeight: "28px", color: pinned ? C.accent : C.text2, padding: "0 4px" } }, pinned ? "★" : "☆")
					),
					h(
						"div",
						{ style: { fontSize: 12, color: C.text2, display: "flex", gap: 10, alignItems: "center", paddingBottom: 8, borderBottom: "1px solid " + C.borderLight } },
						h("span", null, metaLine),
						h("span", { style: { color: statusColor } }, statusText),
						h("button", { type: "button", onClick: () => { const next = format === "markdown" ? "text" : "markdown"; setFormat(next); setDirty(true); }, style: { fontSize: 11, padding: "1px 7px", borderRadius: 4, border: "1px solid " + C.border, background: C.main, color: C.text1, cursor: "pointer", fontFamily: FONT } }, format === "markdown" ? "Markdown" : "纯文本")
					),
					h("input", { style: { width: "100%", background: "none", border: "none", outline: "none", fontSize: 12, color: C.text1, padding: "7px 0", fontFamily: FONT, boxSizing: "border-box" }, placeholder: "标签，用逗号分隔（最多 8 个）", value: tagsText, onChange: (e) => { setTagsText(e.target.value); setDirty(true); } }),
					conflict
						? banner(tint(C.warning, 12), C.warning, "这篇笔记在别处被更新了（可能是 AI 写入），当前编辑基于旧版本。", [
								h("button", { key: "reload", type: "button", onClick: () => loadNote(current.id), style: { border: "none", background: "transparent", color: C.accent, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: FONT } }, "加载最新"),
								h("button", { key: "force", type: "button", onClick: () => saveNow(true), style: { border: "none", background: "transparent", color: C.text1, cursor: "pointer", fontSize: 12, fontFamily: FONT } }, "覆盖保存")
							])
						: null,
					draft
						? banner(tint(C.accent, 10), C.accent, "检测到本地未保存草稿（" + relTime(stampOf(draft.ts)) + "）。", [
								h("button", { key: "use", type: "button", onClick: () => { setTitle(draft.title || ""); setContent(draft.content || ""); setTagsText(draft.tagsText || ""); setFormat(draft.format || "markdown"); setDirty(true); setDraft(null); }, style: { border: "none", background: "transparent", color: C.accent, cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: FONT } }, "恢复草稿"),
								h("button", { key: "drop", type: "button", onClick: () => { clearDraft(current ? current.id : "new"); setDraft(null); }, style: { border: "none", background: "transparent", color: C.text2, cursor: "pointer", fontSize: 12, fontFamily: FONT } }, "丢弃")
							])
						: null,
					toolbar
				),
				h(
					"div",
					{ style: { flex: 1, minHeight: 0, display: "flex", gap: 16, overflow: "hidden", padding: "0 24px" } },
					mode === "edit" ? textarea : null,
					mode === "split" ? h("div", { style: { flex: 1, minWidth: 0, display: "flex", borderRight: "1px solid " + C.borderLight, paddingRight: 12 } }, textarea) : null,
					mode === "live" ? livePane : mode === "edit" ? null : preview
				),
				h(
					"div",
					{ style: { display: "flex", gap: 8, alignItems: "center", padding: "10px 24px 14px", flexShrink: 0 } },
					h(Btn, { onClick: remove }, "删除"),
					h(Btn, { onClick: tasksToTodos }, "勾选项转待办"),
					h(Btn, { onClick: openHistory }, "历史"),
					h("div", { style: { flex: 1 } }),
					h("input", { ref: fileRef, type: "file", accept: "image/*", style: { display: "none" }, onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadImage(f); e.target.value = ""; } }),
					h(Btn, { primary: true, onClick: () => saveNow(false) }, "保存")
				)
			);

			const outline = outlineVisible
				? h(
						"div",
						{ style: { borderLeft: "1px solid " + C.borderLight, padding: "18px 10px", overflowY: "auto", boxSizing: "border-box" } },
						h("div", { style: { fontSize: 11, color: C.text2, fontWeight: 600, padding: "0 4px 6px", letterSpacing: 0.5 } }, "大纲"),
						headings.map((hd) =>
							h(
								"div",
								{ key: hd.ord, onClick: () => jumpHeading(hd), title: hd.text, style: { fontSize: 12, color: C.text1, padding: "4px 6px", paddingLeft: 6 + (hd.level - 1) * 10, cursor: "pointer", borderRadius: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
								hd.text || "（空标题）"
							)
						)
					)
				: null;

			const historyModal = h(
				Modal,
				{ open: histOpen, onClose: () => setHistOpen(false), title: "版本历史" },
				versions.length === 0
					? h("div", { style: { fontSize: 12, color: C.text2, padding: "8px 0" } }, "还没有可回滚的版本。每次正文变动都会留一个快照，最多保留 20 个。")
					: h(
							"div",
							{ style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: "54vh", overflowY: "auto" } },
							versions.slice().reverse().map((v) =>
								h(
									"div",
									{ key: v.rev, style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", border: "1px solid " + C.border, borderRadius: 8 } },
									h(
										"div",
										{ style: { flex: 1, minWidth: 0 } },
										h("div", { style: { fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, v.title || "未命名笔记"),
										h("div", { style: { fontSize: 11, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, relTime(v.savedAt || "—") + " · rev " + v.rev + " · " + mdPlainClient(v.content).slice(0, 40))
									),
									h(Btn, { onClick: () => restoreVersion(v), style: { padding: "4px 10px", fontSize: 12 } }, "恢复")
								)
							)
						)
			);

			const linkModal = h(
				Modal,
				{ open: linkOpen, onClose: () => setLinkOpen(false), title: "插入内链" },
				h("div", { style: { fontSize: 12, color: C.text2, marginBottom: 8 } }, "选一个待办或会议，插入形如 [标题](todo:id) 的链接；在预览里点击会跳到对应面板。"),
				h("div", { style: { fontSize: 12, fontWeight: 600, margin: "6px 0 4px" } }, "待办"),
				linkItems.todos.length === 0
					? h("div", { style: { fontSize: 11, color: C.text2 } }, "暂无待办")
					: linkItems.todos.map((it) => h("button", { key: it.id, type: "button", style: Object.assign({}, S.menuItem, { fontSize: 12.5 }), onClick: () => insertInternalLink("todo", it) }, it.title)),
				h("div", { style: { fontSize: 12, fontWeight: 600, margin: "10px 0 4px" } }, "会议"),
				linkItems.meetings.length === 0
					? h("div", { style: { fontSize: 11, color: C.text2 } }, "暂无会议")
					: linkItems.meetings.map((it) => h("button", { key: it.id, type: "button", style: Object.assign({}, S.menuItem, { fontSize: 12.5 }), onClick: () => insertInternalLink("meeting", it) }, (it.date || "") + " " + meetingTimeText(it) + " · " + it.title))
			);

			return h(
				"div",
				{ className: "tw-frame-page", style: { flex: 1, display: "grid", gridTemplateColumns: outlineVisible ? "240px minmax(0, 1fr) 168px" : "240px minmax(0, 1fr)", height: "100%", overflow: "hidden", background: C.page, color: C.text0, fontFamily: FONT, fontSize: 14, boxSizing: "border-box" } },
				sidebar,
				main,
				outline,
				historyModal,
				linkModal
			);
		}

		// ===== 工作台主面板（v3.8：一屏工作台） =====
		// 布局：左栏 今日日程（09:00–18:00 时间轴）+ 可勾选待办清单；
		//       右栏 本周进度环 + 最近笔记 + 快捷操作；底部 本周节奏（7 天点阵）。
		//       窄屏（窗口 <780px）自动切单列。
		// 数据：/tidywork-api 并行拉取 todos(all + done) / meetings(本月) / notes；
		//       勾选 → PATCH /todos/:id，行内新增 → POST /todos，均即时回写并重算。
		const HOME_WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
		const TL_START = 9;
		const TL_END = 18;
		const TL_HOUR = 44; // 每小时像素高；太小时 30 分钟会议块会被最小高度顶出格、压到下一场
		const TL_BLOCK_MIN = 20; // 块最小可视高度（px），用于「视觉占位」重叠判定
		const HM_ICON = {
			check: "M4 12l5 5L20 7",
			plus: "M12 5v14M5 12h14",
			cal: "M4 5h16v15H4V5zm12-3v5M8 2v5M4 11h16",
			list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
			note: "M6 3h9l4 4v14H6V3zm9 0v4h4M9 11h6M9 15h6",
			chat: "M4 5h16v10H9l-4 4v-4H5a1 1 0 01-1-1V5z",
			focus: "M12 4a8 8 0 100 16 8 8 0 000-16zm0 4a4 4 0 100 8 4 4 0 000-8z"
		};
		function pad2(n) { return String(n).padStart(2, "0"); }
		function ymd(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
		function parseYmd(s) { const p = String(s || "").split("-").map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1); }
		function shiftYmd(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
		function dayDiff(a, b) { return Math.round((parseYmd(a) - parseYmd(b)) / 86400000); }
		function weekStartOf(s) { return shiftYmd(s, -(((parseYmd(s).getDay() + 6) % 7))); }
		function hm(n) { return pad2(Math.floor(n)) + ":" + pad2(Math.round((n % 1) * 60)); }

		function HIcon(props) {
			return h(
				"svg",
				{ width: props.size || 15, height: props.size || 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", style: Object.assign({ flexShrink: 0 }, props.style || {}) },
				h("path", { d: HM_ICON[props.d] || props.d })
			);
		}
		function HCard(props) {
			return h("div", { style: Object.assign({ background: C.main, border: "1px solid " + C.border, borderRadius: 8, padding: "14px 16px 16px", boxSizing: "border-box", minWidth: 0 }, props.style || {}) }, props.children);
		}
		function HCardHead(props) {
			return h(
				"div",
				{ style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, minHeight: 22, flexWrap: "wrap" } },
				h("div", { style: { fontSize: 14, fontWeight: 600, color: C.text0, flexShrink: 0 } }, props.title),
				props.meta ? h("span", { style: { fontSize: 11, color: C.text2, flexShrink: 0 } }, props.meta) : null,
				props.action ? h("div", { style: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 } }, props.action) : null
			);
		}
		function HLink(props) {
			return h(
				"button",
				{ onClick: props.onClick, style: { border: "none", background: "transparent", color: C.accent, fontSize: 12, cursor: "pointer", fontFamily: FONT, padding: "2px 4px", borderRadius: 4 } },
				props.children
			);
		}

		function HomePage(props) {
			const [todos, setTodos] = useState(null);
			const [meetings, setMeetings] = useState(null);
			const [notes, setNotes] = useState(null);
			const [tab, setTab] = useState("recent");
			const [openEv, setOpenEv] = useState(null);
			const [draft, setDraft] = useState("");
			const [addDue, setAddDue] = useState("today");
			const [narrow, setNarrow] = useState(typeof window !== "undefined" ? window.innerWidth < 780 : false);
			const [err, setErr] = useState(null);
			const today = ymd(new Date());

			const reload = useCallback(() => {
				const wrap = (p) => p.then((d) => ({ ok: true, d: d })).catch((e) => ({ ok: false, msg: (e && e.message) || "请求失败" }));
				Promise.all([
					// view=all 现在返回全部（含已完成），不再用 all+done 拼（拼起来会重复计数）
					wrap(api("/tidywork-api/todos?view=all")),
					// 不传 month 拿全量会议：只拉当月会让"本周"跨月的会议漏掉
					wrap(api("/tidywork-api/meetings")),
					wrap(api("/tidywork-api/notes"))
				]).then(([a, m, n]) => {
					const errs = {};
					// 失败时保留上一次成功的数据，不把"加载失败"伪装成"没有数据"
					if (a.ok) setTodos(a.d || []); else errs.todos = a.msg;
					if (m.ok) setMeetings(m.d || []); else errs.meetings = m.msg;
					if (n.ok) setNotes(n.d || []); else errs.notes = n.msg;
					setErr(Object.keys(errs).length ? errs : null);
				});
			}, []);
			useEffect(() => { reload(); }, [reload]);
			useEffect(() => {
				const onResize = () => setNarrow(window.innerWidth < 780);
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			const open = (id) => props.openPanel && props.openPanel(id);

			// —— 派生数据（口径：due 归一成具体日期） ——
			const items = todos || [];
			const dueOf = (t) => {
				if (t.due === "today") return today;
				if (t.due === "tomorrow") return shiftYmd(today, 1);
				if (t.due === "yesterday") return shiftYmd(today, -1);
				if (t.due === "week") return shiftYmd(weekStartOf(today), 6);
				if (!t.due || t.due === "none") return null;
				return String(t.due).slice(0, 10);
			};
			const isLate = (t) => { const d = dueOf(t); return !t.done && !!d && dayDiff(today, d) > 0; };
			const totalN = items.length;
			const doneN = items.filter((t) => t.done).length;
			const todayCount = items.filter((t) => dueOf(t) === today).length;
			const lateN = items.filter(isLate).length;
			const openN = totalN - doneN;
			const weekS = weekStartOf(today);
			const weekE = shiftYmd(weekS, 6);
			// 「本周进度」只算本周区间内的待办，不再拿全量完成率冒充本周
			const weekItems = items.filter((t) => { const d = dueOf(t); return !!d && d >= weekS && d <= weekE; });
			const weekDoneN = weekItems.filter((t) => t.done).length;
			const weekRate = weekItems.length ? Math.round((weekDoneN / weekItems.length) * 100) : 0;
			const weekMeets = (meetings || []).filter((m) => { const d = String(m.date || "").slice(0, 10); return d >= weekS && d <= weekE; });
			const todayMeets = (meetings || [])
				.filter((m) => String(m.date || "").slice(0, 10) === today)
				.sort((a, b) => String(a.startTime || a.time || "").localeCompare(String(b.startTime || b.time || "")));
			// 接口返回已按「置顶优先、最后编辑倒序」排序，取前 4 条即最近笔记；
			// 之前写成 slice(-4).reverse() 取的是列表末尾（最旧）4 条，笔记一多就会显示旧笔记。
			const recentNotes = (notes || []).slice(0, 4);

			// —— 今日日程：视图范围与块几何（默认 09:00–18:00，有越界会议时向外扩展） ——
			const evBlocks = (() => {
				const bs = todayMeets.map((m) => {
					const toMin = (txt) => {
						const p = String(txt || "").split(":");
						const hh = Number(p[0]);
						const mm = Number(p[1]);
						return isNaN(hh) || isNaN(mm) ? null : hh + mm / 60;
					};
					const startMin = toMin(m.startTime || m.time);
					const start = startMin == null ? 0 : startMin;
					const endMin = toMin(m.endTime);
					// 老数据还可能只有 duration 自由文本，兜底解析一次；都没有就按 1 小时
					let end = endMin;
					if (end == null) {
						const mm = String(m.duration || "").match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
						end = mm ? Number(mm[3]) + Number(mm[4]) / 60 : start + 1;
					}
					if (end <= start) end = start + 1;
					// visEnd = 画面上真正占到的位置：短会（15/30 分钟）受最小块高限制，视觉上会比真实时长更高，
					// 重叠/分栏必须按这个算，否则相邻两场会各画一块、下压上一块。
					const visEnd = Math.max(end, start + TL_BLOCK_MIN / TL_HOUR);
					return { m, start, end, visEnd, lane: 0, laneN: 1 };
				}).sort((x, y) => x.start - y.start);
				let lo = TL_START, hi = TL_END;
				bs.forEach((b) => { lo = Math.min(lo, Math.floor(b.start)); hi = Math.max(hi, Math.ceil(Math.max(b.end, b.visEnd))); });
				// 重叠成簇 → 簇内左右分栏，避免块互相压住（按视觉占位 visEnd 判定，含最小块高外溢）
				const clusters = [];
				bs.forEach((b) => {
					let cl = null;
					for (let i = 0; i < clusters.length; i++) { if (b.start < clusters[i].end - 0.001) { cl = clusters[i]; break; } }
					if (!cl) { cl = { end: b.visEnd, items: [] }; clusters.push(cl); }
					cl.items.push(b);
					cl.end = Math.max(cl.end, b.visEnd);
				});
				clusters.forEach((cl) => {
					const lanes = [];
					cl.items.forEach((b) => {
						let li = -1;
						for (let i = 0; i < lanes.length; i++) { if (lanes[i] <= b.start + 0.001) { li = i; break; } }
						if (li === -1) { lanes.push(b.visEnd); b.lane = lanes.length - 1; }
						else { lanes[li] = b.visEnd; b.lane = li; }
					});
					cl.items.forEach((b) => { b.laneN = lanes.length; });
				});
				return { bs, lo, hi, over: bs.filter((b) => b.start < TL_START || b.end > TL_END).length };
			})();
			const rangeLabel = pad2(evBlocks.lo) + ":00 – " + pad2(evBlocks.hi) + ":00";

			const dueLabel = (t) => {
				const d = dueOf(t);
				if (!d) return "无期限";
				const delta = dayDiff(d, today); // 正数 = 未来，负数 = 已过期
				if (delta < 0 && !t.done) return "逾期 " + -delta + " 天";
				if (delta === 0) return t.done ? "今天 · 已完成" : "今天到期";
				if (delta === 1) return "明天";
				if (delta === -1) return "昨天";
				return parseYmd(d).getMonth() + 1 + "月" + parseYmd(d).getDate() + "日";
			};

			const inTab = (t) => {
				const d = dueOf(t);
				if (tab === "today") return d === today;
				if (tab === "late") return isLate(t);
				if (tab === "week") return !!d && d >= weekS && d <= weekE;
				if (tab === "recent") return !t.done || d === today;
				return true;
			};
			const countTab = (key) => {
				const probe = (t) => {
					const d = dueOf(t);
					if (key === "today") return d === today;
					if (key === "late") return isLate(t);
					if (key === "week") return !!d && d >= weekS && d <= weekE;
					if (key === "recent") return !t.done || d === today;
					return true;
				};
				return items.filter(probe).length;
			};
			const listItems = items.filter(inTab).slice().sort((a, b) => {
				if (a.done !== b.done) return a.done ? 1 : -1;
				const da = dueOf(a) || "9999-12-31";
				const db = dueOf(b) || "9999-12-31";
				return da.localeCompare(db);
			});

			// 显式设值，不做「再 toggle 一次」的反向撤销；写成功后回读一次校准本地状态
			const setDone = (id, done, title) => {
				api("/tidywork-api/todos/" + id, { method: "PATCH", body: JSON.stringify({ done: !!done }) })
					.then(() => {
						setTodos((cur) => (cur || []).map((x) => (x.id === id ? Object.assign({}, x, { done: !!done }) : x)));
						if (done) toast("已完成：" + (title || ""), { action: "撤销", onAction: () => setDone(id, false) });
						else toast("已恢复未完成");
						reload();
					})
					.catch((e) => toast(e.message));
			};
			const toggle = (t) => setDone(t.id, !t.done, t.title);
			const addTodo = () => {
				const title = draft.trim();
				if (!title) { toast("请输入待办内容"); return; }
				api("/tidywork-api/todos", { method: "POST", body: JSON.stringify({ title, priority: "mid", category: "工作", due: addDue || "today" }) })
					.then((created) => {
						// 服务端没回实体就重新拉一次，绝不造一个假 id（假 id 会让"勾选完成"打到 404）
						if (created && created.id) setTodos((cur) => (cur || []).concat([created]));
						else reload();
						setDraft("");
						setAddDue("today");
						toast("已添加：" + title);
					})
					.catch((e) => toast(e.message));
			};

			// —— 今日日程时间轴 ——
			const renderTimeline = () => {
				const bs = evBlocks.bs, lo = evBlocks.lo, hi = evBlocks.hi;
				const height = (hi - lo) * TL_HOUR;

				const gaps = [];
				let cursor = lo;
				bs.forEach((b) => {
					if (b.start - cursor >= 1.2) gaps.push({ from: cursor, to: Math.min(b.start, hi) });
					cursor = Math.max(cursor, b.end);
				});
				if (hi - cursor >= 1.2) gaps.push({ from: cursor, to: hi });

				const hourNodes = [];
				for (let hh = lo; hh <= hi; hh++) {
					hourNodes.push(h("div", { key: "h" + hh, style: { position: "absolute", top: (hh - lo) * TL_HOUR - 7, left: 0, fontSize: 11, color: C.text2 } }, pad2(hh) + ":00"));
					if (hh > lo) hourNodes.push(h("div", { key: "l" + hh, style: { position: "absolute", top: (hh - lo) * TL_HOUR, left: 0, right: 0, borderTop: "1px dashed " + C.borderLight } }));
				}

				const contentNodes = [];
				// 全天无会议时只保留一条空态提示，不再叠一条整段「可专注」
				if (bs.length) gaps.forEach((g, i) => {
					const top = (g.from - lo) * TL_HOUR + 4;
					const h2 = Math.max(24, (g.to - g.from) * TL_HOUR - 8);
					contentNodes.push(
						h(
							"div",
							{ key: "gap" + i, style: { position: "absolute", left: 6, right: 8, top, height: h2, borderRadius: 8, background: C.main, border: "1px dashed " + C.border, color: C.text2, fontSize: 11, display: "flex", alignItems: h2 >= 40 ? "flex-start" : "center", justifyContent: "flex-start", paddingLeft: 10, paddingTop: h2 >= 40 ? 7 : 0, gap: 6, boxSizing: "border-box" } },
							h(HIcon, { d: "focus", size: 12, style: { opacity: 0.55 } }),
							h("span", null, "可专注 " + hm(g.from) + "–" + hm(g.to))
						)
					);
				});

				// 当前时刻游标（仅今天、落在视图范围内时）
				const nowD = new Date();
				const nowH = nowD.getHours() + nowD.getMinutes() / 60;
				if (ymd(nowD) === today && nowH >= lo && nowH <= hi) {
					contentNodes.push(
						h("div", { key: "now", style: { position: "absolute", left: 0, right: 8, top: (nowH - lo) * TL_HOUR, height: 0, borderTop: "1.5px solid " + C.accent, zIndex: 3, pointerEvents: "none" } },
							h("span", { style: { position: "absolute", left: -3, top: -3.5, width: 6, height: 6, borderRadius: 3, background: C.accent } })
						)
					);
				}

				bs.forEach((b, i) => {
					const top = (b.start - lo) * TL_HOUR + 2;
					// 高度按真实时长，但不少于 TL_BLOCK_MIN；同时不能超过自己的视觉占位（visEnd），否则会压到下一块
					const h2 = Math.min(
						Math.max(TL_BLOCK_MIN, (b.end - b.start) * TL_HOUR - 4),
						(b.visEnd - b.start) * TL_HOUR - 2
					);
					const on = openEv === b.m.id;
					const compact = h2 < 34;
					const over = b.start < TL_START || b.end > TL_END;
					const w = "calc(" + (100 / b.laneN).toFixed(4) + "% - 8px)";
					const lx = "calc(" + ((b.lane / b.laneN) * 100).toFixed(4) + "% + 3px)";
					contentNodes.push(
						h(
							"button",
							{
								key: "ev" + i,
								onClick: () => setOpenEv(on ? null : b.m.id),
								title: b.m.title + "（" + meetingTimeText(b.m) + "）",
								style: {
									position: "absolute", left: lx, width: w, top, height: h2, boxSizing: "border-box",
									textAlign: "left", cursor: "pointer", fontFamily: FONT,
									background: on ? "#e3ebff" : C.accentSoft,
									border: "1px solid " + (on ? "#b9cdff" : "#d6e0ff"),
									borderRadius: 8, padding: compact ? "2px 7px" : "5px 9px", overflow: "hidden"
								}
							},
							h("div", { style: { fontSize: compact ? 11.5 : 12, fontWeight: 600, color: C.accent, display: "flex", gap: 6, lineHeight: compact ? 1.2 : 1.35 } },
								h("span", { style: { flexShrink: 0 } }, String(b.m.startTime || b.m.time || "")),
								h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, b.m.title),
								over ? h("span", { style: { flexShrink: 0, fontSize: 10, fontWeight: 500, color: "#8a93a6", background: "#eef1f6", borderRadius: 4, padding: "0 4px", lineHeight: "15px" } }, b.start < TL_START ? "早于视图" : "晚于视图") : null
							),
							compact ? null : h("div", { style: { fontSize: 11, color: C.text1, marginTop: 1, display: "flex", gap: 8, flexWrap: "wrap", lineHeight: 1.3 } },
								h("span", null, b.m.location || ""), h("span", null, (b.m.participants || 0) + " 人")),
							(on && !compact) ? h("div", { style: { fontSize: 11, color: C.text1, marginTop: 4, paddingTop: 4, borderTop: "1px dashed #b9cdff" } }, meetingTimeText(b.m) + " · 点击「会议」查看完整信息") : null
						)
					);
				});

				if (!bs.length) {
					contentNodes.push(
						h("div", { key: "empty", style: { position: "absolute", left: 12, right: 12, top: Math.round(height / 2) - 11, fontSize: 12, color: C.text2, display: "flex", alignItems: "center", gap: 6 } },
							h(HIcon, { d: "focus", size: 12, style: { opacity: 0.55 } }),
							"今天没有会议，整段可专注 " + pad2(lo) + ":00 – " + pad2(hi) + ":00"
						)
					);
				}

				return h(
					"div",
					{ style: { display: "grid", gridTemplateColumns: "44px 1fr", minWidth: 0 } },
					h("div", { style: { position: "relative", height } }, hourNodes),
					h("div", { style: { position: "relative", height, borderLeft: "1px solid " + C.borderLight } }, contentNodes)
				);
			};

			// —— 本周节奏（右栏竖排：日期 · 点阵 · 文案） ——
			const renderWeek = () => {
				const days = [];
				for (let i = 0; i < 7; i++) days.push(shiftYmd(weekS, i));
				return h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 1 } },
					days.map((d) => {
						const dt = parseYmd(d);
						const ts = items.filter((t) => dueOf(t) === d);
						const tsDone = ts.filter((t) => t.done).length;
						const mc = (meetings || []).filter((m) => String(m.date || "").slice(0, 10) === d).length;
						const isToday = d === today;
						const dots = ts.slice(0, 5);
						const label = ts.length ? tsDone + "/" + ts.length + " 项" + (mc ? " · " + mc + " 会" : "") : mc ? mc + " 场会议" : "空闲";
						return h(
							"div",
							{ key: d, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 6px", borderRadius: 7, background: isToday ? C.accentSoft : "transparent" } },
							h("span", { style: { fontSize: 11.5, color: isToday ? C.accent : C.text2, width: 62, flexShrink: 0, whiteSpace: "nowrap" } }, HOME_WEEK[dt.getDay()].slice(1) + " " + (dt.getMonth() + 1) + "/" + dt.getDate()),
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: 4, minWidth: 34, flexShrink: 0 } },
								dots.length
									? dots.map((t, i) => h("span", { key: i, title: t.title, style: { width: 9, height: 9, borderRadius: 2, background: t.done ? C.accent : "transparent", border: "1.5px solid " + (t.done ? C.accent : isLate(t) ? C.danger : C.text2), boxSizing: "border-box" } }))
									: h("span", { style: { fontSize: 10, color: "#c9ced8" } }, "—"),
								ts.length > 5 ? h("span", { style: { fontSize: 9, color: C.text2 } }, "+" + (ts.length - 5)) : null
							),
							h("span", { style: { fontSize: 10.5, color: isToday ? C.accent : C.text2, marginLeft: "auto", whiteSpace: "nowrap" } }, label)
						);
					})
				);
			};

			const tabDefs = [["recent", "近期"], ["today", "今天"], ["late", "逾期"], ["week", "本周"], ["all", "全部"]];

			return h(
				"div",
				{ style: { flex: 1, display: "flex", flexDirection: "column", height: "100%", background: C.page, color: C.text0, fontFamily: FONT, fontSize: 14, boxSizing: "border-box", minHeight: 0, overflowY: "auto" } },

				// 顶栏。data-window-drag 是 macOS 桌面端的窗口拖拽标记：
				// DSH 只认 html[data-platform='darwin'] [data-window-drag] 这一条规则，
				// 没标记的行拖不动窗口；标记后按钮会被宿主的全局规则自动减除，照常可点。
				h(
					"div",
					{ "data-window-drag": true, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "calc(14px + var(--dsh-frame-top-clearance, 0px)) 20px 10px", flexShrink: 0, borderBottom: "1px solid " + C.borderLight, background: C.main } },
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 6 } },
						h("div", { style: { fontSize: 16, fontWeight: 600, display: "flex", alignItems: "center" } }, h("span", { style: { color: C.text0 } }, "Tidy"), h("span", { style: { color: C.accent } }, "Work")),
						h("span", { style: { fontSize: 12, color: C.text2, marginLeft: 4 } }, "工作台")
					),
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", gap: 8 } },
						// v3.16：下拉与「开始对话」一并去掉 —— 三个分项都进同一个今日会话、用的是同一段系统提示，
						// 留着只是三个按钮做同一件事。现在点它 = 回到今天的 TidyWork 会话。
						h(
							"button",
							{
								id: "tw-new-btn",
								onClick: () => { if (props.openTodayWork) props.openTodayWork(); },
								style: Object.assign({}, S.btnPrimary, { display: "flex", alignItems: "center", gap: 5 })
							},
							"＋ 新建工作项"
						),
						h(MailBar, { onDone: reload }),
						h("button", { type: "button", onClick: exportAll, title: "导出全部数据为 JSON 备份", style: S.btnGhost }, "导出")
					)
				),

				// 标题行
				h(
					"div",
					{ style: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, padding: "18px 20px 14px", flexWrap: "wrap", flexShrink: 0 } },
					h(
						"div",
						{ style: { minWidth: 0 } },
						h("div", { style: { fontSize: 24, fontWeight: 600, letterSpacing: -0.3, display: "flex", alignItems: "baseline", gap: 8 } }, parseYmd(today).getMonth() + 1 + "月" + parseYmd(today).getDate() + "日", h("span", { style: { fontSize: 13, fontWeight: 400, color: C.text2 } }, HOME_WEEK[parseYmd(today).getDay()])),
						h(
							"div",
							{ style: { fontSize: 12.5, color: C.text1, marginTop: 5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
							h("span", null, "今天 " + todayMeets.length + " 场会议 · " + openN + " 项待办未完成"),
							lateN ? h("span", { style: { color: C.danger, background: tint(C.danger, 12), borderRadius: 5, padding: "1px 7px", fontSize: 11, fontWeight: 500 } }, lateN + " 项逾期") : null
						)
					)
				),

				// 加载失败警示条（保留上次数据，不假装是空数据）
				!err
					? null
					: h(
						"div",
						{ style: { margin: "0 20px 10px", padding: "8px 12px", borderRadius: 8, background: tint(C.danger, 10), border: "1px solid " + tint(C.danger, 26), color: C.danger, fontSize: 12, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 } },
						h("span", { style: { flex: 1, minWidth: 0 }, title: (err.todos || err.meetings || err.notes) || "" },
							(err.todos ? "待办" : err.meetings ? "会议" : "笔记") + "数据加载失败，当前显示上一次成功的数据。"),
						h(
							"button",
							{ onClick: reload, style: { border: "1px solid " + tint(C.danger, 32) + "", background: C.main, color: C.danger, fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 6, cursor: "pointer", fontFamily: FONT, flexShrink: 0 } },
							"重试"
						)
					),

				// 主体两栏
				h(
					"div",
					{ style: { display: "grid", gridTemplateColumns: narrow ? "1fr" : "minmax(0,1fr) 316px", gap: 14, padding: "0 20px 14px", alignItems: "start", flexShrink: 0 } },

					// 左栏
					h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: 14, minWidth: 0 } },

						// ① 今日日程
						h(
							HCard,
							null,
							h(HCardHead, { title: "今日日程", meta: evBlocks.over ? rangeLabel + " · 含 " + evBlocks.over + " 场越界" : rangeLabel, action: h(HLink, { onClick: () => open("tidywork-meetings") }, "全部会议 →") }),
							renderTimeline()
						),

						// ② 待办
						h(
							HCard,
							null,
							h(
								HCardHead,
								{
									title: "待办",
									action: h(
										"div",
										{ style: { display: "flex", gap: 2, background: C.page, borderRadius: 7, padding: 2 } },
										tabDefs.map(([key, label]) =>
											h(
												"button",
												{
													key,
													onClick: () => setTab(key),
													style: {
														border: "none", cursor: "pointer", fontFamily: FONT, fontSize: 11.5,
														padding: "4px 8px", borderRadius: 5,
														background: tab === key ? C.main : "transparent",
														color: tab === key ? C.text0 : C.text1,
														fontWeight: tab === key ? 600 : 400,
														boxShadow: tab === key ? "0 1px 2px rgba(0,0,0,0.06)" : "none"
													}
												},
												label,
												h("span", { style: { color: C.text2, marginLeft: 2 } }, String(countTab(key)))
											)
										)
									)
								}
							),
							listItems.length
								? h(
									"div",
									{ style: { display: "flex", flexDirection: "column" } },
									listItems.map((t, i) =>
										h(
											"div",
											{
												key: t.id,
												style: { display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 2px", borderBottom: i === listItems.length - 1 ? "none" : "1px solid " + C.borderLight }
											},
											h(
												"button",
												{
													onClick: () => toggle(t),
													"aria-label": (t.done ? "标记为未完成：" : "标记为完成：") + t.title,
													style: {
														width: 34, height: 34, marginTop: -6, marginLeft: -8, flexShrink: 0,
														boxSizing: "border-box", cursor: "pointer", padding: 0, border: "none", background: "transparent",
														display: "flex", alignItems: "center", justifyContent: "center"
													}
												},
												h(
														"div",
														{ style: { width: 18, height: 18, boxSizing: "border-box", borderRadius: 5, border: "1.5px solid " + (t.done ? C.accent : C.text2), background: t.done ? C.accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: C.onAccent } },
														t.done ? h(HIcon, { d: "check", size: 10 }) : null
													)
											),
											h(
												"div",
												{ style: { flex: 1, minWidth: 0 } },
												h(
													"div",
													{ style: { fontSize: 13, display: "flex", alignItems: "center", gap: 7, color: t.done ? C.text2 : C.text0, textDecoration: t.done ? "line-through" : "none" } },
													h("span", { style: { width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: (PRIORITY[t.priority] || PRIORITY.mid).color } }),
													h("span", { title: t.title, style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, t.title)
												),
												h(
													"div",
													{ style: { fontSize: 11, color: C.text2, marginTop: 1, display: "flex", gap: 8 } },
													h("span", null, t.category || "未分类"),
													h("span", { style: isLate(t) ? { color: C.danger, fontWeight: 500 } : null }, dueLabel(t))
												)
											),
											h(
												"button",
												{ onClick: () => open("tidywork-todos"), style: { border: "none", background: "transparent", color: C.text2, fontSize: 11, cursor: "pointer", fontFamily: FONT, padding: "3px 4px", flexShrink: 0 } },
												"编辑"
											)
										)
									)
								)
								: h("div", { style: { fontSize: 12.5, color: C.text2, padding: "14px 2px" } }, todos === null ? "待办数据未加载，请点上方「重试」。" : "这个视图里还没有待办。"),

							// 行内新增
							h(
								"div",
								{ style: { display: "flex", alignItems: "center", gap: 8, marginTop: 10, paddingTop: 10, borderTop: "1px dashed " + C.border } },
								h(HIcon, { d: "plus", size: 14, style: { color: C.accent } }),
								h("input", {
									id: "tw-home-add",
									value: draft,
									onChange: (e) => setDraft(e.target.value),
									onKeyDown: (e) => { if (e.key === "Enter") addTodo(); },
									placeholder: "添加一条待办，回车确认",
									style: { flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 13, color: C.text0, fontFamily: FONT, padding: "5px 0" }
								}),
								h(DuePicker, { compact: true, value: addDue, onChange: setAddDue }),
								h(
									"button",
									{ onClick: addTodo, style: { border: "none", background: "transparent", color: C.accent, fontSize: 12, cursor: "pointer", fontFamily: FONT, padding: "4px 6px", borderRadius: 5, flexShrink: 0 } },
									"添加"
								)
							)
						)
					),

					// 右栏
					h(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: 14, minWidth: 0 } },

						// ④ 本周进度
						h(
							HCard,
							null,
							h(HCardHead, { title: "本周进度", meta: (parseYmd(weekS).getMonth() + 1) + "月" + parseYmd(weekS).getDate() + "日 – " + (parseYmd(weekE).getMonth() + 1) + "月" + parseYmd(weekE).getDate() + "日" }),
								h(
									"div",
									{ style: { display: "flex", flexDirection: "column", gap: 14 } },
									// v3.25：环换成「数字 + 2px 量尺」，与新版设计稿一致。
									h(
										"div",
										{ style: { display: "flex", alignItems: "baseline", gap: 8 } },
										h("div", { style: { fontSize: 46, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1 } }, String(weekRate)),
										h("span", { style: { fontSize: 12, color: C.text2 } }, "% 完成")
									),
									h(
										"div",
										{ style: { position: "relative", height: 2, background: C.border, flexShrink: 0 } },
										h("div", { style: { position: "absolute", left: 0, top: 0, height: 2, width: weekRate + "%", background: C.accent, transition: "width .4s ease" } })
									),
									h(
										"div",
										{ style: { display: "flex", flexDirection: "column", gap: 7 } },
										h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } }, h("span", { style: { color: C.text1 } }, "本周已完成 / 本周待办"), h("span", { style: { fontWeight: 600 } }, weekDoneN + " / " + weekItems.length)),
										h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } }, h("span", { style: { color: C.text1 } }, "今天待办"), h("span", { style: { fontWeight: 600 } }, todayCount + " 条")),
										h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } }, h("span", { style: { color: C.text1 } }, "逾期未完成"), h("span", { style: { fontWeight: 600, color: lateN ? C.danger : C.text0 } }, lateN + " 条")),
										h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } }, h("span", { style: { color: C.text1 } }, "本周会议"), h("span", { style: { fontWeight: 600 } }, weekMeets.length + " 场"))
									)
								),
							h("div", { style: { marginTop: 10, paddingTop: 9, borderTop: "1px solid " + C.borderLight, fontSize: 11, color: C.text2 } },
								totalN === 0 ? "还没有待办，先加一条吧。" : openN ? "还剩 " + openN + " 条未完成" + (lateN ? "，其中 " + lateN + " 条已逾期。" : "。") : "待办全部完成，今天可以收尾了。")
						),

						// ⑤ 最近笔记
						h(
							HCard,
							null,
							h(HCardHead, { title: "最近笔记", action: h(HLink, { onClick: () => open("tidywork-notes") }, "全部 →") }),
							recentNotes.length
								? recentNotes.map((n) =>
									h(
										"button",
										{
											key: n.id,
											onClick: () => open("tidywork-notes"),
											style: { display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent", cursor: "pointer", fontFamily: FONT, padding: "7px 6px", borderRadius: 6 }
										},
										h(
											"div",
											{ style: { fontSize: 12.5, fontWeight: 500, color: C.text0, display: "flex", alignItems: "center", gap: 6 } },
											h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, n.title || "无标题"),
											h("span", { style: { fontSize: 10.5, color: C.text2, fontWeight: 400, flexShrink: 0 } }, relTime(n.updatedAt || ""))
										),
										h("div", { style: { fontSize: 11, color: C.text2, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, n.preview || "")
									)
								)
								: h("div", { style: { fontSize: 12.5, color: C.text2, padding: "12px 2px" } }, "还没有笔记，去创建一篇吧")
						),

						// ⑥ 本周节奏（原底部全宽点阵改为右栏竖排，一屏更紧凑）
						h(
							HCard,
							null,
							h(HCardHead, { title: "本周节奏", meta: "实心已完成 · 空心未完成 · 红边逾期" }),
							renderWeek()
						)
					)
				),

			);
		}

		// ===== 侧边栏图标（16×16 填充 SVG） =====
		function makeIcon(path) {
			return function SideIcon() {
				return h(
					"svg",
					{ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", style: { flexShrink: 0 } },
					h("path", { d: path, fill: "currentColor" })
				);
			};
		}
		const Icons = {
			home: makeIcon("M1 8l7-6 7 6v7a1 1 0 0 1-1 1h-4v-5H6v5H2a1 1 0 0 1-1-1V8z"),
			todos: makeIcon("M2 3h9v2H2V3zm0 4h9v2H2V7zm0 4h6v2H2v-2zm9-1l2 2 3.5-3.5L16 9.5 13 12.5 11 10.5l1-1z"),
			meetings: makeIcon("M3 2h2v2h6V2h2v2h2v9H1V4h2V2zm-1 7h12V6H2v3zm3 4v2H3v-2h2zm8 0v2h-2v-2h2z"),
			notes: makeIcon("M2 2h12v2H2V2zm0 4h12v2H2V6zm0 4h8v2H2v-2zm10 0h2v5h-2v-5zm-3 0h2v3H9v-3z")
		};

		// ===== 客户端插件注册 =====
		const inject = ["slots", "locale", "layout", "workspaces", "uiWorkspace", "sessions"];
		const NS = "tidywork";
		const HOME = { id: "tidywork-home", order: -10, labelKey: "home" };
		const PANELS = [
			{ id: "tidywork-todos", kind: "todos", labelKey: "todos", order: -8 },
			{ id: "tidywork-meetings", kind: "meetings", labelKey: "meetings", order: -7 },
			{ id: "tidywork-notes", kind: "notes", labelKey: "notes", order: -6 }
		];

		// ===== 页面样式注入（不再改宿主的 title / favicon）=====
		// v3.23：侧边栏品牌连文字一起交回宿主后，标签页标题与图标也恢复 DSH 原样（DeepSeek Harness + 鲸鱼），
		// 这里只负责把主题变量和笔记 Markdown 样式注入 head；DSH 路由切换会重建 head，
		// 用 MutationObserver 守着，并在内部做幂等判断，避免自己改自己形成死循环。

		function applyBranding() {
			if (typeof document === "undefined") return () => {};
			// 主题变量：强调色/状态色的深浅两套，一次性注入 head；DSH 路由切换会重建 head，
			// 所以跟着下面的观察器一起补回（已有就跳过，避免自触发循环）。
			const setTheme = () => {
				if (document.getElementById("tidywork-theme")) return;
				const st = document.createElement("style");
				st.id = "tidywork-theme";
				st.textContent = THEME_CSS;
				document.head.appendChild(st);
				// 笔记的 Markdown 样式也随 head 一起补回（DSH 路由切换会重建 head）
				ensureMdCss();
			};
			setTheme();

			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				// 不用 rAF：后台标签页里 rAF 会被浏览器节流，修正就永远不执行。setTimeout 不受此限。
				const raf = (fn) => setTimeout(fn, 0);
				raf(() => {
					scheduled = false;
					ensureMdCss();
					setTheme();
				});
			};
			const mo = new MutationObserver(schedule);
			if (document.head) mo.observe(document.head, { childList: true, subtree: true, characterData: true });
			return () => mo.disconnect();
		}

		/** 应用主体：工作台主面板 + 3 组侧边栏入口/主面板（品牌保持宿主原样）。 */
		function apply(ctx) {
			// 让页面里的「＋ 新增」能拿到宿主服务（工作区 / 会话 / 布局）
			hostCtx = ctx;
			// 「新会话」落默认工作区、「新建工作项」落 TidyWork 当天会话：两个入口分开
			ctx.effect(() => installNewSessionRouting(ctx), "tidywork: new-session-routing");
			// 主题与 Markdown 样式注入（跟随页面生命周期）
			ctx.effect(() => applyBranding(), "tidywork: branding");

			// 中文 / 英文各一份：之前 en 直接复用中文 dict，英文环境会冒出中文标签
			const dictZh = { home: "工作台", todos: "待办", meetings: "会议", notes: "笔记" };
			const dictEn = { home: "Workboard", todos: "Todos", meetings: "Meetings", notes: "Notes" };
			ctx.effect(() => ctx.locale.register(NS, { zh: dictZh, en: dictEn }), "tidywork: locale");
			const t = ctx.locale.bind(NS);
			const pages = { todos: TodosPage, meetings: MeetingsPage, notes: NotesPage };

			// —— 品牌：v3.23 起完全交回宿主 ——
			// 之前用 priority -100 遮蔽官方品牌：图标记成蓝底「T」方块、文字改成「TidyWork」。
			// 用户要求侧边栏顶部「完整使用原本 DSH 的样子」，所以 mark 与 name 两个槽位都不再注册，
			// 回落到宿主默认（DeepSeek 鲸鱼图标 + DeepSeek Harness）。
			// 与 DSH 原生入口之间的分隔线本来挂在品牌 mark 的 <style> 上，现在随 THEME_CSS 注入。

			// —— 工作台主面板（order 最前，默认首屏） ——
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: HOME.id, order: HOME.order, locale: NS, label: () => t("home") }, Icons.home)
			);
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{ name: "main", key: HOME.id, locale: NS, inject: () => ({
						openConversation: () => ctx.layout.selectPanel(null),
						openPanel: (id) => ctx.layout.selectPanel(id),
						// v3.16：新建工作项 = 回到今天的 TidyWork 会话（必要的话先建工作区 / 会话）
						openTodayWork: () => openTodayWorkItem(ctx)
					}) },
					HomePage
				)
			);

			// —— 3 个工作区面板 ——
			for (const panel of PANELS) {
				const id = panel.id;
				const key = panel.kind;
				ctx.slots.inject("sidebar.panellist", () =>
					ctx.slots.register({ name: "sidebar.panellist", id, order: panel.order, locale: NS, label: () => t(panel.labelKey) }, Icons[key])
				);
				ctx.slots.inject("main", () =>
					ctx.slots.register({ name: "main", key: id, locale: NS, inject: () => ({ openPanel: (pid) => ctx.layout.selectPanel(pid) }) }, pages[key])
				);
			}

			// —— 恢复上次停留的面板（首次安装才落回工作台） ——
			// 之前每次启动都无条件 selectPanel(HOME)，用户停在"笔记"里一刷新就被弹回首页。
			const LAST_PANEL_KEY = "tidywork:lastPanel";
			const validPanels = [HOME.id].concat(PANELS.map((p) => p.id));
			const rememberPanel = (id) => {
				try { localStorage.setItem(LAST_PANEL_KEY, id || HOME.id); } catch (e) { /* 隐私模式忽略 */ }
			};
			ctx.effect(() => {
				// panelInfo 是 ObservableSnapshot：getSnapshot() + subscribe(fn)（宿主 ui-layout 的稳定契约）
				const src = ctx.layout && ctx.layout.panelInfo;
				if (!src || !src.subscribe) return () => {};
				const read = () => {
					try {
						const snap = src.getSnapshot ? src.getSnapshot() : null;
						const id = snap && snap.activePanelId;
						if (id && validPanels.indexOf(id) !== -1) rememberPanel(id);
					} catch (e) { /* 快照读取失败不影响主流程 */ }
				};
				read();
				return src.subscribe(read);
			}, "tidywork: remember-panel");

			setTimeout(() => {
				let want = HOME.id;
				try { const saved = localStorage.getItem(LAST_PANEL_KEY); if (saved && validPanels.indexOf(saved) !== -1) want = saved; } catch (e) { /* ignore */ }
				try {
					ctx.layout.selectPanel(want);
				} catch (e) {
					/* layout 未就绪则保持 DSH 默认对话页 */
				}
			}, 150);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
