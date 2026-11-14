// TidyWork 工作区插件 · 服务端半
// 职责：注册 /tidywork-api 前缀 HTTP 路由，提供工作区数据读写：
//   - /tidywork-api/todos[/:id]          （待办：智能视图/分类筛选、增、改、删）
//   - /tidywork-api/meetings[/:id]       （会议：按月筛选、增、删）
//   - /tidywork-api/notes[/:id]          （笔记：列表/详情/增/改/删）
// v3.7：删除 /tidywork-api/data?kind=board 通道（工作看板功能下线）。
// 数据以 JSON 文件落在 DSH profile 数据目录（$DSH_HOME/profiles/<profile>/tidywork/），
// 跨容器重建与跨会话存活。首次无文件时写入示例数据。不触碰 DSH 任何原生功能。
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tidywork";
/**
 * 依赖宿主服务：
 *  - webServer 提供 HTTP 路由注册；
 *  - tools 提供 Agent 工具注册（会话中自然语言新增待办）；
 *  - workspaceRegistry 提供“独属于 TidyWork 的工作区”注册。
 */
const inject = ["webServer", "tools", "workspaceRegistry"];

/** 本地时间戳 YYYY-MM-DDTHH:mm:ss（不带时区，前端按本地解析，避免 UTC 偏移）。 */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/**
 * 计算 profile 数据目录：$DSH_HOME/profiles/<profile>/tidywork
 * DSH_HOME 缺省 ~/.dsh；profile 缺省 web（dsh web 即 --profile web）。
 */
function dataRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const profile = process.env.DSH_PROFILE || "web";
  return join(home, "profiles", profile, "tidywork");
}

/** 短 id：前缀 + 8 位随机 hex。 */
function rid(prefix) {
  return prefix + randomBytes(4).toString("hex");
}

/** 首次无文件时的默认数据。 */
const SEEDS = {
  todos: {
    version: 1,
    items: [
      { id: "t1", title: "完成 DSH 前端原型设计", priority: "high", category: "工作", due: "today", done: false },
      { id: "t2", title: "梳理 TidyWork 数据模型", priority: "mid", category: "工作", due: "tomorrow", done: false },
      { id: "t3", title: "准备容器化部署方案", priority: "mid", category: "DevOps", due: "2026-11-05", done: false },
      { id: "t4", title: "阅读 DSH 插件开发文档", priority: "low", category: "调研", due: "yesterday", done: true }
    ]
  },
  meetings: {
    version: 1,
    items: [
      { id: "m1", date: "2026-11-03", time: "09:00", title: "晨会 · 每日同步", duration: "09:00 - 09:30", location: "线上会议", participants: 5 },
      { id: "m2", date: "2026-11-03", time: "10:00", title: "产品规划会", duration: "10:00 - 11:30", location: "3F 会议室 A", participants: 8 },
      { id: "m3", date: "2026-11-03", time: "14:00", title: "设计评审", duration: "14:00 - 15:00", location: "线上会议", participants: 6 },
      { id: "m4", date: "2026-11-03", time: "16:30", title: "1:1 · 产品对齐", duration: "16:30 - 17:00", location: "线上会议", participants: 2 },
      { id: "m5", date: "2026-11-04", time: "14:00", title: "技术评审", duration: "14:00 - 15:30", location: "2F 会议室 B", participants: 7 },
      { id: "m6", date: "2026-11-09", time: "09:30", title: "团队周会", duration: "09:30 - 10:30", location: "大会议室", participants: 12 },
      { id: "m7", date: "2026-11-12", time: "10:00", title: "产品内测启动", duration: "10:00 - 11:00", location: "线上会议", participants: 10 }
    ]
  },
  notes: {
    version: 1,
    items: [
      { id: "n1", title: "DSH 架构调研笔记", preview: "基于 Cordis 的插件化架构...", content: "DeepSeek Harness 基于 Cordis 框架，采用“一切皆插件”的设计理念。前端 UI 全部以 ui-* 插件包形式存在，通过 Slot 系统挂载到主界面。", updatedAt: "2026-11-08T11:30:00" },
      { id: "n2", title: "TidyWork 产品需求", preview: "核心功能模块：待办、日程...", content: "核心功能模块：待办、日程、笔记，数据全部本地持久化。", updatedAt: "2026-11-07T18:00:00" },
      { id: "n3", title: "Docker 部署备忘", preview: "volume 挂载路径规划...", content: "volume 挂载路径规划：data/dsh ↔ /root/.dsh、data/context ↔ /data。", updatedAt: "2026-11-01T09:00:00" },
      { id: "n4", title: "前端设计参考", preview: "深色主题配色方案...", content: "深色主题配色方案：主背景 #1c1c1e、面板 #2c2c2e、强调色 #3370ff。", updatedAt: "2026-10-30T15:20:00" }
    ]
  }
};

/** 读取请求体（JSON），带 1MB 上限。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

/**
 * 读取数据文件；缺失时写入种子数据（seedsKey 提供）并返回。
 */
async function readStore(file, seedsKey) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && seedsKey) {
      const data = JSON.parse(JSON.stringify(SEEDS[seedsKey]));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data, null, 2), "utf8");
      return data;
    }
    throw error;
  }
}

/** 写队列：同一资源的写请求串行执行，避免读-改-写竞态互相覆盖。 */
const writeQueues = new Map();
function withQueue(key, fn) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

/** 原子落盘：先写临时文件再 rename，进程中途退出也不会留下半个 JSON。 */
async function saveStore(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, file);
  } catch (error) {
    try { await unlink(tmp); } catch (e) {}
    throw error;
  }
}

function escStr(v, max) {
  return String(v == null ? "" : v).slice(0, max == null ? 40 : max);
}

/** 待办 GET 筛选：智能视图/分类/完成状态。 */
function filterTodos(items, view, category) {
  view = view || "all";
  category = (category || "").trim();
  let out = items.slice();
  if (category) {
    out = out.filter((it) => it.category === category);
  } else if (view === "today") {
    out = out.filter((it) => it.due === "today");
  } else if (view === "week") {
    out = out.filter((it) => it.due === "today" || it.due === "tomorrow");
  } else if (view === "done") {
    out = out.filter((it) => it.done);
  } else {
    out = out.filter((it) => !it.done);
  }
  return out;
}

/** 路由实现（不含排队）；对外入口见下方 handle。 */
async function routeCore(req, res, url) {
  const segs = url.pathname.split("/").filter(Boolean);
  // ---- 待办 /tidywork-api/todos[/:id] ----
  if (segs[0] === "tidywork-api" && segs[1] === "todos") {
    const file = join(dataRoot(), "todos.json");
    if (segs.length === 2) {
      if (req.method === "GET") {
        try {
          const store = await readStore(file, "todos");
          const items = filterTodos(store.items || [], url.searchParams.get("view"), url.searchParams.get("category"));
          sendJson(res, 200, { ok: true, data: items });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const reqBody = JSON.parse(await readBody(req));
          const title = escStr(reqBody.title, 60).trim();
          if (!title) {
            sendJson(res, 400, { ok: false, error: "标题不能为空" });
            return;
          }
          const store = await readStore(file, "todos");
          const item = {
            id: rid("t"),
            title,
            priority: reqBody.priority === "high" || reqBody.priority === "low" ? reqBody.priority : "mid",
            category: escStr(reqBody.category || "工作", 20),
            due: escStr(reqBody.due || "today", 20),
            done: false
          };
          store.items = store.items || [];
          store.items.push(item);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: item });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (segs.length === 3) {
      const id = segs[2];
      try {
        const store = await readStore(file, "todos");
        const it = (store.items || []).find((x) => x.id === id);
        if (!it) {
          sendJson(res, 404, { ok: false, error: "待办不存在" });
          return;
        }
        if (req.method === "PATCH") {
          const reqBody = JSON.parse(await readBody(req));
          if ("done" in reqBody) it.done = Boolean(reqBody.done);
          for (const k of ["title", "priority", "category", "due"]) {
            if (k in reqBody) it[k] = escStr(reqBody[k], 40);
          }
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: it });
          return;
        }
        if (req.method === "DELETE") {
          store.items = (store.items || []).filter((x) => x.id !== id);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed" });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
      return;
    }
  }

  // ---- 会议 /tidywork-api/meetings[/:id] ----
  if (segs[0] === "tidywork-api" && segs[1] === "meetings") {
    const file = join(dataRoot(), "meetings.json");
    if (segs.length === 2) {
      if (req.method === "GET") {
        try {
          const store = await readStore(file, "meetings");
          let items = store.items || [];
          const month = url.searchParams.get("month") || "";
          if (month) items = items.filter((it) => String(it.date || "").startsWith(month));
          items = items.slice().sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.time || "").localeCompare(String(b.time || "")));
          sendJson(res, 200, { ok: true, data: items });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const reqBody = JSON.parse(await readBody(req));
          const title = escStr(reqBody.title, 60).trim();
          const date = escStr(reqBody.date, 10).trim();
          if (!title || !date) {
            sendJson(res, 400, { ok: false, error: "标题与日期不能为空" });
            return;
          }
          const store = await readStore(file, "meetings");
          const item = {
            id: rid("m"),
            date,
            time: escStr(reqBody.time || "09:00", 5),
            title,
            duration: escStr(reqBody.duration || "09:00 - 10:00", 40),
            location: escStr(reqBody.location || "线上会议", 40),
            participants: parseInt(reqBody.participants, 10) || 1
          };
          store.items = store.items || [];
          store.items.push(item);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: item });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (segs.length === 3) {
      const id = segs[2];
      try {
        const store = await readStore(file, "meetings");
        const found = (store.items || []).some((x) => x.id === id);
        if (!found) {
          sendJson(res, 404, { ok: false, error: "会议不存在" });
          return;
        }
        if (req.method === "DELETE") {
          store.items = (store.items || []).filter((x) => x.id !== id);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed" });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
      return;
    }
  }

  // ---- 笔记 /tidywork-api/notes[/:id] ----
  if (segs[0] === "tidywork-api" && segs[1] === "notes") {
    const file = join(dataRoot(), "notes.json");
    if (segs.length === 2) {
      if (req.method === "GET") {
        try {
          const store = await readStore(file, "notes");
          const items = (store.items || []).map((n) => ({
            id: n.id,
            title: n.title,
            preview: n.preview,
            updatedAt: n.updatedAt
          }));
          sendJson(res, 200, { ok: true, data: items });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const reqBody = JSON.parse(await readBody(req));
          const title = escStr(reqBody.title, 60).trim() || "未命名笔记";
          const content = String(reqBody.content || "");
          const store = await readStore(file, "notes");
          const note = {
            id: rid("n"),
            title,
            preview: (content.slice(0, 24) + (content.length > 24 ? "..." : "")) || "新笔记",
            content,
            updatedAt: localStamp()
          };
          store.items = store.items || [];
          store.items.push(note);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: note });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (segs.length === 3) {
      const id = segs[2];
      try {
        const store = await readStore(file, "notes");
        const n = (store.items || []).find((x) => x.id === id);
        if (!n) {
          sendJson(res, 404, { ok: false, error: "笔记不存在" });
          return;
        }
        if (req.method === "GET") {
          sendJson(res, 200, { ok: true, data: n });
          return;
        }
        if (req.method === "PUT") {
          const reqBody = JSON.parse(await readBody(req));
          if ("title" in reqBody) n.title = escStr(reqBody.title, 60);
          if ("content" in reqBody) {
            const content = String(reqBody.content);
            n.content = content;
            n.preview = (content.slice(0, 24) + (content.length > 24 ? "..." : "")) || "新笔记";
          }
          n.updatedAt = localStamp();
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: n });
          return;
        }
        if (req.method === "DELETE") {
          store.items = (store.items || []).filter((x) => x.id !== id);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed" });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: "not found" });
}

/** 处理 /tidywork-api/*：GET 直读（原子写保证文件完整），写请求按资源排队。 */
async function handle(req, res, url) {
  if (req.method === "GET") return routeCore(req, res, url);
  const segs = url.pathname.split("/").filter(Boolean);
  const key = segs[0] === "tidywork-api" ? (segs[1] || "root") : "root";
  return withQueue(key, () => routeCore(req, res, url));
}

/** 通过 Agent 工具新增一条待办（与 POST /tidywork-api/todos 同一存储）。 */
async function addTodo(args) {
  const file = join(dataRoot(), "todos.json");
  const title = escStr(args.title, 60).trim();
  if (!title) return { ok: false, error: "标题不能为空" };
  const item = {
    id: rid("t"),
    title,
    priority: args.priority === "high" || args.priority === "low" ? args.priority : "mid",
    category: escStr(args.category || "工作", 20),
    due: escStr(args.due || "today", 20),
    done: false
  };
  return withQueue("todos", async () => {
    const store = await readStore(file, "todos");
    store.items = store.items || [];
    store.items.push(item);
    await saveStore(file, store);
    return { ok: true, data: item };
  });
}

/** 通过 Agent 工具新增一场会议（与 POST /tidywork-api/meetings 同一存储）。 */
async function addMeeting(args) {
  const file = join(dataRoot(), "meetings.json");
  const title = escStr(args.title, 60).trim();
  const date = escStr(args.date, 10).trim();
  if (!title || !date) return { ok: false, error: "标题与日期不能为空" };
  const item = {
    id: rid("m"),
    date,
    time: escStr(args.time || "09:00", 5),
    title,
    duration: escStr(args.duration || "09:00 - 10:00", 40),
    location: escStr(args.location || "线上会议", 40),
    participants: parseInt(args.participants, 10) || 1
  };
  return withQueue("meetings", async () => {
    const store = await readStore(file, "meetings");
    store.items = store.items || [];
    store.items.push(item);
    await saveStore(file, store);
    return { ok: true, data: item };
  });
}

/** Agent 工具：自然语言新增会议（手工构造 ToolDefinition，不依赖 @deepseek-ai/dsh-tools）。 */
const MEETING_ADD_TOOL = {
  name: "tidywork_add_meeting",
  description:
    "在 TidyWork 会议日历中添加一场新会议。参数：title 会议标题（必填）；date 会议日期（必填，YYYY-MM-DD，例如 2026-11-06）；time 开始时间（HH:mm，默认 09:00）；duration 时长描述（默认 09:00 - 10:00）；location 地点（默认 线上会议）；participants 参会人数（默认 1）。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会议标题" },
      date: { type: "string", description: "会议日期 YYYY-MM-DD" },
      time: { type: "string", description: "开始时间 HH:mm" },
      duration: { type: "string", description: "时长描述" },
      location: { type: "string", description: "地点" },
      participants: { type: "number", description: "参会人数" }
    },
    required: ["title", "date"]
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        data: { type: "object" }
      }
    },
    render: (args, value) => {
      const ok = Boolean(value && value.ok);
      const title = args && args.title ? args.title : "";
      const error = value && value.error ? value.error : "未知错误";
      return [{ type: "text", text: ok ? `已添加会议「${title}」` : `添加会议失败：${error}` }];
    }
  },
  async execute(args) {
    return addMeeting(args);
  }
};

/** Agent 工具：自然语言新增待办（手工构造 ToolDefinition，不依赖 @deepseek-ai/dsh-tools）。 */
const TODO_ADD_TOOL = {
  name: "tidywork_add_todo",
  description:
    "在 TidyWork 待办中添加一条新任务。参数：title 任务标题（必填，例如“周五前完成周报”）；priority 优先级，取 high/mid/low，默认 mid；category 分类，默认 工作；due 截止，取 today/tomorrow/具体日期（YYYY-MM-DD），默认 today。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "任务标题" },
      priority: { type: "string", enum: ["high", "mid", "low"], description: "优先级" },
      category: { type: "string", description: "分类" },
      due: { type: "string", description: "截止：today/tomorrow/YYYY-MM-DD" }
    },
    required: ["title"]
  },
  output: {
    schema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        error: { type: "string" },
        data: { type: "object" }
      }
    },
    render: (args, value) => {
      const ok = Boolean(value && value.ok);
      const title = args && args.title ? args.title : "";
      const error = value && value.error ? value.error : "未知错误";
      return [{ type: "text", text: ok ? `已添加待办「${title}」` : `添加待办失败：${error}` }];
    }
  },
  async execute(args) {
    return addTodo(args);
  }
};

/**
 * Cordis 插件主体：注册 /tidywork-api 前缀路由、TidyWork 专属工作区与 Agent 工具。
 * @param ctx - 宿主上下文（注入 webServer / tools / ln）。
 */
async function apply(ctx) {
  // 诊断：确认 apply 执行（宿主日志不透传插件 console，落盘标记）
  writeFile(join(dataRoot(), "apply-ran.txt"), "yes").catch(() => {});

  const server = ctx.webServer;
  const dispose = server.register({
    kind: "prefix",
    path: "/tidywork-api",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://dsh.internal");
        await handle(req, res, url);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    }
  });
  ctx.effect(() => dispose, "tidywork: /tidywork-api routes");

  // 独属于 TidyWork 的工作区（目录注册，幂等：已存在则复用且不改标题）。
  const wsDir = join(dataRoot(), "workspace");
  try {
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, ".created"), String(Date.now()), "utf8");
    const ws = await ctx.workspaceRegistry.create(wsDir, "TidyWork");
    console.log(`[tidywork] workspace ready: ${ws.id}`);
  } catch (error) {
    writeFile(join(dataRoot(), "ws-error.log"), String(error), "utf8").catch(() => {});
    console.error(`[tidywork] workspace create failed: ${String(error)}`);
  }

  // Agent 工具：会话中通过自然语言新增待办/会议。
  const disposeTools = ctx.tools.register(TODO_ADD_TOOL);
  const disposeMeeting = ctx.tools.register(MEETING_ADD_TOOL);
  ctx.effect(() => {
    disposeTools();
    disposeMeeting();
  }, "tidywork: agent tools");
}

export { apply, inject, name };
