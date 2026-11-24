// TidyWork 邮箱模块 · 服务端半（v3.31 起并入主插件）
// 职责：调用 engine/ 下的 Python 邮箱引擎，把邮件/日历里抽出的「待反馈 / 一般待办 / 会议」
// 投影进 TidyWork 的 todos.json / meetings.json；对外暴露 5 个 Agent 工具。
//
// 设计约束（与主插件 v3.30 整改保持一致）：
//   1) 引擎只以 execFile 方式调用，参数全部走白名单校验，不进 shell、不接受任意路径；
//   2) 邮箱凭据放数据目录（<dataRoot>/mail/config.ini），不进插件目录、不入库、不进交付包；
//   3) 清单状态文件放数据目录（<dataRoot>/mail/todo.json），引擎目录保持只读；
//   4) 投影按 mailKey upsert，引擎侧已消失的条目同步从看板移除，保证两个数据源一致；
//   5) 待办优先级统一到主插件的 high / mid / low 三档（推件 urgency=high → high，其余 mid）；
//      会议「参加状态」独立成 rsvp 字段（pending / confirmed / declined），
//      不与主插件按起止时间算出的 未开始/进行中/已结束 混在一个字段里。
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir, copyFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE_DIR = join(PLUGIN_ROOT, "engine");
const EXAMPLE_CONFIG = join(PLUGIN_ROOT, "config.example.ini");
const ENGINE_TIMEOUT = Number(process.env.TIDYWORK_ENGINE_TIMEOUT || 120000);
const MAX_OUTPUT = 16 * 1024 * 1024;

const TAG_TODO = "一般待办";
const TAG_FEEDBACK = "待反馈";
const TAG_MEETING = "会议";

/** 邮箱引擎子命令白名单：只放行待办清单相关的确定性命令。 */
const ALLOWED_COMMANDS = new Set([
  "todo-scan",
  "todo-list",
  "todo-accept",
  "todo-decline",
  "todo-done",
  "todo-add",
  "self-check"
]);

// ---------------------------------------------------------------------------
// 小工具：裁剪、校验、时间
// ---------------------------------------------------------------------------

function clip(value, max) {
  const s = String(value == null ? "" : value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

/** 参数里出现以 - 开头的值会被引擎当成选项，直接拒绝。 */
function safeValue(value, max, label) {
  const s = clip(value, max);
  if (!s) return "";
  if (s.startsWith("-")) throw new Error(label + " 不能以 - 开头");
  return s;
}

function safeId(value) {
  const s = clip(value, 64);
  if (!/^[0-9a-zA-Z_:.@*-]{1,64}$/.test(s)) throw new Error("清单编号格式不正确");
  return s;
}

function safeInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  return i < min ? min : i > max ? max : i;
}

/** 文件夹名可能是中文（如「收件箱」），只挡掉控制字符与选项前缀。 */
function safeFolder(value) {
  const s = safeValue(value, 40, "文件夹");
  if (s && !/^[\p{L}\p{N} ._\-]+$/u.test(s)) throw new Error("文件夹名包含不支持的字符");
  return s;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function addMinutes(hhmm, minutes) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!m) return "10:00";
  let total = Number(m[1]) * 60 + Number(m[2]) + minutes;
  total = ((total % 1440) + 1440) % 1440;
  return pad(Math.floor(total / 60)) + ":" + pad(total % 60);
}

function isHHMM(s) {
  return /^(\d{2}):(\d{2})$/.test(String(s || "")) && Number(String(s).slice(0, 2)) < 24;
}

// ---------------------------------------------------------------------------
// 引擎调用
// ---------------------------------------------------------------------------

/** 解析可用的 Python：显式环境变量 > 平台默认命令。 */
function pythonCandidates() {
  const env = process.env.TIDYWORK_PYTHON;
  if (env && existsSync(env)) return [env];
  return process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
}

/**
 * 跑一次邮箱引擎子命令。参数以数组传入，不经过 shell。
 * @returns {Promise<{ok:boolean, text:string, data:any}>}
 */
async function runEngine(args) {
  const cmd = String(args[0] || "");
  if (!ALLOWED_COMMANDS.has(cmd)) {
    return { ok: false, text: "不支持的邮箱操作：" + cmd, data: null };
  }
  if (!existsSync(join(ENGINE_DIR, "run.py"))) {
    return { ok: false, text: "邮箱引擎缺失：插件目录下没有 engine/run.py", data: null };
  }
  const config = await ensureConfig();
  const env = Object.assign({}, process.env, {
    QQMAIL_CONFIG: config.path,
    PYTHONIOENCODING: "utf-8"
  });
  let lastError = "";
  for (const python of pythonCandidates()) {
    try {
      const { stdout } = await execFileAsync(python, [join(ENGINE_DIR, "run.py"), ...args], {
        cwd: ENGINE_DIR,
        env: env,
        timeout: ENGINE_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true
      });
      return { ok: true, text: String(stdout || "").trim(), data: null };
    } catch (error) {
      const detail =
        String(error && error.stdout ? error.stdout : "").trim() ||
        String(error && error.stderr ? error.stderr : "").trim() ||
        String(error && error.message ? error.message : error);
      lastError = detail;
      // 找不到解释器时换下一个候选，其余错误直接返回
      if (!/ENOENT|not found|不是内部或外部命令/i.test(detail)) break;
    }
  }
  return { ok: false, text: "邮箱引擎执行失败：" + lastError, data: null };
}

/** 数据目录下的邮箱子目录：配置与清单状态都落这里。 */
function mailDir(dataRoot) {
  return join(dataRoot, "mail");
}

function statePath(dataRoot) {
  return join(mailDir(dataRoot), "todo.json");
}

/**
 * 保证数据目录里有 config.ini：没有就用插件自带的 config.example.ini 复制一份空模板。
 * 凭据只存在数据目录（mode 600），插件目录与交付包里永远只有模板。
 */
async function ensureConfig(dataRoot) {
  const dir = mailDir(dataRoot);
  const path = join(dir, "config.ini");
  await mkdir(dir, { recursive: true });
  if (!existsSync(path)) {
    if (existsSync(EXAMPLE_CONFIG)) {
      await copyFile(EXAMPLE_CONFIG, path);
      try {
        await chmod(path, 0o600);
      } catch (error) {
        // Windows 上 chmod 不生效，忽略
      }
    } else {
      await writeFile(path, "[account]\nemail =\nauth_code =\n", "utf8");
    }
  }
  return { path };
}

/** 配置文件里是否已经填了邮箱账号（不理解内容，只判断非空）。 */
async function configFilled(dataRoot) {
  const path = join(mailDir(dataRoot), "config.ini");
  try {
    const text = await readFile(path, "utf8");
    const email = (/email\s*=\s*([^\n]*)/i.exec(text) || [])[1] || "";
    const code = (/auth_code\s*=\s*([^\n]*)/i.exec(text) || [])[1] || "";
    return Boolean(email.trim() && code.trim());
  } catch (error) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 引擎条目 → 看板条目
// ---------------------------------------------------------------------------

/** 引擎给的 source 字段（邮件来源）统一成可展示结构。 */
function mailSource(item, key) {
  const raw = item && item.source ? item.source : null;
  const subject = clip(
    raw && typeof raw === "object" ? raw.subject || raw.title : typeof raw === "string" ? raw : "",
    120
  );
  const from = clip(raw && typeof raw === "object" ? raw.from || raw.sender || raw.email : "", 120);
  return {
    type: "mail",
    mailKey: clip(key, 64),
    subject: subject,
    from: from
  };
}

/** engine/todo.json 的一条 → todos.json 条目（不含 id，由调用方补）。 */
function mapTodo(item) {
  const deadline = String(item.deadline || "").trim();
  return {
    title: clip(item.title || item.summary || "待办", 60) || "待办",
    priority: String(item.urgency || "").toLowerCase() === "high" ? "high" : "mid",
    category: "工作",
    due: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : "none",
    done: String(item.status || "") === "done",
    mailKey: clip(item.key, 64),
    mailTag: String(item.tag || ""),
    mailShortId: clip(item.short_id, 16),
    mailDeadlineText: clip(item.deadline_text, 80),
    mailFeedbackTo: Array.isArray(item.feedback_to) ? item.feedback_to.map((x) => clip(x, 120)).slice(0, 8) : [],
    source: mailSource(item, item.key)
  };
}

/** 会议参加状态：引擎的 pending/accepted/declined → 本插件的 rsvp 枚举。 */
function mapRsvp(item) {
  const status = String(item.status || "pending");
  if (status === "accepted") return "confirmed";
  if (status === "declined") return "declined";
  return "pending";
}

/** engine/todo.json 的一条「会议」→ meetings.json 条目（不含 id，由调用方补）。 */
function mapMeeting(item) {
  const start = String(item.meeting_start || "");
  const end = String(item.meeting_end || "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(start) ? start.slice(0, 10) : todayKey();
  const startTime = isHHMM(start.slice(11, 16)) ? start.slice(11, 16) : "09:00";
  const endRaw = isHHMM(end.slice(11, 16)) ? end.slice(11, 16) : "";
  const endTime = endRaw && endRaw > startTime ? endRaw : addMinutes(startTime, 60);
  const rsvp = mapRsvp(item);
  const attendees = Array.isArray(item.attendees) ? item.attendees.length : Number(item.attendees || 0);
  return {
    date: date,
    title: clip(item.title || "会议", 60) || "会议",
    startTime: startTime,
    endTime: endTime,
    time: startTime,
    duration: startTime + " - " + endTime,
    location: clip(item.location || "线上会议", 40) || "线上会议",
    participants: safeInt(attendees || 1, 1, 9999, 1),
    rsvp: rsvp,
    rsvpUpdatedAt: "",
    meetingRole: clip(item.meeting_role, 40),
    mailKey: clip(item.key, 64),
    mailShortId: clip(item.short_id, 16),
    source: mailSource(item, item.key)
  };
}

// ---------------------------------------------------------------------------
// 投影：engine/todo.json → todos.json / meetings.json
// ---------------------------------------------------------------------------

/**
 * 把引擎清单投影到看板。以 mailKey 做 upsert，引擎侧已不存在的条目从看板移除。
 * @param deps - 主插件注入的存储能力 { dataRoot, withQueue, readStore, saveStore, rid, localStamp }
 */
async function syncMailToBoard(deps) {
  const { dataRoot, withQueue, readStore, saveStore, rid, localStamp } = deps;
  let state = null;
  try {
    state = JSON.parse(await readFile(statePath(dataRoot), "utf8"));
  } catch (error) {
    return { ok: true, skipped: true, todos: 0, meetings: 0, reason: "还没有扫描过邮箱" };
  }
  const items = Array.isArray(state.items) ? state.items : [];
  const todoKeys = new Set(
    items.filter((it) => it.tag === TAG_TODO || it.tag === TAG_FEEDBACK).map((it) => String(it.key || ""))
  );
  const meetingKeys = new Set(
    items
      .filter((it) => it.tag === TAG_MEETING && String(it.status || "") !== "declined")
      .map((it) => String(it.key || ""))
  );

  let todoCount = 0;
  let meetingCount = 0;
  let todoRemoved = 0;
  let meetingRemoved = 0;

  // 待办（一般待办 + 待反馈）
  await withQueue("todos", async () => {
    const file = join(dataRoot, "todos.json");
    const store = await readStore(file, "todos");
    const before = (store.items || []).length;
    store.items = (store.items || []).filter((it) => !it.mailKey || todoKeys.has(it.mailKey));
    todoRemoved = before - store.items.length;
    for (const item of items) {
      if (item.tag !== TAG_TODO && item.tag !== TAG_FEEDBACK) continue;
      const entry = mapTodo(item);
      const existing = store.items.find((it) => it.mailKey === entry.mailKey);
      if (existing) {
        Object.assign(existing, entry, { updatedAt: localStamp() });
      } else {
        store.items.push(Object.assign({ id: rid("t"), createdAt: localStamp() }, entry));
        todoCount += 1;
      }
    }
    await saveStore(file, store);
  });

  // 会议
  await withQueue("meetings", async () => {
    const file = join(dataRoot, "meetings.json");
    const store = await readStore(file, "meetings");
    const before = (store.items || []).length;
    store.items = (store.items || []).filter((it) => !it.mailKey || meetingKeys.has(it.mailKey));
    meetingRemoved = before - store.items.length;
    for (const item of items) {
      if (item.tag !== TAG_MEETING || String(item.status || "") === "declined") continue;
      const entry = mapMeeting(item);
      const existing = store.items.find((it) => it.mailKey === entry.mailKey);
      if (existing) {
        // rsvp 变化要保留时间戳，界面后面会用到
        if (existing.rsvp !== entry.rsvp) entry.rsvpUpdatedAt = localStamp();
        Object.assign(existing, entry, { updatedAt: localStamp() });
      } else {
        store.items.push(Object.assign({ id: rid("m"), createdAt: localStamp() }, entry));
        meetingCount += 1;
      }
    }
    await saveStore(file, store);
  });

  return {
    ok: true,
    todos: todoCount,
    meetings: meetingCount,
    removedTodos: todoRemoved,
    removedMeetings: meetingRemoved,
    total: items.length
  };
}

// ---------------------------------------------------------------------------
// Agent 工具
// ---------------------------------------------------------------------------

function toolResult(ok, text, extra) {
  return Object.assign({ ok: ok, text: text }, extra || {});
}

/**
 * 构造 5 个邮箱工具。
 * @param deps - 同 syncMailToBoard
 */
function buildTools(deps) {
  const scan = {
    name: "tidywork_mail_scan",
    description:
      "扫描邮箱（IMAP 邮件 + 日历），抽取「待反馈 / 一般待办 / 会议」并同步进 TidyWork 待办与会议面板。参数：days 回溯天数（默认 7，1-90）；folder 扫描文件夹（默认 inbox）；maxMails 最多读全文的邮件数（默认 40，1-200）；withCalendar 是否同时扫日历（默认 true）。",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "回溯天数，1-90，默认 7" },
        folder: { type: "string", description: "邮件文件夹，默认 inbox" },
        maxMails: { type: "number", description: "最多读取全文的邮件数，1-200，默认 40" },
        withCalendar: { type: "boolean", description: "是否同时扫日历，默认 true" }
      },
      required: []
    },
    output: {
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" }, text: { type: "string" } }
      },
      render: (args, value) => [{ type: "text", text: (value && value.text) || "邮箱扫描失败" }]
    },
    async execute(args) {
      try {
        if (!(await configFilled(deps.dataRoot))) {
          const path = join(mailDir(deps.dataRoot), "config.ini");
          return toolResult(false, "尚未配置邮箱：请把 " + path + " 里的 email 与 auth_code 填好（QQ 邮箱 → 设置 → 账号 → 开启 IMAP 后获取授权码），再重试。");
        }
        const days = safeInt(args && args.days, 1, 90, 7);
        const folder = safeFolder(args && args.folder) || "inbox";
        const maxMails = safeInt(args && args.maxMails, 1, 200, 40);
        const withCalendar = !(args && args.withCalendar === false);
        const argv = [
          "todo-scan",
          "--days", String(days),
          "--folder", folder,
          "--max-mails", String(maxMails),
          "--state", statePath(deps.dataRoot),
          "--format", "markdown"
        ];
        if (!withCalendar) argv.push("--no-calendar");
        const engine = await runEngine(argv);
        if (!engine.ok) return toolResult(false, engine.text);
        const synced = await syncMailToBoard(deps);
        const summary =
          "已同步进工作区：新增待办 " + synced.todos + " 条、会议 " + synced.meetings + " 场" +
          (synced.removedTodos || synced.removedMeetings
            ? "；清理已失效条目 待办 " + synced.removedTodos + " 条、会议 " + synced.removedMeetings + " 场"
            : "");
        return toolResult(true, engine.text + "\n\n" + summary, { sync: synced });
      } catch (error) {
        return toolResult(false, "扫描邮箱失败：" + (error && error.message ? error.message : String(error)));
      }
    }
  };

  const list = {
    name: "tidywork_mail_list",
    description:
      "查看邮箱抽取出来的待办清单（还未投影到面板之前的原始清单）。参数：status 取 active/pending/accepted/done/all（默认 active）；tag 取 一般待办/待反馈/会议（可选）。",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "pending", "accepted", "done", "all"] },
        tag: { type: "string", enum: ["一般待办", "待反馈", "会议"] }
      },
      required: []
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, text: { type: "string" } } },
      render: (args, value) => [{ type: "text", text: (value && value.text) || "读取清单失败" }]
    },
    async execute(args) {
      try {
        const argv = ["todo-list", "--state", statePath(deps.dataRoot), "--format", "markdown"];
        const status = String((args && args.status) || "active");
        if (["active", "pending", "accepted", "done", "all"].includes(status)) argv.splice(1, 0, "--status", status);
        const tag = String((args && args.tag) || "");
        if ([TAG_TODO, TAG_FEEDBACK, TAG_MEETING].includes(tag)) argv.splice(1, 0, "--tag", tag);
        const engine = await runEngine(argv);
        return toolResult(engine.ok, engine.text);
      } catch (error) {
        return toolResult(false, "读取清单失败：" + (error && error.message ? error.message : String(error)));
      }
    }
  };

  const rsvp = {
    name: "tidywork_mail_rsvp",
    description:
      "回复邮件里的会议邀请：action=accept 确认参加，action=decline 拒绝并移出清单。参数：id 清单编号（5 位短号或完整 key）。同步后会议面板里的 rsvp 会跟着变。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "清单编号（5 位短号或完整 key）" },
        action: { type: "string", enum: ["accept", "decline"], description: "accept 确认参加；decline 拒绝" }
      },
      required: ["id", "action"]
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, text: { type: "string" } } },
      render: (args, value) => [{ type: "text", text: (value && value.text) || "更新参加状态失败" }]
    },
    async execute(args) {
      try {
        const id = safeId(args && args.id);
        const action = String((args && args.action) || "");
        if (action !== "accept" && action !== "decline") return toolResult(false, "action 只能取 accept 或 decline");
        const engine = await runEngine([
          action === "accept" ? "todo-accept" : "todo-decline",
          "--id", id,
          "--state", statePath(deps.dataRoot),
          "--format", "markdown"
        ]);
        if (!engine.ok) return toolResult(false, engine.text);
        await syncMailToBoard(deps);
        return toolResult(true, engine.text);
      } catch (error) {
        return toolResult(false, "更新参加状态失败：" + (error && error.message ? error.message : String(error)));
      }
    }
  };

  const done = {
    name: "tidywork_mail_done",
    description: "把邮箱清单里的一条标记为已完成（邮件类待办处理完时用）。参数：id 清单编号（5 位短号或完整 key）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "清单编号（5 位短号或完整 key）" } },
      required: ["id"]
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, text: { type: "string" } } },
      render: (args, value) => [{ type: "text", text: (value && value.text) || "标记完成失败" }]
    },
    async execute(args) {
      try {
        const id = safeId(args && args.id);
        const engine = await runEngine(["todo-done", "--id", id, "--state", statePath(deps.dataRoot), "--format", "markdown"]);
        if (!engine.ok) return toolResult(false, engine.text);
        await syncMailToBoard(deps);
        return toolResult(true, engine.text);
      } catch (error) {
        return toolResult(false, "标记完成失败：" + (error && error.message ? error.message : String(error)));
      }
    }
  };

  const add = {
    name: "tidywork_mail_add",
    description:
      "把一件事记进邮箱清单（不写邮件，只入清单，随后同步到面板）。参数：tag 取 一般待办/待反馈/会议；title 必填；deadline 截止日 YYYY-MM-DD（可选）；meetingStart 会议开始 YYYY-MM-DDTHH:MM（tag=会议时用）；location 地点（可选）；feedbackTo 反馈对象邮箱，逗号分隔（tag=待反馈时用）；note 备注（可选）。",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", enum: ["一般待办", "待反馈", "会议"] },
        title: { type: "string", description: "标题" },
        deadline: { type: "string", description: "截止日 YYYY-MM-DD" },
        meetingStart: { type: "string", description: "会议开始 YYYY-MM-DDTHH:MM" },
        location: { type: "string", description: "会议地点" },
        feedbackTo: { type: "string", description: "反馈对象邮箱，逗号分隔" },
        note: { type: "string", description: "备注" }
      },
      required: ["tag", "title"]
    },
    output: {
      schema: { type: "object", properties: { ok: { type: "boolean" }, text: { type: "string" } } },
      render: (args, value) => [{ type: "text", text: (value && value.text) || "加入清单失败" }]
    },
    async execute(args) {
      try {
        const tag = String((args && args.tag) || "");
        if (![TAG_TODO, TAG_FEEDBACK, TAG_MEETING].includes(tag)) return toolResult(false, "tag 只能是 一般待办 / 待反馈 / 会议");
        const title = safeValue(args && args.title, 200, "标题");
        if (!title) return toolResult(false, "标题不能为空");
        const argv = ["todo-add", "--tag", tag, "--title", title, "--state", statePath(deps.dataRoot), "--format", "markdown"];
        const deadline = safeValue(args && args.deadline, 40, "截止日");
        if (deadline) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return toolResult(false, "截止日格式应为 YYYY-MM-DD");
          argv.push("--deadline", deadline);
        }
        const meetingStart = safeValue(args && args.meetingStart, 40, "会议时间");
        if (meetingStart) {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(meetingStart)) {
            return toolResult(false, "会议时间格式应为 YYYY-MM-DDTHH:MM");
          }
          argv.push("--meeting-start", meetingStart);
        }
        const location = safeValue(args && args.location, 40, "地点");
        if (location) argv.push("--location", location);
        const feedbackTo = safeValue(args && args.feedbackTo, 300, "反馈对象");
        if (feedbackTo) argv.push("--feedback-to", feedbackTo);
        const note = safeValue(args && args.note, 300, "备注");
        if (note) argv.push("--note", note);
        const engine = await runEngine(argv);
        if (!engine.ok) return toolResult(false, engine.text);
        await syncMailToBoard(deps);
        return toolResult(true, engine.text);
      } catch (error) {
        return toolResult(false, "加入清单失败：" + (error && error.message ? error.message : String(error)));
      }
    }
  };

  return [scan, list, rsvp, done, add];
}

/**
 * 邮箱模块入口：主插件只需在 apply() 里构造一次。
 * @param deps - { dataRoot, withQueue, readStore, saveStore, rid, localStamp }
 */
export function createMailModule(deps) {
  return {
    tools: buildTools(deps),
    runEngine: (args) => runEngine(args),
    sync: () => syncMailToBoard(deps),
    configPath: () => join(mailDir(deps.dataRoot), "config.ini"),
    statePath: () => statePath(deps.dataRoot)
  };
}

/** 供单测使用：纯函数不外泄。 */
export const __mailInternals = {
  mapTodo,
  mapMeeting,
  mapRsvp,
  mapSourceOf: mailSource,
  safeId,
  safeInt,
  safeFolder,
  safeValue,
  isHHMM,
  addMinutes,
  ALLOWED_COMMANDS
};
