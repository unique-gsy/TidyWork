// TidyWork 工作区插件 · 客户端半（浏览器）
// 按 DSH 客户端插件契约：window.__ModuleLoader__.load({id, factory})，
// factory 接收 require，导出 apply/inject。
// v3.1 变更：
//   1) 注册 sidebar.brand.mark / sidebar.brand.name —— 侧边栏品牌换成 TidyWork
//      logo（渐变蓝底 T 标 + "Tidy"黑/"Work"蓝）。
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
window.__ModuleLoader__.load({
	id: "@tidywork/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let { useEffect, useState, useCallback } = react;

		// ===== 常量：工作台色板（跟随 DSH 宿主主题）=====
		// DSH 用 body[data-ds-dark-theme] 切换深浅，并把所有颜色发布成 --dsw-alias-* 设计 token。
		// 这里全部改读宿主的 token，插件就不再自绘一套浅色皮肤：侧栏深、工作台也深，
		// 卡片比底色亮一档、边框是半透明白，跟侧栏同一套语言。第二个参数是脱离宿主时的兜底原值。
		// --tw-*（强调色与状态色）由 injectThemeCss() 按主题注入两套，见下。
		const C = {
			// 页面底色不能用 bg-base：宿主浅色主题下它就是纯白，和卡片（layer-1 也是纯白）
			// 会糊成一片。这里按 4% 文字色压暗一档——浅色得到 #f4f4f4（正是原来的灰底），
			// 深色得到比 #151517 略亮的深灰，卡片仍亮一档，两种主题都有层次。
			page: "color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 4%, var(--dsw-alias-bg-base, #fff))",
			main: "var(--dsw-alias-bg-layer-1, #ffffff)",
			// 宿主的 layer-2/3 在浅色主题下与 layer-1 同值，做不出 hover/active，
			// 因此改用文字色叠加：浅色叠黑、深色叠白，两个主题下都看得见。
			hover: "color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 6%, transparent)",
			active: "color-mix(in srgb, var(--dsw-alias-label-primary, #1f2329) 12%, transparent)",
			input: "var(--dsw-alias-bg-layer-2, #ffffff)",
			border: "var(--dsw-alias-border-l2, #e5e6eb)",
			borderLight: "var(--dsw-alias-border-l1, #f0f0f0)",
			text0: "var(--dsw-alias-label-primary, #1f2329)",
			text1: "var(--dsw-alias-label-secondary, #646a73)",
			text2: "var(--dsw-alias-label-caption, #8f959e)",
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
			"--tw-accent:#3370ff;",
			"--tw-accent-hover:#2860e1;",
			"--tw-accent-soft:rgba(51,112,255,0.08);",
			"--tw-success:#34c759;",
			"--tw-warning:#ff9500;",
			"--tw-danger:#ff3b30;",
			"--tw-on-accent:#ffffff;",
			"--tw-toast-bg:#1f2329;",
			"}",
			"body[data-ds-dark-theme]{",
			"--tw-accent:#6b9fff;",
			"--tw-accent-hover:#8ab0ff;",
			"--tw-accent-soft:rgba(107,159,255,0.16);",
			"--tw-success:#30d158;",
			"--tw-warning:#ffd60a;",
			"--tw-danger:#ff453a;",
			"--tw-on-accent:#ffffff;",
			"--tw-toast-bg:#3a3a3c;",
			"}"
		].join("");
		const FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif";
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
		// ===== 会话跳转（v3.5）：+新增/+新建 → 复用/新建固定命名会话 =====
		const SESSION_KEYS = { todo: "tidywork.todoSessionId", meeting: "tidywork.meetingSessionId" };
		const SESSION_NAMES = { todo: "新建待办事项", meeting: "新建会议管理" };

		function findSessionRow(sid) {
			return document.querySelector('div[data-row-key="session:' + sid + '"]');
		}
		function sessionRows() {
			return [...document.querySelectorAll('div[data-row-key^="session:"]')];
		}
		function ensureSidebarOpen() {
			const openBtn = document.querySelector('button[aria-label="打开侧边栏"]');
			if (openBtn) { openBtn.click(); return true; }
			return false;
		}
		function expandCollapsedSessions() {
			const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").indexOf("展开其余") !== -1);
			if (btn) btn.click();
		}
		function findComposer() {
			return document.querySelector('[contenteditable="true"][aria-label*="描述你想要构建"]')
				|| document.querySelector('[contenteditable="true"]')
				|| document.querySelector("textarea")
				|| document.querySelector('[role="textbox"]');
		}
		function sendToComposer(text) {
			const ta = findComposer();
			if (!ta) return false;
			ta.focus();
			try {
				ta.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true }));
			} catch (e) {}
			// 编辑器异步渲染文本，延迟后再点发送
			setTimeout(() => {
				const btn = [...document.querySelectorAll("button")].find((b) => {
					const t = (b.getAttribute("aria-label") || "") + (b.textContent || "");
					return t.indexOf("发送消息") !== -1 || /send/i.test(b.getAttribute("aria-label") || "");
				});
				if (btn && !btn.disabled) btn.click();
			}, 500);
			return true;
		}
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
		/** 打开今天的 TidyWork 会话；没有就按 ①→②→③ 建出来。 */
		async function openTodayWorkItem(ctx) {
			try {
				let ws = await findTidyWorkspace(ctx);
				if (!ws) {
					const dir = await ensureWorkspaceDir(ctx);
					if (!dir) return;
					ws = await ctx.workspaces.create({ path: dir });
				}
				const rec = readTodaySession();
				const today = ymdLocal(new Date());
				// 只有"日期是今天"且"会话仍在这个工作区里"才算命中——昨天那个会话今天又被翻动，不该复用
				if (rec && rec.d === today && Array.isArray(ws.sessionIds) && ws.sessionIds.indexOf(rec.id) !== -1) {
					ctx.uiWorkspace.openSession(rec.id);
					return;
				}
				const sid = await ctx.uiWorkspace.connectWorkspace(ws.workspaceId);
				writeTodaySession(sid);
				ctx.uiWorkspace.openSession(sid);
			} catch (e) {
				toast("打不开今日会话：" + ((e && e.message) || "未知错误"));
			}
		}

		async function openTidySession(kind, fallback) {
			// 1) 复用：已有固定命名会话 → 打开它
			const sid = localStorage.getItem(SESSION_KEYS[kind]);
			if (sid) {
				let row = findSessionRow(sid);
				if (!row) {
					ensureSidebarOpen();
					expandCollapsedSessions();
					await sleep(400);
					row = findSessionRow(sid);
				}
				if (row) { row.click(); return; }
				localStorage.removeItem(SESSION_KEYS[kind]);
			}
			// 2) 新建：先展开侧边栏并收集发送前会话集合（排除既有会话，防误匹配）
			ensureSidebarOpen();
			await sleep(400);
			const before = new Set(sessionRows().map((e) => e.getAttribute("data-row-key")));
			const btn = document.querySelector('button[aria-label="新建会话"]');
			if (!btn) { if (fallback) fallback(); return; }
			btn.click();
			let ta = null;
			for (let i = 0; i < 25; i++) {
				await sleep(200);
				ta = findComposer();
				if (ta) break;
			}
			if (!ta) { if (fallback) fallback(); return; }
			// 3) 自动发送标题锚定消息（首条消息 = 会话名，DSH 标题由此生成）
			sendToComposer(SESSION_NAMES[kind]);
			// 5) 等固定命名会话行出现（发送后新增 + 标题含名称），记录 id 供复用
			for (let i = 0; i < 60; i++) {
				await sleep(500);
				let rows = sessionRows();
				if (rows.length === 0) { ensureSidebarOpen(); await sleep(300); rows = sessionRows(); }
				if (rows.length === 0) { expandCollapsedSessions(); await sleep(300); rows = sessionRows(); }
				const row = rows.find((r) => {
					if (before.has(r.getAttribute("data-row-key"))) return false;
					return (r.textContent || "").indexOf(SESSION_NAMES[kind]) !== -1;
				});
				if (row) {
					const id = (row.getAttribute("data-row-key") || "").replace("session:", "");
					if (id) localStorage.setItem(SESSION_KEYS[kind], id);
					return;
				}
			}
		}

		/** 调用 /tidywork-api 路由（path 已含 /tidywork-api 前缀）：ok 时 resolve(data)，失败 reject(error)。 */
		function api(path, opts) {
			const init = Object.assign({ headers: { "Content-Type": "application/json" } }, opts || {});
			return fetch(path, init)
				.then((r) => r.json())
				.then((j) => {
					if (j && j.ok) return j.data;
					throw new Error((j && j.error) || "请求失败");
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
			statGrid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 24 },
			statCard: { background: C.main, border: "1px solid " + C.border, borderRadius: 12, padding: 16 },
			statLabel: { fontSize: 12, color: C.text2, marginBottom: 4 },
			statValue: { fontSize: 24, fontWeight: 700 },
			headRow: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
			viewTitle: { fontSize: 18, fontWeight: 600 },
			chip: { padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500, color: C.text1, background: "transparent", border: "1px solid " + C.border, cursor: "pointer", fontFamily: FONT },
			chipActive: { background: C.accentSoft, color: C.accent, borderColor: "transparent" },
			card: { background: C.main, border: "1px solid " + C.border, borderRadius: 12, overflow: "hidden" },
			empty: { padding: 40, textAlign: "center", color: C.text2, background: C.hover, borderRadius: 12, fontSize: 13 },
			input: { width: "100%", padding: "8px 10px", border: "1px solid " + C.border, borderRadius: 6, background: C.input, fontSize: 13, color: C.text0, outline: "none", boxSizing: "border-box", fontFamily: FONT },
			select: { width: "100%", padding: "8px 10px", border: "1px solid " + C.border, borderRadius: 6, background: C.input, color: C.text0, fontSize: 13, boxSizing: "border-box", fontFamily: FONT },
			btnGhost: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 6, border: "1px solid " + C.border, color: C.text1, fontSize: 13, cursor: "pointer", background: C.main, fontFamily: FONT },
			btnPrimary: { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 16px", borderRadius: 6, background: C.accent, color: C.onAccent, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "none", fontFamily: FONT },
			modalOverlay: { position: "fixed", inset: 0, background: C.mask, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000 },
			modal: { width: 440, maxWidth: "92vw", background: C.main, border: "1px solid " + C.border, borderRadius: 12, boxShadow: "0 8px 32px rgba(0,0,0,0.16)", padding: 20, boxSizing: "border-box" },
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
			const [confirmDel, setConfirmDel] = useState(null);
			const [q, setQ] = useState("");
			const [sortBy, setSortBy] = useState("smart");

			const load = useCallback(() => {
				let url = "/tidywork-api/todos?view=" + encodeURIComponent(view);
				if (view === "category" && category) url += "&category=" + encodeURIComponent(category);
				api(url).then(setItems).catch(() => {});
				Promise.all(["all", "today", "week", "done"].map((v) => api("/tidywork-api/todos?view=" + v).then((d) => [v, d])))
					.then((rs) => {
						const pick = (v) => (rs.find((r) => r[0] === v) || [v, []])[1] || [];
						const all = pick("all");
						const today = pick("today");
						const week = pick("week");
						const done = pick("done");
						const total = all.length + done.length;
						const rate = total ? Math.round((done.length / total) * 100) : 0;
						// 分类计数（8080 口径：仅未完成任务）；分类列表从全部数据推导，
						// 使"新建分类"创建后自动出现在侧边栏分类区。
						const catCounts = {};
						all.forEach((t) => {
							if (t.category) catCounts[t.category] = (catCounts[t.category] || 0) + 1;
						});
						const allItems = all.concat(done);
						setStats({ all: total, today: today.length, week: week.length + done.length, done: done.length, statToday: today.length, statWeek: done.length, rate, catCounts, allItems });
					})
					.catch(() => {});
			}, [view, category]);
			useEffect(() => {
				load();
			}, [load]);

			const titles = { all: "全部待办", today: "今天", week: "近日", done: "已完成", category: category || "分类" };
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
			const remove = (id) => {
				if (confirmDel !== id) {
					setConfirmDel(id);
					setTimeout(() => setConfirmDel((cur) => (cur === id ? null : cur)), 3000);
					return;
				}
				setConfirmDel(null);
				api("/tidywork-api/todos/" + id, { method: "DELETE" })
					.then(() => {
						toast("待办已删除");
						load();
					})
					.catch((e) => toast(e.message));
			};
			const openAdd = () => {
				// 用户要求：+新增 跳转到固定命名会话（新建待办事项），自然语言新增待办（复用）。
				openTidySession("todo", () => {
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
				const name = prompt("请输入新分类名称：");
				if (!name || !name.trim()) return;
				setForm((f) => Object.assign({}, f, { category: name.trim() }));
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
			const matched = kw
				? items.filter((t) => (String(t.title || "") + " " + String(t.category || "") + " " + String(DUE_LABEL[t.due] || t.due || "")).toLowerCase().indexOf(kw) !== -1)
				: items;
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
				{ style: S.page },
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
							h("div", { style: Object.assign({}, S.statValue, { color: C.danger }) }, stats ? stats.statToday : 0)
						),
						h(
							"div",
							{ style: S.statCard },
							h("div", { style: S.statLabel }, "本周已完成"),
							h("div", { style: Object.assign({}, S.statValue, { color: C.success }) }, stats ? stats.statWeek : 0)
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
									h("div", { style: { fontSize: 12, marginBottom: 16 } }, "点击下方按钮创建第一条待办"),
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
													"div",
													{ title: "取消完成", style: { width: 20, height: 20, background: C.success, borderRadius: 6, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }, onClick: () => toggle(it.id, false) },
													h("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: C.onAccent, strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }, h("polyline", { points: "20 6 9 17 4 12" }))
												)
											: h("div", { title: "标记完成", style: { width: 20, height: 20, border: "2px solid " + (PRIORITY[it.priority] || PRIORITY.mid).color, borderRadius: 6, flexShrink: 0, cursor: "pointer" }, onClick: () => toggle(it.id, true) }),
										h(
											"div",
											{ style: { flex: 1 } },
											h("div", { style: { fontSize: 14, fontWeight: 500, textDecoration: it.done ? "line-through" : "none", color: it.done ? C.text2 : "inherit" } }, it.title),
											h(
												"div",
												{ style: { fontSize: 12, color: C.text2, marginTop: 4, display: "flex", gap: 8, alignItems: "center" } },
												h("span", { style: { padding: "1px 6px", background: tint(C.danger, 12), color: (PRIORITY[it.priority] || PRIORITY.mid).color, borderRadius: 4, fontSize: 11 } }, (PRIORITY[it.priority] || PRIORITY.mid).label),
												h("span", { style: { padding: "1px 6px", background: C.accentSoft, color: C.accent, borderRadius: 4, fontSize: 11 } }, esc(it.category || "")),
												h("span", null, esc(DUE_LABEL[it.due] || it.due || "")),
												h("span", { style: { color: C.text2, cursor: "pointer", fontSize: 11 }, onClick: () => openEdit(it) }, "编辑"),
												h("span", { style: { color: confirmDel === it.id ? C.danger : C.text2, cursor: "pointer", fontSize: 11, fontWeight: confirmDel === it.id ? 600 : 400 }, onClick: () => remove(it.id) }, confirmDel === it.id ? "确认删除？" : "删除")
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
						h(
							"select",
							{ style: S.select, value: form.due, onChange: (e) => setForm((f) => Object.assign({}, f, { due: e.target.value })) },
							h("option", { value: "today" }, "今天"),
							h("option", { value: "tomorrow" }, "明天"),
							h("option", { value: "week" }, "本周"),
							h("option", { value: "none" }, "无期限")
						)
					),
					h(
						"div",
						{ style: S.footRow },
						h(Btn, { onClick: () => { setModal(false); setEditId(null); } }, "取消"),
						h(Btn, { primary: true, onClick: save }, editId ? "保存" : "创建")
					)
				)
			);
		}

		// ===== 会议（复刻 8080：月历/日视图/周条带/时间线/新建删除弹窗） =====
		function MeetingsPage() {
			const now0 = new Date();
			const [month, setMonth] = useState(now0.getFullYear() + "-" + String(now0.getMonth() + 1).padStart(2, "0"));
			const [byDay, setByDay] = useState({});
			const [dayView, setDayView] = useState(null);
			const [modal, setModal] = useState(false);
			const [editId, setEditId] = useState(null);
			const [form, setForm] = useState({ title: "", date: "", time: "09:00", duration: "", location: "", participants: "1" });

			const load = useCallback((m) => {
				api("/tidywork-api/meetings?month=" + encodeURIComponent(m))
					.then((list) => {
						const map = {};
						const now = new Date();
						(list || []).forEach((meet) => {
							const day = parseInt(String(meet.date || "").slice(-2), 10);
							const start = new Date(String(meet.date) + "T" + (meet.time || "00:00") + ":00");
							const status = start.getTime() < now.getTime() - 3600000 ? "done" : start.getTime() < now.getTime() ? "now" : "upcoming";
							(map[day] = map[day] || []).push(
								Object.assign({}, meet, { status, statusText: status === "done" ? "已结束" : status === "now" ? "进行中" : "未开始" })
							);
						});
						setByDay(map);
					})
					.catch(() => {});
			}, []);
			useEffect(() => {
				load(month);
			}, [month, load]);

			const [y, mon] = month.split("-").map(Number);
			const monthTitle = y + "年" + mon + "月";
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
				// 用户要求：+新建 跳转到固定命名会话（新建会议管理），自然语言新增会议（复用）。
				openTidySession("meeting", () => {
					const t = new Date();
					const prefill = t.getFullYear() === y && t.getMonth() + 1 === mon ? t.toISOString().slice(0, 10) : y + "-" + String(mon).padStart(2, "0") + "-01";
					setForm({ title: "", date: prefill, time: "09:00", duration: "", location: "", participants: "1" });
					setModal(true);
				});
			};
			// 编辑：直接开弹窗并回填原值（新建才走"跳会话用自然语言建"那条路）
			const openEdit = (m) => {
				setEditId(m.id);
				setForm({
					title: m.title || "",
					date: m.date || "",
					time: m.time || "09:00",
					duration: m.duration || "",
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
				const payload = {
					title: form.title.trim(),
					date: form.date,
					time: form.time || "09:00",
					duration: form.duration || "09:00 - 10:00",
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
					else load(month);
				})
					.catch((e) => toast(e.message));
			};
			// 会议 → 待办：把这场会的跟进项落到待办清单（标题带上下文，日期沿用会议日期）
			const todoFromMeeting = (m) => {
				api("/tidywork-api/todos", {
					method: "POST",
					body: JSON.stringify({ title: "会后跟进：" + m.title, due: m.date, category: "会议" })
				})
					.then((r) => {
						const t = (r && r.data) || {};
						toast("已生成待办：" + (t.title || m.title));
					})
					.catch((e) => toast(e.message));
			};
			const remove = (id) => {
				if (!confirm("确认删除该会议？")) return;
				api("/tidywork-api/meetings/" + id, { method: "DELETE" })
					.then(() => {
						toast("会议已删除");
						load(month);
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
								m.time + " " + m.title
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
				for (let i = 0; i < 7; i++) {
					const dt = new Date(monday);
					dt.setDate(monday.getDate() + i);
					const d = dt.getDate();
					const meets = byDay[d] || [];
					const isSel = d === dayView;
					strip.push(
						h(
							"div",
							{ key: d, style: { padding: 8, borderRadius: 8, cursor: "pointer", textAlign: "center", background: isSel ? C.accentSoft : C.hover, border: isSel ? "1px solid " + C.accent : "1px solid transparent", boxSizing: "border-box" }, onClick: () => selectDate(d) },
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
				{ style: S.page },
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
											h("div", { style: { fontSize: 11, color: C.text2 } }, mon + "月" + it.day + "日 " + it.m.time)
										)
									)
								)
					)
				),
				h(
					"div",
					{ style: S.right },
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
														h("div", { style: { position: "absolute", left: -60, top: 0, width: 50, textAlign: "right", fontSize: 12, color: m.status === "now" ? C.accent : C.text2, fontWeight: 500 } }, m.time),
														h("div", { style: { position: "absolute", left: -22, top: 4, width: 12, height: 12, borderRadius: "50%", background: dotColor, border: "2px solid " + C.main } }),
														h(
															"div",
															{ style: { background: C.main, border: "1px solid " + borderColor, borderRadius: 12, padding: 16 } },
															h(
																"div",
																{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } },
																h("div", { style: { fontSize: 14, fontWeight: 600 } }, m.title),
																h(
																	"span",
																	{ style: { display: "flex", gap: 8, alignItems: "center" } },
																	h("span", { style: { fontSize: 11, padding: "2px 8px", background: badgeBg, color: badgeColor, borderRadius: 10 } }, m.statusText),
																	h("span", { style: { fontSize: 11, color: C.accent, cursor: "pointer", marginRight: 10 }, onClick: () => openEdit(m) }, "编辑"),
																	h("span", { style: { fontSize: 11, color: C.text2, cursor: "pointer" }, onClick: () => remove(m.id) }, "删除")
																)
															),
															h("div", { style: { fontSize: 12, color: C.text2, marginBottom: 12 } }, esc(m.duration) + " · " + esc(m.location)),
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
																),
																		h(
																			"span",
																			{ title: "把这场会的跟进项加入待办", style: { marginLeft: "auto", fontSize: 11.5, color: C.accent, cursor: "pointer" }, onClick: () => todoFromMeeting(m) },
																			"生成待办 →"
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
						h("input", { style: S.input, type: "time", value: form.time, onChange: (e) => setForm((f) => Object.assign({}, f, { time: e.target.value })) })
					),
					h(
						Field,
						{ label: "时长" },
						h("input", { style: S.input, maxLength: 40, placeholder: "例如 09:00 - 10:00", value: form.duration, onChange: (e) => setForm((f) => Object.assign({}, f, { duration: e.target.value })) })
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

		// ===== 笔记（复刻 8080：双栏 + 新建/保存/删除 + 字数/最后编辑） =====
		function NotesPage() {
			const [notes, setNotes] = useState([]);
			const [current, setCurrent] = useState(null);
			const [title, setTitle] = useState("");
			const [content, setContent] = useState("");
			const [meta, setMeta] = useState("选择左侧笔记，或新建一篇");

			const loadOne = useCallback((id) => {
				api("/tidywork-api/notes/" + id)
					.then((n) => {
						setCurrent(n);
						setTitle(n.title || "");
						setContent(n.content || "");
						setMeta("最后编辑：" + relTime(n.updatedAt || "—") + " · " + (n.content ? n.content.length : 0) + " 字");
					})
					.catch(() => {});
			}, []);
			const openAdd = useCallback(() => {
				setCurrent(null);
				setTitle("");
				setContent("");
				setMeta("新笔记 · 输入内容后保存");
			}, []);
			const loadAll = useCallback(() => {
				api("/tidywork-api/notes")
					.then((list) => {
						setNotes(list || []);
						if (list && list.length > 0) loadOne(list[0].id);
						else openAdd();
					})
					.catch(() => {});
			}, [loadOne, openAdd]);
			useEffect(() => {
				loadAll();
			}, [loadAll]);

			const save = () => {
				const t = title.trim() || "未命名笔记";
				if (current) {
					api("/tidywork-api/notes/" + current.id, { method: "PUT", body: JSON.stringify({ title: t, content }) })
						.then(() => {
							toast("笔记已保存");
							loadAll();
						})
						.catch((e) => toast(e.message));
				} else {
					api("/tidywork-api/notes", { method: "POST", body: JSON.stringify({ title: t, content }) })
						.then(() => {
							toast("笔记已创建");
							loadAll();
						})
						.catch((e) => toast(e.message));
				}
			};
			const remove = () => {
				if (!current) {
					toast("请先选择笔记");
					return;
				}
				if (!confirm("确认删除该笔记？")) return;
				api("/tidywork-api/notes/" + current.id, { method: "DELETE" })
					.then(() => {
						setCurrent(null);
						toast("笔记已删除");
						loadAll();
					})
					.catch((e) => toast(e.message));
			};

			return h(
				"div",
				{ style: { flex: 1, display: "grid", gridTemplateColumns: "220px minmax(0, 1fr)", height: "100%", overflow: "hidden", background: C.page, color: C.text0, fontFamily: FONT, fontSize: 14, boxSizing: "border-box" } },
				h(
					"div",
					{ style: { borderRight: "1px solid " + C.borderLight, overflowY: "auto", padding: 10, boxSizing: "border-box" } },
					h(
						"button",
						{ style: Object.assign({}, S.menuItem, { color: C.accent, fontWeight: 600 }), onClick: openAdd },
						h("svg", { style: Object.assign({}, S.menuIcon, { width: 16, height: 16, color: C.accent }), viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }, h("path", { d: TODO_ICONS.plus })),
						h("span", null, "新建笔记")
					),
					notes.length === 0
						? h("div", { style: { padding: 8, fontSize: 12, color: C.text2 } }, "暂无笔记")
						: notes.map((n) =>
								h(
									"div",
									{ key: n.id, style: { padding: 10, borderRadius: 8, cursor: "pointer", marginBottom: 2, background: current && current.id === n.id ? C.active : "transparent" }, onClick: () => loadOne(n.id) },
									h("div", { style: { fontSize: 13, fontWeight: 500, marginBottom: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, n.title),
									h("div", { style: { fontSize: 11, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, n.preview)
								)
							)
				),
				h(
					"div",
					{ style: { padding: "24px 32px", overflowY: "auto", minWidth: 0, display: "flex", flexDirection: "column", boxSizing: "border-box" } },
					h("input", { style: { width: "100%", background: "none", border: "none", outline: "none", fontSize: 22, fontWeight: 700, color: C.text0, marginBottom: 8, fontFamily: FONT }, placeholder: "笔记标题", value: title, onChange: (e) => setTitle(e.target.value) }),
					h("div", { style: { fontSize: 12, color: C.text2, marginBottom: 24, paddingBottom: 16, borderBottom: "1px solid " + C.borderLight } }, meta),
					h(
						"div",
						{ style: { flex: 1, minHeight: 240 } },
						h("textarea", { style: { width: "100%", height: "100%", minHeight: 240, border: "none", outline: "none", resize: "none", background: "transparent", font: "inherit", lineHeight: 1.8, color: C.text1, fontFamily: FONT, boxSizing: "border-box" }, placeholder: "在这里输入笔记内容…", value: content, onChange: (e) => setContent(e.target.value) })
					),
					h(
						"div",
						{ style: { display: "flex", gap: 8, justifyContent: "flex-end", padding: "12px 0" } },
						h(Btn, { onClick: remove }, "删除"),
						h(Btn, { primary: true, onClick: save }, "保存")
					)
				)
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
		const TL_HOUR = 32;
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
			return h("div", { style: Object.assign({ background: C.main, border: "1px solid " + C.border, borderRadius: 12, padding: "14px 16px 16px", boxSizing: "border-box", minWidth: 0 }, props.style || {}) }, props.children);
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
			const [narrow, setNarrow] = useState(typeof window !== "undefined" ? window.innerWidth < 780 : false);
			const [err, setErr] = useState(null);
			const today = ymd(new Date());
			const month = today.slice(0, 7);

			const reload = useCallback(() => {
				const wrap = (p) => p.then((d) => ({ ok: true, d: d })).catch((e) => ({ ok: false, msg: (e && e.message) || "请求失败" }));
				Promise.all([
					wrap(api("/tidywork-api/todos?view=all")),
					wrap(api("/tidywork-api/todos?view=done")),
					wrap(api("/tidywork-api/meetings?month=" + month)),
					wrap(api("/tidywork-api/notes"))
				]).then(([a, b, m, n]) => {
					const errs = {};
					// 失败时保留上一次成功的数据，不把"加载失败"伪装成"没有数据"
					if (a.ok && b.ok) setTodos((a.d || []).concat(b.d || []));
					else errs.todos = !a.ok ? a.msg : b.msg;
					if (m.ok) setMeetings(m.d || []); else errs.meetings = m.msg;
					if (n.ok) setNotes(n.d || []); else errs.notes = n.msg;
					setErr(Object.keys(errs).length ? errs : null);
				});
			}, [month]);
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
			const rate = totalN ? Math.round((doneN / totalN) * 100) : 0;
			const todayCount = items.filter((t) => dueOf(t) === today).length;
			const lateN = items.filter(isLate).length;
			const openN = totalN - doneN;
			const weekS = weekStartOf(today);
			const weekE = shiftYmd(weekS, 6);
			const weekMeets = (meetings || []).filter((m) => { const d = String(m.date || "").slice(0, 10); return d >= weekS && d <= weekE; });
			const todayMeets = (meetings || [])
				.filter((m) => String(m.date || "").slice(0, 10) === today)
				.sort((a, b) => String(a.time || "").localeCompare(String(b.time || "")));
			const recentNotes = (notes || []).slice(-4).reverse();

			// —— 今日日程：视图范围与块几何（默认 09:00–18:00，有越界会议时向外扩展） ——
			const evBlocks = (() => {
				const bs = todayMeets.map((m) => {
					const p = String(m.time || "0:0").split(":");
					const start = Number(p[0] || 0) + Number(p[1] || 0) / 60;
					const mm = String(m.duration || "").match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
					const end = mm ? Number(mm[3]) + Number(mm[4]) / 60 : start + 1;
					return { m, start, end, lane: 0, laneN: 1 };
				}).sort((x, y) => x.start - y.start);
				let lo = TL_START, hi = TL_END;
				bs.forEach((b) => { lo = Math.min(lo, Math.floor(b.start)); hi = Math.max(hi, Math.ceil(b.end)); });
				// 重叠成簇 → 簇内左右分栏，避免块互相压住
				const clusters = [];
				bs.forEach((b) => {
					let cl = null;
					for (let i = 0; i < clusters.length; i++) { if (b.start < clusters[i].end - 0.001) { cl = clusters[i]; break; } }
					if (!cl) { cl = { end: b.end, items: [] }; clusters.push(cl); }
					cl.items.push(b);
					cl.end = Math.max(cl.end, b.end);
				});
				clusters.forEach((cl) => {
					const lanes = [];
					cl.items.forEach((b) => {
						let li = -1;
						for (let i = 0; i < lanes.length; i++) { if (lanes[i] <= b.start + 0.001) { li = i; break; } }
						if (li === -1) { lanes.push(b.end); b.lane = lanes.length - 1; }
						else { lanes[li] = b.end; b.lane = li; }
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
						load();
					})
					.catch((e) => toast(e.message));
			};
			const toggle = (t) => setDone(t.id, !t.done, t.title);
			const addTodo = () => {
				const title = draft.trim();
				if (!title) { toast("请输入待办内容"); return; }
				api("/tidywork-api/todos", { method: "POST", body: JSON.stringify({ title, priority: "mid", category: "工作", due: "today" }) })
					.then((created) => {
						const item = created && created.id ? created : { id: "tw" + Date.now(), title, priority: "mid", category: "工作", due: "today", done: false };
						setTodos((cur) => (cur || []).concat([Object.assign({ done: false }, item)]));
						setDraft("");
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
					const h2 = Math.max(26, (b.end - b.start) * TL_HOUR - 4);
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
								title: b.m.title + "（" + (b.m.duration || b.m.time) + "）",
								style: {
									position: "absolute", left: lx, width: w, top, height: h2, boxSizing: "border-box",
									textAlign: "left", cursor: "pointer", fontFamily: FONT,
									background: on ? "#e3ebff" : C.accentSoft,
									border: "1px solid " + (on ? "#b9cdff" : "#d6e0ff"),
									borderRadius: 8, padding: compact ? "3px 8px" : "5px 9px", overflow: "hidden"
								}
							},
							h("div", { style: { fontSize: 12, fontWeight: 600, color: C.accent, display: "flex", gap: 6, lineHeight: 1.35 } },
								h("span", { style: { flexShrink: 0 } }, b.m.time),
								h("span", { style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, b.m.title),
								over ? h("span", { style: { flexShrink: 0, fontSize: 10, fontWeight: 500, color: "#8a93a6", background: "#eef1f6", borderRadius: 4, padding: "0 4px", lineHeight: "15px" } }, b.start < TL_START ? "早于视图" : "晚于视图") : null
							),
							compact ? null : h("div", { style: { fontSize: 11, color: C.text1, marginTop: 1, display: "flex", gap: 8, flexWrap: "wrap", lineHeight: 1.3 } },
								h("span", null, b.m.location || ""), h("span", null, (b.m.participants || 0) + " 人")),
							(on && !compact) ? h("div", { style: { fontSize: 11, color: C.text1, marginTop: 4, paddingTop: 4, borderTop: "1px dashed #b9cdff" } }, (b.m.duration || "") + " · 点击「会议」查看完整信息") : null
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

			// —— 进度环 ——
			const ringR = 44;
			const ringC = 2 * Math.PI * ringR;

			const tabDefs = [["recent", "近期"], ["today", "今天"], ["late", "逾期"], ["week", "本周"], ["all", "全部"]];

			return h(
				"div",
				{ style: { flex: 1, display: "flex", flexDirection: "column", height: "100%", background: C.page, color: C.text0, fontFamily: FONT, fontSize: 14, boxSizing: "border-box", minHeight: 0, overflowY: "auto" } },

				// 顶栏。data-window-drag 是 macOS 桌面端的窗口拖拽标记：
				// DSH 只认 html[data-platform='darwin'] [data-window-drag] 这一条规则，
				// 没标记的行拖不动窗口；标记后按钮会被宿主的全局规则自动减除，照常可点。
				h(
					"div",
					{ "data-window-drag": true, style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "14px 20px 10px", flexShrink: 0, borderBottom: "1px solid " + C.borderLight, background: C.main } },
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
						)
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
								{ style: { display: "flex", alignItems: "center", gap: 14 } },
								h(
									"div",
									{ style: { position: "relative", width: 100, height: 100, flexShrink: 0 } },
									h(
										"svg",
										{ width: 100, height: 100, viewBox: "0 0 104 104" },
										h("circle", { cx: 52, cy: 52, r: ringR, fill: "none", stroke: C.hover, strokeWidth: 10 }),
										h("circle", {
											cx: 52, cy: 52, r: ringR, fill: "none", stroke: C.accent, strokeWidth: 10,
											strokeLinecap: "round",
											strokeDasharray: String(ringC),
											strokeDashoffset: String(ringC * (1 - rate / 100)),
											transform: "rotate(-90 52 52)",
											style: { transition: "stroke-dashoffset .45s ease" }
										})
									),
									h("div", { style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, fontWeight: 600, letterSpacing: -0.5 } }, String(rate), h("span", { style: { fontSize: 11, fontWeight: 400, color: C.text2, marginLeft: 1 } }, "%"))
								),
								h(
									"div",
									{ style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 } },
									h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } }, h("span", { style: { color: C.text1 } }, "已完成 / 全部"), h("span", { style: { fontWeight: 600 } }, doneN + " / " + totalN)),
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
		const inject = ["slots", "locale", "layout", "workspaces", "uiWorkspace"];
		const NS = "tidywork";
		const HOME = { id: "tidywork-home", order: -10, labelKey: "home" };
		const PANELS = [
			{ id: "tidywork-todos", kind: "todos", labelKey: "todos", order: -8 },
			{ id: "tidywork-meetings", kind: "meetings", labelKey: "meetings", order: -7 },
			{ id: "tidywork-notes", kind: "notes", labelKey: "notes", order: -6 }
		];

		// ===== 浏览器标签页品牌（title + favicon）=====
		// DSH 宿主的标签页原本是「DeepSeek Harness + 鲸鱼图标」，插件在页面里跑，
		// 直接把 head 里的 title 与 icon 换成 TidyWork；DSH 路由切换会重建 head，
		// 用 MutationObserver 守着，并在内部做幂等判断，避免自己改自己形成死循环。
		const BRAND_TITLE = "TidyWork";
		const BRAND_ICON =
			"data:image/svg+xml," +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
					'<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
					'<stop offset="0" stop-color="#3370ff"/><stop offset="1" stop-color="#6b9fff"/>' +
					"</linearGradient></defs>" +
					'<rect width="64" height="64" rx="18" fill="url(#g)"/>' +
					'<text x="32" y="45" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif" font-size="36" font-weight="700" fill="#ffffff">T</text>' +
					"</svg>"
			);

		function applyBranding() {
			if (typeof document === "undefined") return () => {};
			const setTitle = () => {
				if (document.title !== BRAND_TITLE) document.title = BRAND_TITLE;
			};
			const setIcon = () => {
				const links = Array.from(document.querySelectorAll('link[rel*="icon"]'));
				// 已经只有我们这一个、且 href/rel 都对，就不动 DOM（否则会自触发观察回调）
				if (links.length === 1 && links[0].getAttribute("rel") === "icon" && links[0].getAttribute("href") === BRAND_ICON) return;
				links.forEach((l) => l.parentNode && l.parentNode.removeChild(l));
				const link = document.createElement("link");
				link.rel = "icon";
				link.type = "image/svg+xml";
				link.href = BRAND_ICON;
				document.head.appendChild(link);
			};
			// 主题变量：强调色/状态色的深浅两套，一次性注入 head；DSH 路由切换会重建 head，
			// 所以跟着下面的观察器一起补回（已有就跳过，避免自触发循环）。
			const setTheme = () => {
				if (document.getElementById("tidywork-theme")) return;
				const st = document.createElement("style");
				st.id = "tidywork-theme";
				st.textContent = THEME_CSS;
				document.head.appendChild(st);
			};
			setTheme();
			setTitle();
			setIcon();

			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				// 不用 rAF：后台标签页里 rAF 会被浏览器节流，修正就永远不执行，
				// 标题会停在宿主设的「DeepSeek Harness」。setTimeout 不受此限。
				const raf = (fn) => setTimeout(fn, 0);
				raf(() => {
					scheduled = false;
					setTheme();
					setTitle();
					setIcon();
				});
			};
			const mo = new MutationObserver(schedule);
			if (document.head) mo.observe(document.head, { childList: true, subtree: true, characterData: true });
			return () => mo.disconnect();
		}

		/** 应用主体：品牌替换 + 工作台主面板 + 3 组侧边栏入口/主面板。 */
		function apply(ctx) {
			// 标签页品牌：标题与 favicon 换成 TidyWork（跟随页面生命周期）
			ctx.effect(() => applyBranding(), "tidywork: branding");

			const dict = { home: "工作台", todos: "待办", meetings: "会议", notes: "笔记" };
			ctx.effect(() => ctx.locale.register(NS, { zh: dict, en: dict }), "tidywork: locale");
			const t = ctx.locale.bind(NS);
			const pages = { todos: TodosPage, meetings: MeetingsPage, notes: NotesPage };

			// —— 品牌：替换为 TidyWork logo ——
			// priority -100（低于 DSH 官方 0）以确定性遮蔽官方品牌，避免同优先级冲突报错。
			// v3.2：brand.mark 同时携带 <style>，注入"TidyWork 组 与 DSH 原生组"之间的分隔线
			//（panellist 本身无分组/分隔线能力；插件侧只能通过渲染 <style> 注入全局 CSS）。
			// 运行时 DOM 实测：nav.panelList 的子元素就是 button.panelRow 本身
			//（无 div 包裹层），分隔线直接挂在第一个 DSH 原生入口按钮（插件）上。
			// 颜色用官方组件同款 --dsw-alias-border-l2（比 l1 更清晰）。
			const SIDEBAR_DIVIDER_CSS = [
				"nav[aria-label] > button[aria-label=\"插件\"]{",
				"margin-top:12px;",
				"border-top:1px solid var(--dsw-alias-border-l2,#e5e6eb);",
				"}"
			].join("");
			ctx.slots.inject("sidebar.brand.mark", () =>
				ctx.slots.register({ name: "sidebar.brand.mark", priority: -100 }, (owner) => {
					const size = (owner && owner.size) || 26;
					// 返回单元素（span 包裹），避免 Fragment 输出导致槽位异常；
					// style 子节点用于注入全局分隔线 CSS。
					return h(
						"span",
						{ style: { display: "inline-flex" } },
						h(
							"div",
							{ style: { width: size, height: size, borderRadius: Math.round(size * 0.3), background: "linear-gradient(135deg,#3370ff,#6b9fff)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: Math.round(size * 0.55), fontWeight: 700, flexShrink: 0 } },
							"T"
						),
						h("style", { dangerouslySetInnerHTML: { __html: SIDEBAR_DIVIDER_CSS } })
					);
				})
			);
			ctx.slots.inject("sidebar.brand.name", () =>
				ctx.slots.register({ name: "sidebar.brand.name", priority: -100 }, () =>
					h(
						"div",
						{ style: { fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center" } },
						// 用宿主的文字 token：之前写成不存在的 --ds-color-text-1，深色主题下
						// 取兜底近黑，在深色侧栏上整段「Tidy」消失，只剩蓝色 Work 像残缺。
						h("span", { style: { color: "var(--dsw-alias-label-primary, #1f2329)" } }, "Tidy"),
						h("span", { style: { color: C.accent } }, "Work")
					)
				)
			);

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
					ctx.slots.register({ name: "main", key: id, locale: NS, inject: () => ({}) }, pages[key])
				);
			}

			// —— 默认打开工作台主面板 ——
			setTimeout(() => {
				try {
					ctx.layout.selectPanel(HOME.id);
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
