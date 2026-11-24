// TidyWork 工作区插件 · 服务端半
// 职责：注册 /tidywork-api 前缀 HTTP 路由，提供工作区数据读写：
//   - /tidywork-api/todos[/:id]          （待办：视图/分类筛选、增、改、删）
 //   - /tidywork-api/meetings[/:id]       （会议：按月筛选、增、改、删，起止时间结构化）
//   - /tidywork-api/notes[/:id]          （笔记：列表/详情/增/改/删/版本回滚）
//   - /tidywork-api/attachments[/:file]  （笔记图片：base64 上传落盘 + 原样回读）
//   - /tidywork-api/export               （整库导出 JSON）
//   - /tidywork-api/health               （插件自检状态）
// v4.1（本轮整改）：
//   1) 路由加来源校验：Host 白名单（防 DNS rebinding）+ Origin 同源 + Sec-Fetch-Site 拦截，
//      写请求必须是 application/json——挡住任意网页对本地实例的 CSRF 写。
//   2) 请求体超限 413、JSON 非法 400、参数非法 400，不再一律 500 并把原始异常回吐前端。
//   3) 待办视图口径重做：all 返回全部、open 才是未完成；week/late 按真实日期区间算。
//   4) 会议时长从自由文本升级为 startTime/endTime（保留 time/duration 兼容老数据与 Agent）。
//   5) 笔记正文拆成 notes/<id>.json 单文件，notes.json 只留索引——自动保存不再重写整库。
//   6) 附件加了回收：笔记改/删后，不再被任何笔记引用的图片文件会被清掉。
//   7) 时间戳带时区偏移，跨容器/桌面两套实例排序不再错位。
//   8) 日志统一进 tidywork/logs/ 并做 1MB 轮转；调试产物不再散落数据目录。
// 数据以 JSON 文件落在 DSH profile 数据目录（$DSH_HOME/profiles/<profile>/tidywork/），
// 跨容器重建与跨会话存活。首次无文件时空白起步。不触碰 DSH 任何原生功能。
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/** Cordis 插件名（loader 诊断用）。 */
const name = "tidywork";
/** 插件版本：直接读 package.json，避免手改常量后和安装包版本对不上。 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
    return String(pkg.version || "0.0.0");
  } catch (error) {
    return "0.0.0";
  }
})();
/**
 * 依赖宿主服务：
 *  - webServer 提供 HTTP 路由注册；
 *  - tools 提供 Agent 工具注册（会话中自然语言新增待办）；
 *  - workspaceRegistry 提供“独属于 TidyWork 的工作区”注册；
 *  - systemPrompt 提供会话系统提示注册（告诉每个会话"这里是 TidyWork 工作区"）。
 * 缺其中任何一个都不再让 apply 整体失败，而是降级并把状态落进 status.json。
 */
const inject = ["webServer", "tools", "workspaceRegistry", "systemPrompt"];

/** 本地时间戳：YYYY-MM-DDTHH:mm:ss+08:00（带时区偏移，跨实例排序才正确）。 */
function localStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const tz = sign + p(Math.floor(abs / 60)) + ":" + p(abs % 60);
  return (
    d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
    "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + tz
  );
}

/** 本地日期键 YYYY-MM-DD。 */
function dateKey(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return x.getFullYear() + "-" + p(x.getMonth() + 1) + "-" + p(x.getDate());
}
/** 本地时分 HH:MM。 */
function timeKey(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return p(x.getHours()) + ":" + p(x.getMinutes());
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
/** 附件名：32 位 hex，不可枚举。 */
function attachmentName(ext) {
  return randomBytes(16).toString("hex") + "." + ext;
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
#     sh tw POST /meetings '{"title":"周会","date":"2026-11-20","startTime":"14:00","endTime":"15:00"}'
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
  todos: { schema: 2, items: [] },
  meetings: { schema: 2, items: [] },
  notes: { schema: 2, items: [] }
};

/** 单篇笔记正文上限（Markdown 源码）、版本快照保留数、单张图片上限。 */
const NOTE_MAX = 200 * 1024;
const NOTE_VERSIONS = 20;
const ATTACH_MAX = 6 * 1024 * 1024;

/**
 * 带 HTTP 状态码的业务错误：路由层捕获后按 status 回包，
 * 不再是"什么都 500 + 把异常原文吐给前端"。
 */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 读取请求体（JSON 文本）；超限抛 413。 */
function readBody(req, limit) {
  const max = limit || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(new HttpError(413, "请求体过大（上限 " + Math.round(max / 1024) + "KB）"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 读 JSON 请求体：非法 JSON 抛 400。 */
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not object");
    return v;
  } catch (error) {
    throw new HttpError(400, "请求体不是合法的 JSON 对象");
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

/** 日志：stdout（docker logs 可见）+ tidywork/logs/plugin.log（1MB 轮转）。 */
const LOG_MAX = 1024 * 1024;
let logPending = Promise.resolve();
function appendLog(line) {
  const file = join(dataRoot(), "logs", "plugin.log");
  logPending = logPending
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      let size = 0;
      try { size = (await readFile(file)).length; } catch (error) { size = 0; }
      if (size > LOG_MAX) {
        try { await rename(file, file + ".1"); } catch (error) {}
      }
      await writeFile(file, line + "\n", { flag: "a" });
    })
    .catch(() => {});
  return logPending;
}
function logInfo(msg) {
  const line = "[tidywork] INFO  " + msg;
    console.log(line);
    appendLog(line);
}
function logError(msg) {
  const line = "[tidywork] ERROR " + msg;
    console.error(line);
    appendLog(line);
}

/** 落盘状态：宿主能力缺失时，前端/排障都能看到为什么。 */
async function writeStatus(patch) {
  try {
    const file = join(dataRoot(), "status.json");
    let cur = {};
    try { cur = JSON.parse(await readFile(file, "utf8")); } catch (error) { cur = {}; }
    const next = Object.assign({}, cur, patch, { updatedAt: localStamp(), version: VERSION });
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch (error) {
    return null;
  }
}

/** 500 统一出口：日志写堆栈，回包只给一句人话（不泄露内部细节）。 */
function serverError(res, error) {
  const ctx = res && res._twReq ? res._twReq : "";
  logError((ctx ? ctx + " " : "") + (error && error.stack ? error.stack : String(error)));
  if (error instanceof HttpError) {
    sendJson(res, error.status, { ok: false, error: error.message });
    return;
  }
  sendJson(res, 500, { ok: false, error: "服务器内部错误，请查看插件日志（logs/plugin.log）" });
}

/** 写队列：同一资源的写请求串行执行，避免读-改-写竞态互相覆盖。 */
const writeQueues = new Map();
function withQueue(key, fn) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(key, next.then(() => {}, () => {}));
  return next;
}

/** 原子写文本：先写临时文件再 rename，进程中途退出也不会留下半个 JSON。 */
async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  try {
    await writeFile(tmp, text, "utf8");
    await rename(tmp, file);
  } catch (error) {
    try { await unlink(tmp); } catch (e) {}
    throw error;
  }
}

/** 存业务数据（结构化 JSON，带缩进便于人工排查）。 */
async function saveStore(file, data) {
  await atomicWrite(file, JSON.stringify(data, null, 2));
}

/** 存单篇笔记（可能几十到几百 KB，不缩进，避免每次自动保存多写一倍字节）。 */
async function saveNoteFile(file, note) {
  await atomicWrite(file, JSON.stringify(note));
}

/** 读取数据文件；缺失时写入种子数据（seedsKey 提供）并返回。 */
async function readStore(file, seedsKey) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && seedsKey) {
      const data = JSON.parse(JSON.stringify(SEEDS[seedsKey]));
      await saveStore(file, data);
      return data;
    }
    if (error instanceof SyntaxError) {
      // 文件损坏：备份一份再重建，避免整个插件起不来
      try { await rename(file, file + ".corrupt-" + Date.now()); } catch (e) {}
      logError("数据文件损坏，已备份并重建：" + file);
      if (seedsKey) {
        const data = JSON.parse(JSON.stringify(SEEDS[seedsKey]));
        await saveStore(file, data);
        return data;
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 字段校验（统一出口：非法值抛 400，而不是悄悄截断）
// ---------------------------------------------------------------------------

const PRIORITIES = new Set(["high", "mid", "low"]);
const DUE_WORDS = new Set(["today", "tomorrow", "yesterday", "week", "none"]);

/** 文本字段：去空白、限长；超长抛 400（不再静默截断）。 */
function textField(value, max, label) {
  const s = String(value == null ? "" : value).trim();
  if (s.length > max) throw new HttpError(400, label + "不能超过 " + max + " 个字符");
  return s;
}

/** 日期字段：必须是 YYYY-MM-DD 且真实存在。 */
function dateField(value, label) {
  const s = textField(value, 10, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, label + "格式应为 YYYY-MM-DD");
  const parts = s.split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (d.getFullYear() !== parts[0] || d.getMonth() !== parts[1] - 1 || d.getDate() !== parts[2]) {
    throw new HttpError(400, label + "不是有效日期");
  }
  return s;
}

/** 时间字段：HH:MM（24 小时制）。 */
function timeField(value, label, fallback) {
  const s = textField(value == null || value === "" ? fallback : value, 5, label);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new HttpError(400, label + "格式应为 HH:MM（24 小时制）");
  return s;
}

/** 截止字段：today/tomorrow/yesterday/week/none 或具体日期。 */
function dueField(value, fallback) {
  const s = textField(value == null || value === "" ? fallback : value, 20, "截止");
  if (DUE_WORDS.has(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dateField(s, "截止日期");
  throw new HttpError(400, "截止只能是 today / tomorrow / yesterday / week / none 或 YYYY-MM-DD");
}

/** 优先级字段。 */
function priorityField(value, fallback) {
  const s = String(value == null || value === "" ? fallback : value);
  if (!PRIORITIES.has(s)) throw new HttpError(400, "优先级只能是 high / mid / low");
  return s;
}

/** 上限类字段（参会人数等）。 */
function intField(value, fallback, min, max, label) {
  if (value == null || value === "") return fallback;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, label + "应在 " + min + "~" + max + " 之间");
  return n;
}

// ---------------------------------------------------------------------------
// 待办：日期归一与视图筛选
// ---------------------------------------------------------------------------

/** 把 due 归一成具体日期（YYYY-MM-DD）；无期限返回 null。 */
function dueDateOf(due, today) {
  const t = today || dateKey();
  const s = String(due == null ? "" : due);
  if (!s || s === "none") return null;
  if (s === "today") return t;
  if (s === "tomorrow") return shiftDay(t, 1);
  if (s === "yesterday") return shiftDay(t, -1);
  if (s === "week") return shiftDay(weekRange(t).end, 0);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

function shiftDay(day, n) {
  const p = day.split("-").map(Number);
  const d = new Date(p[0], p[1] - 1, p[2] + n);
  return dateKey(d);
}

/** 本周区间（周一到周日）。 */
function weekRange(today) {
  const t = today || dateKey();
  const p = t.split("-").map(Number);
  const d = new Date(p[0], p[1] - 1, p[2]);
  const back = (d.getDay() + 6) % 7; // 周一 = 0
  const start = shiftDay(t, -back);
  return { start, end: shiftDay(start, 6) };
}

/**
 * 待办视图筛选。口径统一为「due 归一成日期再比较」：
 *  all / category —— 全部；open —— 未完成；done —— 已完成；
 *  today —— 今天到期；week —— 本周一到周日；late —— 已逾期且未完成。
 */
function filterTodos(items, view, category, today) {
  const t = today || dateKey();
  let out = (Array.isArray(items) ? items : []).slice();
  const cat = String(category == null ? "" : category).trim();
  if (cat) out = out.filter((it) => it.category === cat);
  const v = view || "";
  if (!v || v === "all" || v === "category") return out;
  if (v === "open") return out.filter((it) => !it.done);
  if (v === "done") return out.filter((it) => it.done);
  if (v === "today") return out.filter((it) => dueDateOf(it.due, t) === t);
  if (v === "week") {
    const w = weekRange(t);
    return out.filter((it) => { const d = dueDateOf(it.due, t); return !!d && d >= w.start && d <= w.end; });
  }
  if (v === "late") return out.filter((it) => { const d = dueDateOf(it.due, t); return !it.done && !!d && d < t; });
  throw new HttpError(400, "未知视图：" + v);
}

// ---------------------------------------------------------------------------
// 会议：起止时间结构化（time / duration 保留兼容）
// ---------------------------------------------------------------------------

/** 从 "09:00 - 10:00" 这类老格式里解析起止时间。 */
function parseDurationText(s) {
  const m = String(s == null ? "" : s).match(/(\d{1,2}):(\d{2})\s*[-–—~至]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return { start: pad(m[1]) + ":" + m[2], end: pad(m[3]) + ":" + m[4] };
}

/** HH:MM 加分钟，跨天则封顶 23:59。 */
function addMinutes(hhmm, minutes) {
  const p = String(hhmm).split(":").map(Number);
  let total = p[0] * 60 + p[1] + minutes;
  if (total > 23 * 60 + 59) total = 23 * 60 + 59;
  const pad = (n) => String(n).padStart(2, "0");
  return pad(Math.floor(total / 60)) + ":" + pad(total % 60);
}

/**
 * 老数据/Agent 写入补齐：startTime、endTime 缺省时从 time、duration 推导，
 * 同时把 time / duration 两个展示字段重新写回，保证旧前端与旧提示词都还能用。
 */
function normalizeMeeting(m) {
  const parsed = parseDurationText(m.duration);
  if (!m.startTime) {
    const t = String(m.time == null ? "" : m.time);
    m.startTime = /^\d{1,2}:\d{2}$/.test(t) ? t.padStart(5, "0") : (parsed ? parsed.start : "09:00");
  }
  if (!m.endTime) m.endTime = parsed ? parsed.end : addMinutes(m.startTime, 60);
  m.startTime = String(m.startTime).padStart(5, "0");
  m.endTime = String(m.endTime).padStart(5, "0");
  m.time = m.startTime;
  m.duration = m.startTime + " - " + m.endTime;
  return m;
}

/** 校验并规范化一对起止时间；结束不晚于开始时抛 400。 */
function timeRangeField(body) {
  const start = timeField(body.startTime != null ? body.startTime : body.time, "开始时间", "09:00");
  let end = "";
  if (body.endTime != null && body.endTime !== "") end = timeField(body.endTime, "结束时间", "");
  else if (body.duration != null && body.duration !== "") {
    const parsed = parseDurationText(body.duration);
    if (!parsed) throw new HttpError(400, "时长格式应为 HH:MM - HH:MM，或直接传 endTime");
    end = parsed.end;
  } else {
    end = addMinutes(start, 60);
  }
  if (end <= start) throw new HttpError(400, "结束时间必须晚于开始时间");
  return { startTime: start, endTime: end, duration: start + " - " + end };
}

// ---------------------------------------------------------------------------
// 笔记：正文拆文件，notes.json 只留索引
// ---------------------------------------------------------------------------

function notesIndexPath() {
  return join(dataRoot(), "notes.json");
}
function notesDirPath() {
  return join(dataRoot(), "notes");
}
function notePath(id) {
  return join(notesDirPath(), id + ".json");
}

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

/** 列表副标题：纯文本截断。 */
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

/** 索引项（列表返回形状）：不带正文与版本，避免一次拉整个库。 */
function indexEntry(n) {
  return {
    id: n.id,
    title: n.title,
    preview: n.preview || mdPreview(n.content),
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    tags: n.tags || [],
    pinned: Boolean(n.pinned),
    format: n.format || "markdown",
    rev: Number(n.rev || 0)
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

/** 读索引；发现老格式（索引里带 content）就地迁移成单文件。 */
async function loadNotesIndex() {
  const file = notesIndexPath();
  const store = await readStore(file, "notes");
  const items = Array.isArray(store.items) ? store.items : [];
  const legacy = store.schema !== 2 || items.some((n) => "content" in n);
  if (!legacy) {
    store.items = items;
    return store;
  }
  const dir = notesDirPath();
  await mkdir(dir, { recursive: true });
  const next = [];
  for (const n of items) {
    const id = n.id || rid("n");
    const note = {
      id,
      title: n.title || "未命名笔记",
      content: String(n.content == null ? "" : n.content),
      format: n.format === "text" ? "text" : "markdown",
      tags: Array.isArray(n.tags) ? n.tags : normTags(n.tags),
      pinned: Boolean(n.pinned),
      rev: Number(n.rev || 1),
      createdAt: n.createdAt || n.updatedAt || localStamp(),
      updatedAt: n.updatedAt || localStamp(),
      preview: n.preview || mdPreview(n.content),
      versions: Array.isArray(n.versions) ? n.versions : []
    };
    await saveNoteFile(notePath(id), note);
    next.push(indexEntry(note));
  }
  store.items = next;
  store.schema = 2;
  await saveStore(file, store);
  logInfo("notes 索引迁移完成：" + next.length + " 篇正文已拆到 notes/");
  return store;
}

/** 读单篇笔记正文。 */
async function readNote(id) {
  const file = notePath(id);
  try {
    const note = JSON.parse(await readFile(file, "utf8"));
    return normalizeNote(note);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** 写单篇笔记，并同步索引项。 */
async function saveNote(note) {
  await saveNoteFile(notePath(note.id), note);
  const index = await loadNotesIndex();
  const i = index.items.findIndex((x) => x.id === note.id);
  const entry = indexEntry(note);
  if (i >= 0) index.items[i] = entry;
  else index.items.push(entry);
  await saveStore(notesIndexPath(), index);
}

/** 正文里引用的附件文件名。 */
function collectAttachments(text) {
  const out = new Set();
  const re = /\/tidywork-api\/attachments\/([A-Za-z0-9_-]{1,64}\.(?:png|jpg|jpeg|webp|gif))/g;
  let m;
  while ((m = re.exec(String(text == null ? "" : text))) !== null) out.add(m[1]);
  return out;
}

/** 回收附件：候选文件若已不被任何笔记引用，就删掉。 */
async function gcAttachments(candidates) {
  if (!candidates || !candidates.size) return;
  const index = await loadNotesIndex();
  const alive = new Set();
  for (const item of index.items) {
    const note = await readNote(item.id);
    if (!note) continue;
    const refs = collectAttachments(note.content);
    for (const r of refs) if (candidates.has(r)) alive.add(r);
  }
  const dir = join(dataRoot(), "attachments");
  for (const file of candidates) {
    if (alive.has(file)) continue;
    try { await unlink(join(dir, file)); } catch (error) {}
  }
}

// ---------------------------------------------------------------------------
// 来源校验：挡掉任意网页对本地实例的 CSRF 写 + DNS rebinding
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostnameOf(hostHeader) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL("http://" + raw).hostname.toLowerCase();
  } catch (error) {
    return "";
  }
}

/**
 * 请求来源校验：
 *  1) Host 必须是本机回环地址，或与本实例 getOrigin() 的主机一致（容器/私网部署）；
 *  2) 带 Origin 的请求必须同源（跨站请求直接 403）；
 *  3) 写请求必须是 application/json——浏览器对跨站 JSON 请求会先发预检，
 *     而简单请求改不了 content-type，于是 CSRF 在浏览器侧就被挡住。
 */
function guardRequest(req, res, originHost) {
  const host = String(req.headers.host || "");
  const hostname = hostnameOf(host);
  const originOk = originHost && host.toLowerCase() === originHost.toLowerCase();
  if (!hostname || (!LOOPBACK_HOSTS.has(hostname) && !originOk)) {
    logError("拒绝非法 Host：" + host + "（" + req.method + " " + req.url + "）");
    sendJson(res, 403, { ok: false, error: "非法的请求来源" });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let same = false;
    try { same = new URL(String(origin)).host.toLowerCase() === host.toLowerCase(); } catch (error) { same = false; }
    if (!same) {
      logError("拒绝跨站请求：" + origin + " -> " + host);
      sendJson(res, 403, { ok: false, error: "跨站请求被拒绝" });
      return false;
    }
  }
  const site = String(req.headers["sec-fetch-site"] || "");
  if (site && site !== "same-origin" && site !== "none") {
    logError("拒绝跨站请求（sec-fetch-site=" + site + "）");
    sendJson(res, 403, { ok: false, error: "跨站请求被拒绝" });
    return false;
  }
  const method = String(req.method || "GET").toUpperCase();
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const type = String(req.headers["content-type"] || "").toLowerCase();
    if (type.indexOf("application/json") < 0) {
      sendJson(res, 415, { ok: false, error: "请求必须是 application/json" });
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 路由实现（不含排队）；对外入口见下方 handle。 */
async function routeCore(req, res, url) {
  const segs = url.pathname.split("/").filter(Boolean);

  // ---- 自检 /tidywork-api/health ----
  if (segs[0] === "tidywork-api" && segs[1] === "health" && segs.length === 2) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    let status = {};
    try { status = JSON.parse(await readFile(join(dataRoot(), "status.json"), "utf8")); } catch (error) { status = {}; }
    sendJson(res, 200, { ok: true, data: Object.assign({ version: VERSION, dataRoot: dataRoot() }, status) });
    return;
  }

  // ---- 整库导出 /tidywork-api/export ----
  if (segs[0] === "tidywork-api" && segs[1] === "export" && segs.length === 2) {
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    try {
      const todos = await readStore(join(dataRoot(), "todos.json"), "todos");
      const meetings = await readStore(join(dataRoot(), "meetings.json"), "meetings");
      const index = await loadNotesIndex();
      const notes = [];
      for (const item of index.items) {
        const note = await readNote(item.id);
        if (note) notes.push(note);
      }
      const payload = { ok: true, data: { version: VERSION, exportedAt: localStamp(), todos: todos.items || [], meetings: meetings.items || [], notes } };
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Content-Disposition": 'attachment; filename="tidywork-export-' + dateKey() + '.json"',
        "Cache-Control": "no-store"
      });
      res.end(body);
    } catch (error) {
      serverError(res, error);
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
          const body = await readJson(req);
          const title = textField(body.title, 60, "标题");
          if (!title) throw new HttpError(400, "标题不能为空");
          const store = await readStore(file, "todos");
          const item = {
            id: rid("t"),
            title,
            priority: priorityField(body.priority, "mid"),
            category: textField(body.category || "工作", 20, "分类") || "工作",
            due: dueField(body.due, "today"),
            done: false,
            createdAt: localStamp()
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
        if (!it) throw new HttpError(404, "待办不存在");
        if (req.method === "GET") {
          sendJson(res, 200, { ok: true, data: it });
          return;
        }
        if (req.method === "PATCH") {
          const body = await readJson(req);
          if ("done" in body) it.done = Boolean(body.done);
          if ("title" in body) {
            const t = textField(body.title, 60, "标题");
            if (!t) throw new HttpError(400, "标题不能为空");
            it.title = t;
          }
          // 编辑与新增同一套上限，不再出现「新增 60 字、编辑变 40 字」
          if ("priority" in body) it.priority = priorityField(body.priority, it.priority);
          if ("category" in body) it.category = textField(body.category || "工作", 20, "分类") || "工作";
          if ("due" in body) it.due = dueField(body.due, it.due);
          it.updatedAt = localStamp();
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: it });
          return;
        }
        if (req.method === "DELETE") {
          store.items = (store.items || []).filter((x) => x.id !== id);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: it });
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
          const month = String(url.searchParams.get("month") || "").trim();
          if (month && !/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "month 格式应为 YYYY-MM");
          let items = (store.items || []).map(normalizeMeeting);
          if (month) items = items.filter((it) => String(it.date || "").startsWith(month));
          items.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.startTime || "").localeCompare(String(b.startTime || "")));
          sendJson(res, 200, { ok: true, data: items });
        } catch (error) {
          serverError(res, error);
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readJson(req);
          const title = textField(body.title, 60, "标题");
          if (!title) throw new HttpError(400, "标题不能为空");
          const date = dateField(body.date, "日期");
          const range = timeRangeField(body);
          const store = await readStore(file, "meetings");
          const item = normalizeMeeting({
            id: rid("m"),
            date,
            title,
            startTime: range.startTime,
            endTime: range.endTime,
            time: range.startTime,
            duration: range.duration,
            location: textField(body.location || "线上会议", 40, "地点") || "线上会议",
            participants: intField(body.participants, 1, 1, 9999, "参会人数"),
            createdAt: localStamp()
          });
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
        const meet = (store.items || []).find((x) => x.id === id);
        if (!meet) throw new HttpError(404, "会议不存在");
        normalizeMeeting(meet);
        if (req.method === "GET") {
          sendJson(res, 200, { ok: true, data: meet });
          return;
        }
        if (req.method === "PATCH") {
          // 局部更新：只改传上来的字段，其余保留；时间成对校验，避免出现结束早于开始
          const body = await readJson(req);
          if ("title" in body) {
            const t = textField(body.title, 60, "标题");
            if (!t) throw new HttpError(400, "标题不能为空");
            meet.title = t;
          }
          if ("date" in body) meet.date = dateField(body.date, "日期");
          if ("startTime" in body || "time" in body || "endTime" in body || "duration" in body) {
            const range = timeRangeField({
              startTime: "startTime" in body ? body.startTime : meet.startTime,
              endTime: "endTime" in body ? body.endTime : null,
              duration: "duration" in body ? body.duration : null
            });
            meet.startTime = range.startTime;
            meet.endTime = range.endTime;
            meet.time = range.startTime;
            meet.duration = range.duration;
          }
          if ("location" in body) meet.location = textField(body.location || "线上会议", 40, "地点") || "线上会议";
          if ("participants" in body) meet.participants = intField(body.participants, meet.participants, 1, 9999, "参会人数");
          meet.updatedAt = localStamp();
          normalizeMeeting(meet);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: meet });
          return;
        }
        if (req.method === "DELETE") {
          store.items = (store.items || []).filter((x) => x.id !== id);
          await saveStore(file, store);
          sendJson(res, 200, { ok: true, data: meet });
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
        const body = await readJson(req, ATTACH_MAX * 2);
        const m = String(body.dataUrl || "").match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
        if (!m) throw new HttpError(400, "只支持 png / jpeg / webp / gif 图片");
        const buf = Buffer.from(m[3], "base64");
        if (buf.length > ATTACH_MAX) throw new HttpError(413, "单张图片不能超过 6MB");
        const ext = m[1] === "image/jpeg" ? "jpg" : m[1].slice("image/".length);
        const fileName = attachmentName(ext);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, fileName), buf);
        sendJson(res, 200, { ok: true, data: { url: "/tidywork-api/attachments/" + fileName } });
      } catch (error) {
        serverError(res, error);
      }
      return;
    }
    if (segs.length === 3 && req.method === "GET") {
      try {
        if (!/^[A-Za-z0-9_-]{1,64}\.(png|jpg|jpeg|webp|gif)$/.test(segs[2])) throw new HttpError(400, "bad attachment name");
        const buf = await readFile(join(dir, segs[2]));
        const ext = segs[2].split(".").pop().toLowerCase();
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }[ext] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Length": buf.length,
          // private：这类图片可能含工作内容，不允许中间缓存留存
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff"
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
    if (segs.length === 2) {
      if (req.method === "GET") {
        try {
          const index = await loadNotesIndex();
          const q = (url.searchParams.get("q") || "").trim().toLowerCase();
          const tag = (url.searchParams.get("tag") || "").trim();
          let items = index.items.slice();
          if (tag) items = items.filter((n) => (n.tags || []).indexOf(tag) >= 0);
          if (q) {
            // 全文搜索要读正文：笔记数量通常不大，按需逐篇读，不常驻内存
            const found = [];
            for (const item of items) {
              const note = await readNote(item.id);
              const text = note ? (String(note.title || "") + "\n" + String(note.content || "")) : String(item.title || "");
              if (text.toLowerCase().indexOf(q) >= 0) found.push(item);
            }
            items = found;
          }
          // 置顶优先，其余按最后编辑倒序（列表首条即默认打开的那篇）。
          items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
          sendJson(res, 200, { ok: true, data: items });
        } catch (error) {
          serverError(res, error);
        }
        return;
      }
      if (req.method === "POST") {
        try {
          const body = await readJson(req);
          const title = textField(body.title, 60, "标题") || "未命名笔记";
          const content = String(body.content == null ? "" : body.content);
          if (content.length > NOTE_MAX) throw new HttpError(413, "单篇笔记正文不能超过 200KB");
          const stamp = localStamp();
          const note = {
            id: rid("n"),
            title,
            content,
            format: body.format === "text" ? "text" : "markdown",
            tags: normTags(body.tags),
            pinned: Boolean(body.pinned),
            preview: mdPreview(content),
            rev: 1,
            createdAt: stamp,
            updatedAt: stamp,
            versions: []
          };
          await saveNote(note);
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
        const n = await readNote(id);
        if (!n) throw new HttpError(404, "笔记不存在");
        if (req.method === "GET") {
          const withVersions = url.searchParams.get("versions") === "1";
          sendJson(res, 200, { ok: true, data: withVersions ? n : Object.assign({}, n, { versions: undefined }) });
          return;
        }
        if (req.method === "PUT") {
          const body = await readJson(req);
          // rev 冲突：客户端带着读到的版本号来写，说明它拿着一份旧内容（例如 AI 刚写过这篇）。
          // 没带 rev 的调用（curl / Agent）保持原来的"整条覆盖"语义，不拦。
          if ("rev" in body && !body.force && Number(body.rev) !== Number(n.rev)) {
            sendJson(res, 409, {
              ok: false,
              error: "该笔记已在别处更新",
              data: { id: n.id, title: n.title, content: n.content, rev: n.rev, updatedAt: n.updatedAt }
            });
            return;
          }
          const prev = { rev: n.rev, title: n.title, content: n.content, savedAt: n.updatedAt };
          let changed = false;
          const beforeRefs = collectAttachments(n.content);
          if ("title" in body) {
            const t = textField(body.title, 60, "标题") || "未命名笔记";
            if (t !== n.title) { n.title = t; changed = true; }
          }
          if ("content" in body) {
            const content = String(body.content == null ? "" : body.content);
            if (content.length > NOTE_MAX) throw new HttpError(413, "单篇笔记正文不能超过 200KB");
            if (content !== n.content) {
              n.content = content;
              n.preview = mdPreview(content);
              changed = true;
            }
          }
          if ("format" in body) n.format = body.format === "text" ? "text" : "markdown";
          if ("tags" in body) n.tags = normTags(body.tags);
          if ("pinned" in body) n.pinned = Boolean(body.pinned);
          // 内容真的变了才留快照，避免自动保存把版本历史刷成一片空白。
          if (changed) {
            n.versions = (n.versions || []).concat([prev]).slice(-NOTE_VERSIONS);
          }
          n.rev = Number(n.rev || 0) + 1;
          n.updatedAt = localStamp();
          if (!n.createdAt) n.createdAt = n.updatedAt;
          await saveNote(n);
          // 正文里删掉的图片：确认没被别的笔记引用就回收
          const afterRefs = collectAttachments(n.content);
          const removed = new Set([...beforeRefs].filter((x) => !afterRefs.has(x)));
          if (removed.size) await gcAttachments(removed);
          sendJson(res, 200, { ok: true, data: n });
          return;
        }
        if (req.method === "DELETE") {
          const refs = collectAttachments(n.content);
          const index = await loadNotesIndex();
          index.items = (index.items || []).filter((x) => x.id !== id);
          await saveStore(notesIndexPath(), index);
          try { await unlink(notePath(id)); } catch (error) {}
          if (refs.size) await gcAttachments(refs);
          sendJson(res, 200, { ok: true, data: indexEntry(n) });
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
        const n = await readNote(id);
        if (!n) throw new HttpError(404, "笔记不存在");
        const body = await readJson(req);
        const target = (n.versions || []).find((v) => Number(v.rev) === Number(body.rev));
        if (!target) throw new HttpError(404, "该版本不存在或已过期");
        n.versions = (n.versions || []).concat([{ rev: n.rev, title: n.title, content: n.content, savedAt: n.updatedAt }]).slice(-NOTE_VERSIONS);
        n.title = target.title;
        n.content = target.content;
        n.preview = mdPreview(target.content);
        n.rev = Number(n.rev || 0) + 1;
        n.updatedAt = localStamp();
        await saveNote(n);
        sendJson(res, 200, { ok: true, data: n });
      } catch (error) {
        serverError(res, error);
      }
      return;
    }
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}

/** 处理 /tidywork-api/*：先验来源，GET 直读（原子写保证文件完整），写请求按资源排队。 */
async function handle(req, res, url, originHost) {
  const t0 = Date.now();
  res._twReq = req.method + " " + url.pathname + (url.search || "");
  if (!guardRequest(req, res, originHost)) return;
  // 请求结束统一记一行：状态码 >=500 走 ERROR，其余 INFO
  res.on("finish", () => {
    const ms = Date.now() - t0;
    const line = res._twReq + " -> " + res.statusCode + " " + ms + "ms";
    if (res.statusCode >= 500) logError(line);
    else if (res.statusCode < 400) logInfo(line);
  });
  if (req.method === "GET") return routeCore(req, res, url);
  const segs = url.pathname.split("/").filter(Boolean);
  const key = segs[0] === "tidywork-api" ? (segs[1] || "root") : "root";
  return withQueue(key, () => routeCore(req, res, url));
}

// ---------------------------------------------------------------------------
// Agent 工具
// ---------------------------------------------------------------------------

/** 通过 Agent 工具新增一条待办（与 POST /tidywork-api/todos 同一存储）。 */
async function addTodo(args) {
  const file = join(dataRoot(), "todos.json");
  try {
    const title = textField(args && args.title, 60, "标题");
    if (!title) throw new HttpError(400, "标题不能为空");
    const item = {
      id: rid("t"),
      title,
      priority: priorityField(args.priority, "mid"),
      category: textField(args.category || "工作", 20, "分类") || "工作",
      due: dueField(args.due, "today"),
      done: false,
      createdAt: localStamp()
    };
    return await withQueue("todos", async () => {
      const store = await readStore(file, "todos");
      store.items = store.items || [];
      store.items.push(item);
      await saveStore(file, store);
      return { ok: true, data: item };
    });
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, error: error.message };
    throw error;
  }
}

/** 通过 Agent 工具新增一场会议（与 POST /tidywork-api/meetings 同一存储）。 */
async function addMeeting(args) {
  const file = join(dataRoot(), "meetings.json");
  try {
    const title = textField(args && args.title, 60, "标题");
    if (!title) throw new HttpError(400, "标题不能为空");
    const date = dateField(args.date, "日期");
    const range = timeRangeField(args);
    const item = normalizeMeeting({
      id: rid("m"),
      date,
      title,
      startTime: range.startTime,
      endTime: range.endTime,
      location: textField(args.location || "线上会议", 40, "地点") || "线上会议",
      participants: intField(args.participants, 1, 1, 9999, "参会人数"),
      createdAt: localStamp()
    });
    return await withQueue("meetings", async () => {
      const store = await readStore(file, "meetings");
      store.items = store.items || [];
      store.items.push(item);
      await saveStore(file, store);
      return { ok: true, data: item };
    });
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, error: error.message };
    throw error;
  }
}

/** 通过 Agent 工具新增一条笔记（与 POST /tidywork-api/notes 同一存储）。 */
async function addNote(args) {
  try {
    const title = textField(args && args.title, 60, "标题") || "未命名笔记";
    const content = String(args && args.content != null ? args.content : "");
    if (!content.trim() && title === "未命名笔记") throw new HttpError(400, "标题与正文至少要有一个");
    if (content.length > NOTE_MAX) throw new HttpError(413, "单篇笔记正文不能超过 200KB");
    const stamp = localStamp();
    const item = {
      id: rid("n"),
      title,
      content,
      // Agent 写进来的正文按 Markdown 存：模型本来就爱用列表/标题组织文字，读态直接渲染。
      format: "markdown",
      tags: normTags(args && args.tags),
      pinned: false,
      preview: mdPreview(content),
      rev: 1,
      createdAt: stamp,
      updatedAt: stamp,
      versions: []
    };
    return await withQueue("notes", async () => {
      await saveNote(item);
      return { ok: true, data: item };
    });
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, error: error.message };
    throw error;
  }
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
    "- 待办 POST /todos — title 必填（≤60 字）；priority 取 high | mid | low（默认 mid）；category 默认「工作」（≤20 字）；due 取 today | tomorrow | yesterday | week | none | YYYY-MM-DD。",
    "- 会议 POST /meetings — title 与 date（YYYY-MM-DD）必填；startTime / endTime（HH:MM，结束须晚于开始）；location（≤40 字）、participants 可选。旧的 time + duration 写法仍兼容。",
    "- 笔记 POST /notes — content 必填（保留用户口述的原文，可用 Markdown 组织：标题、列表、待办 - [ ]、表格、代码块），title 可选（不给就按内容概括一个短标题）；tags 可选（数组，最多 8 个）；format 默认 markdown。",
    "调用示例：`sh \"" + join(dataRoot(), CLI_NAME) + "\" POST /meetings '{\"title\":\"智能办公周例会\",\"date\":\"2026-11-20\",\"startTime\":\"14:00\",\"endTime\":\"15:00\"}'`",
    "不要直接编辑数据目录下的 JSON 文件（笔记正文在 notes/<id>.json，索引在 notes.json）——那会绕过串行写锁，可能写坏数据。",
    "如果当前会话里也存在 tidywork_add_todo / tidywork_add_meeting / tidywork_add_note 工具，优先用工具；工具不在可用列表时就按上面的脚本写入。",
    "写完后用一句话告诉用户「已写入工作区」并复述关键字段，不要粘贴整段 JSON。",
    "用户没给的字段不要编造：缺标题就先问，缺时间就按当天最接近的整点提示确认；一次只补齐真正必要的信息。",
    "修改已有条目可以直接做：先 GET 读出清单（如 `sh tw GET /meetings`），确认用户指的是哪一条，再局部更新——待办 PATCH /todos/<id>（可改 title / priority / category / due / done）；会议 PATCH /meetings/<id>（可改 title / date / startTime / endTime / location / participants）；笔记 PUT /notes/<id>（content / title / tags / pinned / format 都可局部改，但要先 GET /notes/<id> 拿到当前 rev 并原样回传 rev，否则会和用户在面板里的编辑撞车；返回 409 表示这篇已被别处改过，重新 GET 再决定合并方式）。改完把改动复述一遍让用户确认。",
    "删除必须先问清楚是哪一条、确认之后才删（DELETE 同一个路径）。不要自己判断「这条应该没用了」就删。",
    "与工作项无关的话题按平常方式回答，不必主动提起本工作区。",
  ].join("\n"),
};

/** Agent 工具：自然语言新增会议（手工构造 ToolDefinition，不依赖 @deepseek-ai/dsh-tools）。 */
const MEETING_ADD_TOOL = {
  name: "tidywork_add_meeting",
  description:
    "在 TidyWork 会议日历中添加一场新会议。参数：title 会议标题（必填）；date 会议日期（必填，YYYY-MM-DD，例如 2026-11-06）；startTime 开始时间（HH:mm，默认 09:00）；endTime 结束时间（HH:mm，默认开始后 1 小时）；duration 时长描述（可选，与 startTime/endTime 二选一）；location 地点（默认 线上会议）；participants 参会人数（默认 1）。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "会议标题" },
      date: { type: "string", description: "会议日期 YYYY-MM-DD" },
      startTime: { type: "string", description: "开始时间 HH:MM" },
      endTime: { type: "string", description: "结束时间 HH:MM" },
      duration: { type: "string", description: "时长描述（可选）" },
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
    "在 TidyWork 待办中添加一条新任务。参数：title 任务标题（必填，≤60 字，例如“周五前完成周报”）；priority 优先级，取 high/mid/low，默认 mid；category 分类，默认 工作；due 截止，取 today/tomorrow/yesterday/week/none/具体日期（YYYY-MM-DD），默认 today。",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "任务标题" },
      priority: { type: "string", enum: ["high", "mid", "low"], description: "优先级" },
      category: { type: "string", description: "分类" },
      due: { type: "string", description: "截止：today/tomorrow/yesterday/week/none/YYYY-MM-DD" }
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
 * 新会话落在 TidyWork 工作区时，把标题改成「日期 时间」；已有标题的会话不动。
 * 用时间而不是纯日期：同一天开多个会话时不再三条一模一样的标题。
 */
function installDailyNaming(ctx, wsDir, since) {
  const titles = ctx.get ? ctx.get("sessionTitle") : null;
  if (!titles || typeof titles.rename !== "function") return false;
  ctx.on("session/created", (session) => {
    try {
      if (!session || !session.header || session.header.cwd !== wsDir) return;
      // 只处理插件启动之后新建的会话；启动时回放的旧会话一律不碰，避免覆盖历史标题。
      if (typeof session.header.createdAt !== "number" || session.header.createdAt < since - 1500) return;
      const snapshot = titles.get(session);
      if (snapshot && snapshot.title) return;
      titles.rename(session, dateKey() + " " + timeKey());
    } catch (error) {
      appendLog("[tidywork] ERROR rename session: " + String(error));
    }
  });
  return true;
}

/**
 * Cordis 插件主体：注册 /tidywork-api 前缀路由、TidyWork 专属工作区与 Agent 工具。
 * 宿主能力缺失时降级（写 status.json 并继续），不再整体抛错让侧栏入口凭空消失。
 * @param ctx - 宿主上下文（注入 webServer / tools / workspaceRegistry / systemPrompt）。
 */
async function apply(ctx) {
  const bootedAt = Date.now();
  const services = {
    webServer: Boolean(ctx && ctx.webServer && typeof ctx.webServer.register === "function"),
    tools: Boolean(ctx && ctx.tools && typeof ctx.tools.register === "function"),
    workspaceRegistry: Boolean(ctx && ctx.workspaceRegistry && typeof ctx.workspaceRegistry.create === "function"),
    systemPrompt: Boolean(ctx && ctx.systemPrompt && typeof ctx.systemPrompt.section === "function")
  };
  const missing = Object.keys(services).filter((k) => !services[k]);
  await writeStatus({ bootedAt: localStamp(), services: services, missing: missing, bootedMs: bootedAt });
  if (missing.length) logError("宿主能力缺失，已降级：" + missing.join(", "));

  // 路由：webServer 不在就没有面板数据可言，直接停在这一步（status.json 已记录原因）
    const server = ctx && ctx.webServer;
    if (!services.webServer) {
      logError("webServer 不可用，/tidywork-api 未注册");
      return;
    }
    const originHost = (() => { try { return new URL(readOrigin(server)).host; } catch (error) { return ""; } })();
    const dispose = server.register({
      kind: "prefix",
      path: "/tidywork-api",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://dsh.internal");
          await handle(req, res, url, originHost);
        } catch (error) {
          serverError(res, error);
        }
      }
    });
    ctx.effect(() => dispose, "tidywork: /tidywork-api routes");

    // 独属于 TidyWork 的工作区（目录注册，幂等：已存在则复用且不改标题）。
    if (services.workspaceRegistry) {
      const wsDir = join(dataRoot(), "workspace");
      try {
        await mkdir(wsDir, { recursive: true });
        await writeFile(join(wsDir, ".created"), String(Date.now()), "utf8");
        const ws = await ctx.workspaceRegistry.create(wsDir, "TidyWork");
        installDailyNaming(ctx, wsDir, bootedAt);
        console.log(`[tidywork] workspace ready: ${ws.id}`);
      } catch (error) {
        logError("workspace create failed: " + String(error && error.message ? error.message : error));
        await writeStatus({ workspaceError: String(error && error.message ? error.message : error) });
      }
    } else {
      await writeStatus({ workspaceError: "workspaceRegistry 不可用" });
    }

    // Agent 工具：会话中通过自然语言新增待办/会议/笔记。
    if (services.tools) {
      const disposers = [TODO_ADD_TOOL, MEETING_ADD_TOOL, NOTE_ADD_TOOL].map((tool) => {
        try { return ctx.tools.register(tool); } catch (error) {
          logError("注册工具 " + tool.name + " 失败：" + String(error && error.message ? error.message : error));
          return () => {};
        }
      });
      ctx.effect(() => { disposers.forEach((d) => { try { d(); } catch (error) {} }); }, "tidywork: agent tools");
    }

    // 会话系统提示：每个新会话都自带"这里是 TidyWork 工作区"的上下文。
    if (services.systemPrompt) {
      try {
        const disposePrompt = ctx.systemPrompt.section(WORKSPACE_PROMPT);
        ctx.effect(() => disposePrompt, "tidywork: workspace prompt");
      } catch (error) {
        logError("注册系统提示失败：" + String(error && error.message ? error.message : error));
      }
    }

    // 把本实例真实接口地址发布到数据目录：Agent 的 bash 在宿主上执行，读这个文件就不会打到别的实例。
    // 端口可能在 apply 之后才绑定，所以先试一次，再补几次重试。
    const publish = () => publishEndpoint(server).then((ok) => {
      if (!ok) return false;
      return writeStatus({ apiEndpoint: readOrigin(server), originHost: originHost }).then(() => true);
    }).catch(() => false);
    publish();
    for (const delay of [300, 1000, 3000, 8000]) {
      const timer = setTimeout(publish, delay);
      if (timer && typeof timer.unref === "function") timer.unref();
    }
}

/** 供单测/排查使用：纯函数与存储路径不外泄给宿主，只在这里导出。 */
export const __internals = {
  filterTodos,
  dueDateOf,
  weekRange,
  shiftDay,
  parseDurationText,
  addMinutes,
  normalizeMeeting,
  mdPlain,
  mdPreview,
  normTags,
  collectAttachments,
  timeField,
  dateField,
  dueField,
  textField,
  VERSION
};

export { apply, inject, name };
