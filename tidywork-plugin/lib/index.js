// TidyWork 工作区插件 · 服务端半
// 职责：注册 /tidywork-api 前缀 HTTP 路由，提供工作区数据读写：
//   - /tidywork-api/todos[/:id]          （待办：智能视图/分类筛选、增、改、删）
//   - /tidywork-api/meetings[/:id]       （会议：按月筛选、增、删）
//   - /tidywork-api/notes[/:id]          （笔记：列表（可按 q/tag 过滤）/详情/增/改/删/版本回滚）
//   - /tidywork-api/attachments[/:file]  （笔记图片：base64 上传落盘 + 原样回读）
// v3.7：删除 /tidywork-api/data?kind=board 通道（工作看板功能下线）。
// v4.0：笔记升级为 Markdown 富文本——content 仍是纯文本，新增 format / tags / pinned / rev /
//       versions；preview 与字数改按「去 Markdown 后的纯文本」算；PUT 支持 rev 冲突检测（409）；
//       图片走 attachments 路由，正文只存 URL，notes.json 不被二进制撑大。
// 数据以 JSON 文件落在 DSH profile 数据目录（$DSH_HOME/profiles/<profile>/tidywork/），
// 跨容器重建与跨会话存活。首次无文件时写入示例数据。不触碰 DSH 任何原生功能。
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tidywork";
/**
 * 依赖宿主服务：
 *  - webServer 提供 HTTP 路由注册；
 *  - tools 提供 Agent 工具注册（会话中自然语言新增待办）；
 *  - workspaceRegistry 提供“独属于 TidyWork 的工作区”注册；
 *  - systemPrompt 提供会话系统提示注册（告诉每个会话"这里是 TidyWork 工作区"）。
 */
const inject = ["webServer", "tools", "workspaceRegistry", "systemPrompt"];

/** 本地时间戳 YYYY-MM-DDTHH:mm:ss（不带时区，前端按本地解析，避免 UTC 偏移）。 */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

/** 本地日期键 YYYY-MM-DD：按自然日命名会话时用（installDailyNaming 调用）。 */
function dateKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

/**
 * 从插件自身安装路径推导 profile 目录（…/profiles/<profile>/node_modules/@tidywork/dsh-plugin/lib/index.js）。
 * Desktop 启动 Host 时不会设置 DSH_PROFILE，仅靠环境变量会误落到 web profile，
 * 因此优先用真实安装位置；匹配不到（如单文件调试）时返回 null。
 */
function profileDirFromModule() {
  const parts = fileURLToPath(import.meta.url).split(sep);
  const at = parts.lastIndexOf("profiles");
  if (at < 0 || at + 1 >= parts.length) return null;
  return parts.slice(0, at + 2).join(sep);
}

/**
 * 计算 profile 数据目录：<profile>/tidywork
 * 优先按插件安装位置推导；否则 $DSH_HOME/profiles/<DSH_PROFILE|web>。
 */
function dataRoot() {
  const derived = profileDirFromModule();
  if (derived) return join(derived, "tidywork");
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const profile = process.env.DSH_PROFILE || "web";
  return join(home, "profiles", profile, "tidywork");
}

/** 短 id：前缀 + 8 位随机 hex。 */
function rid(prefix) {
  return prefix + randomBytes(4).toString("hex");
}

/**
 * 本实例接口地址的发现文件。
 *
 * 为什么需要它：插件是「跟着哪个 DSH 实例跑，接口就在哪个实例上」——
 *   · 桌面端（DeepSeek Harness App）：宿主 webServer 绑的是 127.0.0.1 上的随机端口；
 *   · 容器部署（tidywork-assistant）：容器内固定 3080。
 * 以前系统提示把地址写死成 `:3080`，桌面端的 Agent 用 bash 发请求时就会打到本机 3080 上的
 * 另一个实例（容器），数据写进那边的 profile，桌面端面板自然读不到。
 * 现在由插件把 ctx.webServer.getOrigin() 写成 api-endpoint.txt + 一个 tw 小脚本，Agent 先读地址再写。
 */
const ENDPOINT_NAME = "api-endpoint.txt";
const CLI_NAME = "tw";

/** Agent 用的小封装：读 api-endpoint.txt，再 curl 同一实例的 /tidywork-api。 */
const API_CLI = `#!/bin/sh
# TidyWork 工作区接口（插件生成，勿手改）：sh tw <METHOD> <PATH> [JSON_BODY]
# 例：sh tw GET /meetings
#     sh tw POST /meetings '{"title":"周会","date":"2026-11-20","time":"14:00"}'
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE=$(cat "$DIR/${ENDPOINT_NAME}" 2>/dev/null)
if [ -z "$BASE" ]; then
  echo '{"ok":false,"error":"api-endpoint.txt 还没生成（宿主端口未就绪），请稍后重试"}'
  exit 1
fi
METHOD=$1
RES=$2
BODY=$3
if [ -n "$BODY" ]; then
  curl -s -X "$METHOD" "$BASE/tidywork-api$RES" -H 'content-type: application/json' -d "$BODY"
else
  curl -s -X "$METHOD" "$BASE/tidywork-api$RES"
fi
`;

/** 已发布过的地址（避免每个请求都重写文件）。 */
let publishedOrigin = "";

/** 读取本实例 webServer 的原始地址；端口尚未绑定 / 无 URL 形式时返回空串。 */
function readOrigin(server) {
  try {
    const origin = String(server.getOrigin() || "");
    return origin ? origin.replace(/\/+$/, "") : "";
  } catch (error) {
    return "";
  }
}

/** 把接口地址与 tw 脚本落到数据目录；成功返回 true。 */
async function publishEndpoint(server) {
  const origin = readOrigin(server);
  if (!origin) return false;
  if (origin === publishedOrigin) return true;
  const dir = dataRoot();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ENDPOINT_NAME), origin + "\n", "utf8");
  const cli = join(dir, CLI_NAME);
  try {
    await writeFile(cli, API_CLI, { encoding: "utf8", mode: 0o755 });
  } catch (error) {
    await writeFile(cli, API_CLI, "utf8");
  }
  publishedOrigin = origin;
  return true;
}

/** 首次无文件时的默认数据：空白起步，不写入任何示例条目。 */
const SEEDS = {
  todos: { version: 1, items: [] },
  meetings: { version: 1, items: [] },
  notes: { version: 1, items: [] }
};

/** 读取请求体（JSON）；默认 1MB 上限，图片附件路由传更大的 limit。 */
function readBody(req, limit) {
  const max = limit || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
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

/** 统一日志：一条请求一行，错误带堆栈。全部走 stdout，docker logs 可见。 */
function logInfo(msg) {
  console.log("[tidywork] INFO  " + msg);
}
function logError(msg) {
  console.error("[tidywork] ERROR " + msg);
}

/** 500 统一出口：先记错误（带请求上下文与堆栈），再回包（不把堆栈吐给前端）。 */
function serverError(res, error) {
  const ctx = res && res._twReq ? res._twReq : "";
  logError((ctx ? ctx + " " : "") + (error && error.stack ? error.stack : String(error)));
  const msg = error && error.message ? error.message : String(error);
  sendJson(res, 500, { ok: false, error: "服务器内部错误：" + msg });
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

/** 单篇笔记正文上限（Markdown 源码）、版本快照保留数、单张图片上限。 */
const NOTE_MAX = 200 * 1024;
const NOTE_VERSIONS = 20;
const ATTACH_MAX = 6 * 1024 * 1024;

/**
 * 去 Markdown 标记后的纯文本：列表副标题、字数、搜索都用它，
 * 否则侧栏会出现「## 会议纪要 - 参会…」这种源码标记。
 */
function mdPlain(src) {
  return String(src == null ? "" : src)
    .replace(/\r\n?/g, "\n")
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

/** 列表副标题：纯文本截断（老数据里 preview 是源码硬截断，这里统一口径）。 */
function mdPreview(src) {
  const t = mdPlain(src);
  return (t.slice(0, 40) + (t.length > 40 ? "…" : "")) || "新笔记";
}

/** 老数据补齐：format / tags / pinned / rev / versions / createdAt 缺省值。 */
function normalizeNote(n) {
  if (!n.format) n.format = "text";
  if (!Array.isArray(n.tags)) n.tags = [];
  n.pinned = Boolean(n.pinned);
  if (!Number.isFinite(Number(n.rev))) n.rev = 0;
  if (!Array.isArray(n.versions)) n.versions = [];
  if (!n.createdAt) n.createdAt = n.updatedAt || localStamp();
  return n;
}

/** 列表返回的精简形状：不带正文与版本，避免一次拉整个库。 */
function noteSummary(n) {
  return {
    id: n.id,
    title: n.title,
    preview: n.preview,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    tags: n.tags,
    pinned: n.pinned,
    format: n.format,
    rev: n.rev
  };
}

/** 标签规范化：中英文逗号都认，去空去重，最多 8 个、每个 12 字。 */
function normTags(v) {
  const list = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,，]/);
  const out = [];
  for (const raw of list) {
    const t = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim().slice(0, 12);
    if (t && out.indexOf(t) < 0) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
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
  // ---- 新版界面 /tidywork-api/ui/<file>（v3.26 起四页完全对齐设计稿，iframe 内嵌到面板） ----
  if (segs[0] === "tidywork-api" && segs[1] === "ui") {
    const rel = segs.slice(2).join("/") || "index.html";
    const ALLOW = new Set(["index.html", "app.css", "base.css", "tokens.css", "app.js"]);
    const TYPE = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", html: "text/html; charset=utf-8" };
    if (!ALLOW.has(rel)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    try {
      const root = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
      const data = await readFile(join(root, rel));
      const ext = rel.split(".").pop();
      res.writeHead(200, { "content-type": TYPE[ext] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    } catch (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    }
    return;
  }
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
          serverError(res, error);
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
          serverError(res, error);
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
        serverError(res, error);
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
          serverError(res, error);
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
          serverError(res, error);
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
        if (req.method === "PATCH") {
          // 局部更新：只改传上来的字段，其余保留（编辑会议时间不必重填全部信息）
          const reqBody = JSON.parse(await readBody(req));
          const meet = (store.items || []).find((x) => x.id === id);
          if ("title" in reqBody) {
            const t = escStr(reqBody.title, 60).trim();
            if (!t) {
              sendJson(res, 400, { ok: false, error: "标题不能为空" });
              return;
            }
            meet.title = t;
          }
          if ("date" in reqBody) {
            const d = escStr(reqBody.date, 10).trim();
            if (!d) {
              sendJson(res, 400, { ok: false, error: "日期不能为空" });
              return;
            }
            meet.date = d;
          }
          if ("time" in reqBody) meet.time = escStr(reqBody.time || "09:00", 5);
          if ("duration" in reqBody) meet.duration = escStr(reqBody.duration || "09:00 - 10:00", 40);
          if ("location" in reqBody) meet.location = escStr(reqBody.location || "线上会议", 40);
          if ("participants" in reqBody) meet.participants = parseInt(reqBody.participants, 10) || 1;
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: meet });
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
        serverError(res, error);
      }
      return;
    }
  }

  // ---- 附件（笔记图片）/tidywork-api/attachments[/:file] ----
  // 正文只存 URL（/tidywork-api/attachments/xxx.png），图片走这里，notes.json 不会被二进制撑大。
  if (segs[0] === "tidywork-api" && segs[1] === "attachments") {
    const dir = join(dataRoot(), "attachments");
    if (segs.length === 2) {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      try {
        const reqBody = JSON.parse(await readBody(req, ATTACH_MAX * 2));
        const m = String(reqBody.dataUrl || "").match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) {
          sendJson(res, 400, { ok: false, error: "只支持 png / jpeg / webp / gif 图片" });
          return;
        }
        const buf = Buffer.from(m[3], "base64");
        if (buf.length > ATTACH_MAX) {
          sendJson(res, 413, { ok: false, error: "单张图片不能超过 6MB" });
          return;
        }
        const ext = m[1] === "image/jpeg" ? "jpg" : m[1].slice("image/".length);
        const name = rid("a") + "." + ext;
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, name), buf);
        sendJson(res, 200, { ok: true, data: { url: "/tidywork-api/attachments/" + name } });
      } catch (error) {
        serverError(res, error);
      }
      return;
    }
    if (segs.length === 3 && req.method === "GET") {
      try {
        if (!/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp|gif)$/.test(segs[2])) {
          sendJson(res, 400, { ok: false, error: "bad attachment name" });
          return;
        }
        const buf = await readFile(join(dir, segs[2]));
        const ext = segs[2].split(".").pop().toLowerCase();
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": buf.length,
          "Cache-Control": "public, max-age=31536000, immutable"
        });
        res.end(buf);
      } catch (error) {
        if (error.code === "ENOENT") {
          sendJson(res, 404, { ok: false, error: "附件不存在" });
          return;
        }
        serverError(res, error);
      }
      return;
    }
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  // ---- 笔记 /tidywork-api/notes[/:id] ----
  if (segs[0] === "tidywork-api" && segs[1] === "notes") {
    const file = join(dataRoot(), "notes.json");
    if (segs.length === 2) {
      if (req.method === "GET") {
        try {
          const store = await readStore(file, "notes");
          const q = (url.searchParams.get("q") || "").trim().toLowerCase();
          const tag = (url.searchParams.get("tag") || "").trim();
          let items = (store.items || []).map(normalizeNote);
          if (q) items = items.filter((n) => (n.title + "\n" + n.content).toLowerCase().includes(q));
          if (tag) items = items.filter((n) => n.tags.indexOf(tag) >= 0);
          // 置顶优先，其余按最后编辑倒序（列表首条即默认打开的那篇）。
          items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
          sendJson(res, 200, { ok: true, data: items.map(noteSummary) });
        } catch (error) {
          serverError(res, error);
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const reqBody = JSON.parse(await readBody(req));
          const title = escStr(reqBody.title, 60).trim() || "未命名笔记";
          const content = String(reqBody.content == null ? "" : reqBody.content);
          if (content.length > NOTE_MAX) {
            sendJson(res, 413, { ok: false, error: "单篇笔记正文不能超过 200KB" });
            return;
          }
          const stamp = localStamp();
          const note = {
            id: rid("n"),
            title,
            content,
            format: reqBody.format === "text" ? "text" : "markdown",
            tags: normTags(reqBody.tags),
            pinned: Boolean(reqBody.pinned),
            preview: mdPreview(content),
            rev: 1,
            createdAt: stamp,
            updatedAt: stamp,
            versions: []
          };
          const store = await readStore(file, "notes");
          store.items = store.items || [];
          store.items.push(note);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: note });
        } catch (error) {
          serverError(res, error);
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
        normalizeNote(n);
        if (req.method === "GET") {
          const withVersions = url.searchParams.get("versions") === "1";
          sendJson(res, 200, { ok: true, data: withVersions ? n : Object.assign({}, n, { versions: undefined }) });
          return;
        }
        if (req.method === "PUT") {
          const reqBody = JSON.parse(await readBody(req));
          // rev 冲突：客户端带着读到的版本号来写，说明它拿着一份旧内容（例如 AI 刚写过这篇）。
          // 没带 rev 的调用（curl / Agent）保持原来的"整条覆盖"语义，不拦。
          if ("rev" in reqBody && !reqBody.force && Number(reqBody.rev) !== Number(n.rev)) {
            sendJson(res, 409, {
              ok: false,
              error: "该笔记已在别处更新",
              data: { id: n.id, title: n.title, content: n.content, rev: n.rev, updatedAt: n.updatedAt }
            });
            return;
          }
          const prev = { rev: n.rev, title: n.title, content: n.content, savedAt: n.updatedAt };
          let changed = false;
          if ("title" in reqBody) {
            const t = escStr(reqBody.title, 60).trim() || "未命名笔记";
            if (t !== n.title) { n.title = t; changed = true; }
          }
          if ("content" in reqBody) {
            const content = String(reqBody.content == null ? "" : reqBody.content);
            if (content.length > NOTE_MAX) {
              sendJson(res, 413, { ok: false, error: "单篇笔记正文不能超过 200KB" });
              return;
            }
            if (content !== n.content) {
              n.content = content;
              n.preview = mdPreview(content);
              changed = true;
            }
          }
          if ("format" in reqBody) n.format = reqBody.format === "text" ? "text" : "markdown";
          if ("tags" in reqBody) n.tags = normTags(reqBody.tags);
          if ("pinned" in reqBody) n.pinned = Boolean(reqBody.pinned);
          // 内容真的变了才留快照，避免自动保存把版本历史刷成一片空白。
          if (changed) {
            n.versions = (n.versions || []).concat([prev]).slice(-NOTE_VERSIONS);
          }
          n.rev = Number(n.rev || 0) + 1;
          n.updatedAt = localStamp();
          if (!n.createdAt) n.createdAt = n.updatedAt;
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
        return;
      } catch (error) {
        serverError(res, error);
      }
      return;
    }
    // 版本回滚：POST /tidywork-api/notes/<id>/restore { rev }
    if (segs.length === 4 && segs[3] === "restore") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      try {
        const id = segs[2];
        const store = await readStore(file, "notes");
        const n = (store.items || []).find((x) => x.id === id);
        if (!n) {
          sendJson(res, 404, { ok: false, error: "笔记不存在" });
          return;
        }
        normalizeNote(n);
        const reqBody = JSON.parse(await readBody(req));
        const target = (n.versions || []).find((v) => Number(v.rev) === Number(reqBody.rev));
        if (!target) {
          sendJson(res, 404, { ok: false, error: "该版本不存在或已过期" });
          return;
        }
        n.versions = (n.versions || []).concat([{ rev: n.rev, title: n.title, content: n.content, savedAt: n.updatedAt }]).slice(-NOTE_VERSIONS);
        n.title = target.title;
        n.content = target.content;
        n.preview = mdPreview(target.content);
        n.rev = Number(n.rev || 0) + 1;
        n.updatedAt = localStamp();
        await saveStore(file, store);
        sendJson(res, 200, { ok: true, data: n });
      } catch (error) {
        serverError(res, error);
      }
      return;
    }
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}

/** 处理 /tidywork-api/*：GET 直读（原子写保证文件完整），写请求按资源排队。 */
async function handle(req, res, url) {
  const t0 = Date.now();
  res._twReq = req.method + " " + url.pathname + (url.search || "");
  // 请求结束统一记一行：状态码 >=500 走 ERROR，其余 INFO
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const line = res._twReq + " -> " + res.statusCode + " " + ms + "ms";
    if (res.statusCode >= 500) logError(line);
    else logInfo(line);
  });
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

/**
 * 会话级系统提示：让每个会话都知道自己跑在 TidyWork 工作区里。
 * 只描述"有什么能力、怎么写"，不改变其他话题的回答方式；order 取 800（在第一方指引之后）。
 */
const WORKSPACE_PROMPT = {
  name: "tidywork:workspace",
  order: 800,
  text: [
    "## TidyWork 工作区",
    "本部署安装了 TidyWork 插件：DSH 侧边栏有「工作台 / 待办 / 会议 / 笔记」四块面板，数据以 JSON 存在本地，面板会在写入后立即刷新。",
    "当用户要新建待办、安排会议、记笔记（或把某件事记成待办）时，直接写入工作区数据，不要让用户自己去面板手动录。",
    "## 这个会话里用户会做什么",
    "这里通常是 TidyWork 的日常对话入口：用户抛出一件事，多半是要新建待办、安排会议、记笔记，也可能是调整已有的待办或会议。",
    "归类默认值（不必每次反问）：出现时间、地点、参与人的 → 会议；一件要做的事 → 待办；零散想法、会议纪要、参考资料 → 笔记。拿不准就给一个默认归类并说明理由，让用户一句话纠正。",
    "一次写入只做一件事：安排会议时只写会议，不要顺手再新建一条笔记去复述会议清单、循环规则或排期结果；只有用户明确说「记成笔记 / 写个规则说明 / 记会议纪要」时才写笔记。同一件事也不要反复新建同标题的笔记，需要补充就 PUT 更新原笔记。",
    "一句话里说了多件事就分开写多条；一次只问一个真正缺失的字段，不要连珠炮追问。",
    "写入方式（重要）：本工作区的接口地址是动态的，**不要写死端口，也不要把请求发到 3080**。",
    "一个实例只有一份数据：桌面端跑在宿主进程的随机端口上，3080 只属于容器那套独立部署；发错实例，面板里就读不到。",
    "先取地址：`cat \"" + join(dataRoot(), ENDPOINT_NAME) + "\"`，文件里就是本实例的 `http://127.0.0.1:<端口>`；文件不存在说明宿主端口还没就绪，等一两秒再读。",
    "推荐用插件生成的小脚本（它自己读上面的地址文件，不用手拼端口）：`sh \"" + join(dataRoot(), CLI_NAME) + "\" <METHOD> <PATH> [JSON]`，等价于 `curl -s \"$BASE/tidywork-api<PATH>\"`。",
    "接口与字段：",
    "- 待办 POST /todos — title 必填；priority 取 high | mid | low（默认 mid）；category 默认「工作」；due 取 today | tomorrow | week | YYYY-MM-DD | none。",
    "- 会议 POST /meetings — title 与 date（YYYY-MM-DD）必填；time（HH:MM）、duration、location、participants 可选。",
    "- 笔记 POST /notes — content 必填（保留用户口述的原文，可用 Markdown 组织：标题、列表、待办 - [ ]、表格、代码块），title 可选（不给就按内容概括一个短标题）；tags 可选（数组，最多 8 个）；format 默认 markdown。",
    "调用示例：`sh \"" + join(dataRoot(), CLI_NAME) + "\" POST /meetings '{\"title\":\"智能办公周例会\",\"date\":\"2026-11-20\",\"time\":\"14:00\"}'`",
    "不要直接编辑数据目录下的 JSON 文件——那会绕过串行写锁，可能写坏数据。",
    "如果当前会话里也存在 tidywork_add_todo / tidywork_add_meeting / tidywork_add_note 工具，优先用工具；工具不在可用列表时就按上面的脚本写入。",
    "写完后用一句话告诉用户「已写入工作区」并复述关键字段，不要粘贴整段 JSON。",
    "用户没给的字段不要编造：缺标题就先问，缺时间就按当天最接近的整点提示确认；一次只补齐真正必要的信息。",
    "修改已有条目可以直接做：先 GET 读出清单（如 `sh tw GET /meetings`），确认用户指的是哪一条，再局部更新——待办 PATCH /todos/<id>（可改 title / priority / category / due / done）；会议 PATCH /meetings/<id>；笔记 PUT /notes/<id>（content / title / tags / pinned / format 都可局部改，但要先 GET /notes/<id> 拿到当前 rev 并原样回传 rev，否则会和用户在面板里的编辑撞车；返回 409 表示这篇已被别处改过，重新 GET 再决定合并方式）。改完把改动复述一遍让用户确认。",
    "删除必须先问清楚是哪一条、确认之后才删（DELETE 同一个路径）。不要自己判断「这条应该没用了」就删。",
    "与工作项无关的话题按平常方式回答，不必主动提起本工作区。",
  ].join("\n"),
};

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

/** 通过 Agent 工具新增一条笔记（与 POST /tidywork-api/notes 同一存储）。 */
async function addNote(args) {
  const file = join(dataRoot(), "notes.json");
  const title = escStr(args.title, 60).trim() || "未命名笔记";
  const content = String(args.content == null ? "" : args.content);
  if (!content.trim() && title === "未命名笔记") return { ok: false, error: "标题与正文至少要有一个" };
  const stamp = localStamp();
  const item = {
    id: rid("n"),
    title,
    content,
    // Agent 写进来的正文按 Markdown 存：模型本来就爱用列表/标题组织文字，读态直接渲染。
    format: "markdown",
    tags: normTags(args.tags),
    pinned: false,
    preview: mdPreview(content),
    rev: 1,
    createdAt: stamp,
    updatedAt: stamp,
    versions: []
  };
  return withQueue("notes", async () => {
    const store = await readStore(file, "notes");
    store.items = store.items || [];
    store.items.push(item);
    await saveStore(file, store);
    return { ok: true, data: item };
  });
}


/** Agent 工具：自然语言新增笔记（手工构造 ToolDefinition，不依赖 @deepseek-ai/dsh-tools）。 */
const NOTE_ADD_TOOL = {
  name: "tidywork_add_note",
  description:
    "在 TidyWork 笔记中新增一条笔记。参数：title 笔记标题（简短概括）；content 笔记正文（用户口述原文为主，可用 Markdown 组织：标题、列表、待办 - [ ]、表格、代码块）；tags 标签数组（可选，最多 8 个）。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "笔记标题" },
      content: { type: "string", description: "笔记正文（Markdown，尽量保留用户原话）" },
      tags: { type: "array", items: { type: "string" }, description: "标签，最多 8 个" }
    },
    required: ["content"]
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
      return [{ type: "text", text: ok ? `已新建笔记「${title || "未命名笔记"}」` : `新建笔记失败：${error}` }];
    }
  },
  async execute(args) {
    return addNote(args);
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
 * 新会话落在 TidyWork 工作区时，把标题改成当天日期；已有标题的会话不动。
 * 这样从侧边栏「新会话」进来的对话也会直接叫 2026-11-20，而不是第一句话的摘要。
 */
function installDailyNaming(ctx, wsDir, since) {
  const titles = ctx.get("sessionTitle");
  if (!titles) return;
  ctx.on("session/created", (session) => {
    try {
      if (!session || !session.header || session.header.cwd !== wsDir) return;
      // 只处理插件启动之后新建的会话；启动时回放的旧会话一律不碰，避免覆盖历史标题。
      if (typeof session.header.createdAt !== "number" || session.header.createdAt < since - 1500) return;
      const snapshot = titles.get(session);
      if (snapshot && snapshot.title) return;
      titles.rename(session, dateKey());
    } catch (error) {
      writeFile(join(dataRoot(), "daily-session.log"), localStamp() + " rename error " + String(error) + "\n", { flag: "a" }).catch(() => {});
    }
  });
}

/**
 * Cordis 插件主体：注册 /tidywork-api 前缀路由、TidyWork 专属工作区与 Agent 工具。
 * @param ctx - 宿主上下文（注入 webServer / tools / ln）。
 */
async function apply(ctx) {
  const bootedAt = Date.now();
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
        serverError(res, error);
      }
    }
  });
  ctx.effect(() => dispose, "tidywork: /tidywork-api routes");

  // 独属于 TidyWork 的工作区（目录注册，幂等：已存在则复用且不改标题）。
  const wsDir = join(dataRoot(), "workspace");
  let ws = null;
  try {
    await mkdir(wsDir, { recursive: true });
    await writeFile(join(wsDir, ".created"), String(Date.now()), "utf8");
    ws = await ctx.workspaceRegistry.create(wsDir, "TidyWork");
    installDailyNaming(ctx, wsDir, bootedAt);
    console.log(`[tidywork] workspace ready: ${ws.id}`);
  } catch (error) {
    writeFile(join(dataRoot(), "ws-error.log"), String(error), "utf8").catch(() => {});
    console.error(`[tidywork] workspace create failed: ${String(error)}`);
  }


  // Agent 工具：会话中通过自然语言新增待办/会议。
  const disposeTools = ctx.tools.register(TODO_ADD_TOOL);
  const disposeMeeting = ctx.tools.register(MEETING_ADD_TOOL);
  const disposeNote = ctx.tools.register(NOTE_ADD_TOOL);
  ctx.effect(() => {
    disposeTools();
    disposeMeeting();
    disposeNote();
  }, "tidywork: agent tools");

  // 会话系统提示：每个新会话都自带"这里是 TidyWork 工作区"的上下文。
  if (ctx.systemPrompt) {
    const disposePrompt = ctx.systemPrompt.section(WORKSPACE_PROMPT);
    ctx.effect(() => disposePrompt, "tidywork: workspace prompt");
    console.log("[tidywork] workspace prompt section registered");
  }

  // 把本实例真实接口地址发布到数据目录：Agent 的 bash 在宿主上执行，读这个文件就不会打到别的实例。
  // 端口可能在 apply 之后才绑定，所以先试一次，再补几次重试。
  const publish = () => publishEndpoint(server).catch(() => false);
  publish();
  for (const delay of [300, 1000, 3000, 8000]) {
    const timer = setTimeout(publish, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
  }
}

export { apply, inject, name };
