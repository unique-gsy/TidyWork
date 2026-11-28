/**
 * TidyWork × 飞书 桥接（host 侧）
 *
 * 两条链路：
 *  1) 问答：飞书机器人（自建应用 + 长连接）收到消息 → 在 TidyWork 工作区新建/续上一条
 *     DSH 会话（ctx.sessionController）→ 等本轮跑完 → 把回复发回飞书。
 *  2) 提醒：插件内定时器读 todos.json / meetings.json → 按早报 / 会前 / 待办到期规则
 *     主动推送到飞书。
 *
 * 设计约束：
 *  - 不新增常驻服务、不开公网端口：长连接从宿主进程主动外连飞书。
 *  - 凭据只落数据目录 feishu/config.json（600），不进插件包、不随导出外发。
 *  - 没有凭据时模块处于「未配置」状态，插件其余功能完全不受影响。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const CONFIG_FILE = "config.json";
const STATE_FILE = "state.json";

const DEFAULT_CONFIG = {
  enabled: true,
  appId: "",
  appSecret: "",
  allowedOpenIds: [],
  group: { enabled: true, requireMention: true },
  remind: {
    enabled: false,
    dailyAt: "08:30",
    meetingLeadMinutes: 15,
    todoAt: "09:00",
    quietStart: "22:00",
    quietEnd: "08:00"
  },
  session: { titlePrefix: "飞书" }
};

const DEFAULT_STATE = {
  sessions: {},
  seen: [],
  sent: {},
  targets: [],
  bot: { openId: "", name: "" },
  stats: { received: 0, answered: 0, reminded: 0 }
};

const MAX_SEEN = 200;
const REPLY_TIMEOUT_MS = 120000;
const TEXT_PART_LIMIT = 3000;

function now() {
  return Date.now();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 本地时间 HH:MM（提醒配置用的就是本机时区） */
function hhmm(date = new Date()) {
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function dayKey(date = new Date()) {
  return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate());
}

/** 解析 "HH:MM" → 当天分钟数；非法返回 null */
function minutesOf(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 当前时刻是否落在免打扰区间（支持跨零点，如 22:00–08:00） */
function inQuiet(cfg, date = new Date()) {
  const start = minutesOf(cfg.quietStart);
  const end = minutesOf(cfg.quietEnd);
  if (start === null || end === null || start === end) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

function cleanText(value, limit = 80) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

/** 会议开始时间：兼容 date+time+duration 与 start 字段 */
function meetingStart(item) {
  if (!item) return null;
  if (item.start) {
    const d = new Date(item.start);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (!item.date) return null;
  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(item.time || "").trim());
  const h = hm ? Number(hm[1]) : 9;
  const m = hm ? Number(hm[2]) : 0;
  const parts = String(item.date).split("-").map(Number);
  if (parts.length !== 3 || parts.some((x) => !Number.isFinite(x))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], h, m, 0, 0);
}

function meetingEnd(item) {
  const start = meetingStart(item);
  if (!start) return null;
  const span = /(\d{2}):(\d{2})\s*[-–~]\s*(\d{2}):(\d{2})/.exec(String(item.duration || ""));
  if (span) {
    const d = new Date(start);
    d.setHours(Number(span[3]), Number(span[4]), 0, 0);
    return d > start ? d : start;
  }
  return new Date(start.getTime() + 60 * 60 * 1000);
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** 飞书 lark_md 卡片；长度按元素拆分，单卡留余量 */
function cardFor(markdown) {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: "div", text: { tag: "lark_md", content: String(markdown || "").slice(0, 18000) } }]
  };
}

function splitText(text, limit = TEXT_PART_LIMIT) {
  const raw = String(text || "");
  if (raw.length <= limit) return [raw];
  const chunks = [];
  let rest = raw;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** 从 sessionController assistant 记录里取最终文本（新→旧，取最新一条有正文的） */
function replyTextFrom(records) {
  const list = Array.isArray(records) ? records : [];
  // records 是最新在前；一轮里可能有「旁白 + 最终答案」多条，取最新一条有 text 的即可
  for (const rec of list) {
    const event = rec && rec.event ? rec.event : rec;
    const parts = (event && event.data && event.data.message && event.data.message.content) || [];
    const text = parts
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

export function createFeishuBridge(options) {
  return new FeishuBridge(options);
}

class FeishuBridge {
  constructor(options) {
    const opts = options || {};
    this.ctx = opts.ctx;
    this.dataRoot = opts.dataRoot;
    this.log = typeof opts.log === "function" ? opts.log : () => {};
    this.getWorkspaceId = typeof opts.getWorkspaceId === "function" ? opts.getWorkspaceId : () => "";
    this.readTodos = typeof opts.readTodos === "function" ? opts.readTodos : async () => [];
    this.readMeetings = typeof opts.readMeetings === "function" ? opts.readMeetings : async () => [];
    this.dir = join(this.dataRoot, "feishu");

    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.status = { connected: false, connecting: false, state: "off", lastError: "", startedAt: 0 };
    this.lark = null;
    this.client = null;
    this.ws = null;
    this.dispatcher = null;
    this.reminderTimer = null;
    this.chains = new Map();
    this.reloadTimer = null;
    this.stopped = true;
    this.answeredAt = 0;
  }

  // ---------------------------------------------------------------- 持久化

  async init() {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      this.log("[tidywork] 飞书目录创建失败：" + String(error));
      return;
    }
    await this.loadConfig();
    await this.loadState();
    if (this.config.enabled && this.config.appId && this.config.appSecret) {
      this.connect().catch((error) => this.setError(error));
    }
    this.startReminders();
  }

  async loadConfig() {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, CONFIG_FILE), "utf8"));
      this.config = mergeConfig(DEFAULT_CONFIG, raw);
    } catch (error) {
      if (error && error.code !== "ENOENT") this.log("[tidywork] 飞书配置读取失败：" + String(error));
    }
  }

  async loadState() {
    try {
      const raw = JSON.parse(await readFile(join(this.dir, STATE_FILE), "utf8"));
      this.state = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), raw);
      this.state.stats = Object.assign({ received: 0, answered: 0, reminded: 0 }, raw && raw.stats);
      this.state.bot = Object.assign({ openId: "", name: "" }, raw && raw.bot);
    } catch (error) {
      if (error && error.code !== "ENOENT") this.log("[tidywork] 飞书状态读取失败：" + String(error));
    }
  }

  async persistConfig() {
    await this.writeSecretFile(CONFIG_FILE, this.config);
  }

  async persistState() {
    await this.writeSecretFile(STATE_FILE, this.state);
  }

  async writeSecretFile(name, value) {
    const file = join(this.dir, name);
    const tmp = file + ".tmp-" + randomUUID();
    await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tmp, file);
    try {
      await chmod(file, 0o600);
    } catch (error) {
      /* Windows 上 chmod 无意义，忽略 */
    }
  }

  // ---------------------------------------------------------------- 配置

  /** 合并配置（remind/group 只做一层深合并，其余覆盖） */
  applyConfig(patch) {
    const next = mergeConfig(this.config, patch || {});
    const before = { appId: this.config.appId, appSecret: this.config.appSecret, enabled: this.config.enabled };
    this.config = next;
    const changed = before.appId !== next.appId || before.appSecret !== next.appSecret || before.enabled !== next.enabled;
    return { changed };
  }

  async saveConfig(patch) {
    const { changed } = this.applyConfig(patch);
    await this.persistConfig();
    if (changed) {
      if (this.config.enabled && this.config.appId && this.config.appSecret) {
        this.connect().catch((error) => this.setError(error));
      } else {
        this.stop();
      }
    }
    if (!this.config.remind.enabled) this.stopReminders();
    else this.startReminders();
    return this.snapshot();
  }

  // ---------------------------------------------------------------- 连接

  async loadSdk() {
    if (this.lark) return this.lark;
    const require = createRequire(import.meta.url);
    const module = require("./vendor/lark/lark-sdk.cjs");
    this.lark = module;
    return module;
  }

  setError(error) {
    const message = error && error.message ? error.message : String(error);
    this.status.lastError = cleanText(message, 300);
    this.log("[tidywork] 飞书连接错误：" + message);
    this.status.connected = false;
    this.status.connecting = false;
  }

  async connect() {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.stop();
    const appId = this.config.appId;
    const appSecret = this.config.appSecret;
    if (!appId || !appSecret) {
      this.status.state = "unconfigured";
      return;
    }
    if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
      this.status.state = "invalid-app-id";
      this.status.lastError = "App ID 格式应为 cli_ 开头 + 16 位十六进制，请核对开发者后台";
      return;
    }
    this.status = { connected: false, connecting: true, state: "connecting", lastError: "", startedAt: now() };
    this.stopped = false;
    try {
      const Lark = await this.loadSdk();
      this.client = new Lark.Client({ appId, appSecret, loggerLevel: Lark.LoggerLevel.error });
      this.dispatcher = new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": (data) => this.onMessage(data)
      });
      this.ws = new Lark.WSClient({
        appId,
        appSecret,
        loggerLevel: Lark.LoggerLevel.error,
        onReady: () => {
          this.status.connected = true;
          this.status.connecting = false;
          this.status.state = "connected";
          this.status.lastError = "";
          if (this.verifyTimer) {
            clearTimeout(this.verifyTimer);
            this.verifyTimer = null;
          }
          this.log("[tidywork] 飞书长连接已建立");
          this.fetchBotInfo().catch(() => {});
        },
        onError: (error) => this.setError(error),
        onReconnecting: () => {
          this.status.connected = false;
          this.status.state = "reconnecting";
        },
        onReconnected: () => {
          this.status.connected = true;
          this.status.state = "connected";
        }
      });
      await this.ws.start({ eventDispatcher: this.dispatcher });
      this.log("[tidywork] 飞书长连接启动");
      // 凭据错误时 SDK 会一直重试而不报错，这里补一个 25 秒的体检，把问题说清楚
      this.verifyTimer = setTimeout(() => {
        if (this.status.connected) return;
        this.probeFailure().catch(() => {});
      }, 25000);
      if (this.verifyTimer && typeof this.verifyTimer.unref === "function") this.verifyTimer.unref();
    } catch (error) {
      this.setError(error);
      this.status.state = "failed";
    }
  }

  async probeFailure() {
    if (this.status.connected || !this.client) return;
    let detail = "";
    try {
      await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
    } catch (error) {
      detail = error && error.message ? error.message : String(error);
    }
    this.status.connecting = false;
    this.status.state = "failed";
    this.status.lastError = cleanText(
      "长连接 25 秒内未建立" + (detail ? "：" + detail : "，请核对 App ID / Secret、应用是否已发布、事件订阅是否选「长连接」"),
      300
    );
    this.log("[tidywork] 飞书连接体检未通过：" + this.status.lastError);
  }

  stop() {
    this.stopped = true;
    if (this.verifyTimer) {
      clearTimeout(this.verifyTimer);
      this.verifyTimer = null;
    }
    try {
      if (this.ws && typeof this.ws.close === "function") this.ws.close({ force: true });
    } catch (error) {
      /* ignore */
    }
    this.ws = null;
    this.client = null;
    this.dispatcher = null;
    this.status.connected = false;
    this.status.connecting = false;
    this.status.state = this.config.enabled && this.config.appId ? "stopped" : "off";
  }

  async fetchBotInfo() {
    if (!this.client) return;
    try {
      const res = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info" });
      const bot = (res && res.bot) || {};
      this.state.bot = { openId: bot.open_id || "", name: bot.app_name || "" };
      await this.persistState();
    } catch (error) {
      this.log("[tidywork] 读取机器人信息失败：" + String(error));
    }
  }

  // ---------------------------------------------------------------- 收消息

  async onMessage(data) {
    try {
      const msg = (data && data.message) || {};
      const sender = (data && data.sender) || {};
      if (!msg.message_id || !msg.content) return;
      if (sender.sender_type && sender.sender_type !== "user") return; // 忽略机器人/应用自己

      const openId = (sender.sender_id && sender.sender_id.open_id) || "";
      if (this.state.seen.includes(msg.message_id)) return;
      this.state.seen.push(msg.message_id);
      if (this.state.seen.length > MAX_SEEN) this.state.seen.splice(0, this.state.seen.length - MAX_SEEN);

      const chatType = msg.chat_type === "group" ? "group" : "p2p";
      if (chatType === "group" && !this.config.group.enabled) return;

      let text = this.textOf(msg);
      if (!text) {
        await this.reply(msg.message_id, "目前只认文字消息，语音/图片可以先在 TidyWork 里处理。");
        return;
      }
      if (chatType === "group" && this.config.group.requireMention) {
        const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
        const hit =
          (this.state.bot.openId && mentions.some((m) => (m && (m.id && m.id.open_id)) === this.state.bot.openId)) ||
          mentions.some((m) => m && m.name && this.state.bot.name && m.name === this.state.bot.name) ||
          /@_user_\d+/.test(msg.content);
        if (!hit) return;
      }
      text = text.replace(/@_user_\d+/g, " ").replace(/\s+/g, " ").trim();
      if (!text) return;

      if (this.config.allowedOpenIds.length && !this.config.allowedOpenIds.includes(openId)) {
        await this.reply(msg.message_id, "这台机器人只对接了指定账号，先把你的 open_id 加进白名单：\n" + openId);
        return;
      }

      this.state.stats.received += 1;
      this.touchTarget(chatType === "p2p" ? { kind: "p2p", id: openId } : { kind: "group", id: msg.chat_id });

      const label = chatType === "p2p" ? "私聊" : "群 " + String(msg.chat_id || "").slice(-6);
      const key = (chatType === "p2p" ? "p2p:" : "group:" + msg.chat_id + ":") + openId;

      if (/^(帮助|help|怎么用|使用说明)$/i.test(text)) {
        await this.reply(msg.message_id, this.helpText());
        return;
      }
      if (/^(今天|today|日程)$/i.test(text)) {
        await this.reply(msg.message_id, await this.todayDigest());
        return;
      }
      if (/^(待办|todos?)$/i.test(text)) {
        await this.reply(msg.message_id, await this.todoDigest());
        return;
      }

      const task = this.enqueue(key, () => this.askAgent(text, key, label));
      let answer = null;
      if (chatType === "p2p") {
        // 跑得快就直接回；超过 6 秒还没结果，先给一句「在处理」，避免对面干等
        const slow = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 6000);
          if (timer && typeof timer.unref === "function") timer.unref();
        });
        const first = await Promise.race([task, slow]);
        if (first) {
          answer = first;
        } else {
          await this.reply(msg.message_id, "收到，正在 TidyWork 里处理，跑完回你。").catch(() => {});
          answer = await task;
        }
      } else {
        answer = await task;
      }
      const body = answer && answer.reply ? answer.reply : "这次没跑出结果，稍后再试一次。";
      await this.reply(msg.message_id, body);
      this.state.stats.answered += 1;
      this.answeredAt = now();
      await this.persistState();
    } catch (error) {
      this.setError(error);
      try {
        if (data && data.message && data.message.message_id) {
          await this.reply(data.message.message_id, "处理失败了：" + cleanText(error && error.message ? error.message : error, 200));
        }
      } catch (ignored) {
        /* ignore */
      }
    }
  }

  textOf(msg) {
    if (msg.message_type !== "text") return "";
    try {
      const parsed = JSON.parse(msg.content);
      return String((parsed && parsed.text) || "").trim();
    } catch (error) {
      return "";
    }
  }

  helpText() {
    return [
      "TidyWork × 飞书",
      "",
      "直接说人话就行，例如：",
      "· 明天下午三点跟产品过一版，帮我建个会议",
      "· 这周还剩哪些待办",
      "· 把季度总结挪到周五",
      "",
      "快捷指令：今天 / 待办 / 帮助",
      "每次问答都会落到 TidyWork 工作区里对应的一条会话，侧边栏能看到。"
    ].join("\n");
  }

  // ---------------------------------------------------------------- 会话问答

  ensureController() {
    const controller = this.hasController();
    if (!controller || typeof controller.create !== "function" || typeof controller.prompt !== "function") {
      throw new Error("宿主未提供 sessionController，飞书问答不可用（请确认运行的是 DSH 桌面/Web 宿主）");
    }
    return controller;
  }

  hasController() {
    try {
      if (this.ctx && this.ctx.sessionController) return this.ctx.sessionController;
    } catch (error) {
      /* 未 inject 时会抛，按「不可用」处理 */
    }
    try {
      if (this.ctx && typeof this.ctx.get === "function") return this.ctx.get("sessionController") || null;
    } catch (error) {
      /* ignore */
    }
    return null;
  }

  async askAgent(text, key, label) {
    const controller = this.ensureController();
    const sessionId = await this.ensureSession(key, label);
    const signal = new AbortController().signal;
    let before = { cursor: -1 };
    try {
      before = await controller.state({ sessionId }, signal);
    } catch (error) {
      // 映射里的会话已不存在：重建一条
      delete this.state.sessions[key];
      const fresh = await this.ensureSession(key, label);
      before = await controller.state({ sessionId: fresh }, signal);
      return this.promptAndWait(fresh, text, (before && before.cursor) || -1);
    }
    return this.promptAndWait(sessionId, text, (before && before.cursor) || -1);
  }

  async promptAndWait(sessionId, text, cursor) {
    const controller = this.ensureController();
    const signal = new AbortController().signal;
    await controller.prompt(
      { sessionId, requestId: "fs-" + randomUUID(), content: [{ type: "text", text }], mode: "queue" },
      signal
    );
    const timer = AbortSignal.timeout(REPLY_TIMEOUT_MS + 15000);
    try {
      const result = await controller.wait({ sessionId, timeoutMs: REPLY_TIMEOUT_MS, afterSeq: cursor, maxMessages: 8 }, timer);
      const reply = replyTextFrom(result && result.output && result.output.records);
      if (reply) return { reply, sessionId };
      return { reply: "这条跑完了，但没有文字结论。可以到 TidyWork 里打开这条会话看过程。", sessionId };
    } catch (error) {
      if (error && /timeout|cancel/i.test(String(error.message || error))) {
        return { reply: "还在跑，超过 2 分钟了。先去 TidyWork 会话里看进度，好了我再回你。", sessionId };
      }
      throw error;
    }
  }

  async ensureSession(key, label) {
    const controller = this.ensureController();
    const existing = this.state.sessions[key];
    if (existing && existing.sessionId) {
      try {
        await controller.state({ sessionId: existing.sessionId }, new AbortController().signal);
        return existing.sessionId;
      } catch (error) {
        delete this.state.sessions[key];
      }
    }
    const workspaceId = this.getWorkspaceId();
    const created = await controller.create(workspaceId ? { workspaceId } : {});
    const sessionId = created && created.sessionId;
    if (!sessionId) throw new Error("创建会话失败");
    const title = cleanText((this.config.session.titlePrefix || "飞书") + " · " + label, 40);
    // 新建会话要先等 session/created 落盘，否则 rename 会被宿主拒绝；失败不影响问答
    if (typeof controller.rename === "function") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 800));
          await controller.rename({ sessionId, title });
          break;
        } catch (error) {
          if (attempt === 2) this.log("[tidywork] 会话改名失败：" + String(error));
        }
      }
    }
    this.state.sessions[key] = { sessionId, title, updatedAt: now() };
    await this.persistState();
    return sessionId;
  }

  /** 同一聊天串行，避免两句话同时往一条会话里塞 */
  enqueue(key, job) {
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev.then(job, job);
    let tail = null;
    tail = next.catch(() => {}).finally(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    this.chains.set(key, tail);
    return next;
  }

  // ---------------------------------------------------------------- 发送

  async sendTo(target, markdown, kind) {
    if (!this.client) throw new Error("飞书连接未建立");
    if (!target || !target.id) throw new Error("没有推送目标：先在飞书里给机器人发一句话");
    const payload = {
      receive_id: target.id,
      msg_type: kind === "card" ? "interactive" : "text",
      content:
        kind === "card"
          ? JSON.stringify(cardFor(markdown))
          : JSON.stringify({ text: markdown })
    };
    await this.client.request({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: { receive_id_type: target.kind === "group" ? "chat_id" : "open_id" },
      data: payload
    });
  }

  async reply(messageId, text) {
    if (!this.client) throw new Error("飞书连接未建立");
    const chunks = splitText(text);
    for (let i = 0; i < chunks.length; i += 1) {
      if (!chunks[i]) continue;
      try {
        await this.client.request({
          method: "POST",
          url: "/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply",
          data: { msg_type: "interactive", content: JSON.stringify(cardFor(chunks[i])) }
        });
      } catch (error) {
        await this.client.request({
          method: "POST",
          url: "/open-apis/im/v1/messages/" + encodeURIComponent(messageId) + "/reply",
          data: { msg_type: "text", content: JSON.stringify({ text: chunks[i] }) }
        });
      }
    }
  }

  touchTarget(target) {
    if (!target || !target.id) return;
    const found = this.state.targets.find((t) => t.kind === target.kind && t.id === target.id);
    if (found) {
      found.lastAt = now();
    } else {
      this.state.targets.push({ kind: target.kind, id: target.id, lastAt: now(), remind: true });
    }
    // 最多留 20 个
    if (this.state.targets.length > 20) {
      this.state.targets.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
      this.state.targets.length = 20;
    }
  }

  activeTargets() {
    return this.state.targets.filter((t) => t && t.id && t.remind !== false);
  }

  // ---------------------------------------------------------------- 汇总文本

  async loadAgenda(date = new Date()) {
    const [todos, meetings] = await Promise.all([this.readTodos(), this.readMeetings()]);
    const todayMeetings = (meetings || [])
      .filter((m) => m && !m.deleted && sameDay(meetingStart(m) || new Date(0), date))
      .sort((a, b) => (meetingStart(a) || 0) - (meetingStart(b) || 0));
    const todoList = (todos || []).filter((t) => t && !t.deleted);
    const open = todoList.filter((t) => !t.done);
    const dueToday = open.filter((t) => t.due && sameDay(new Date(t.due), date));
    const overdue = open.filter((t) => t.due && new Date(t.due) < date && !sameDay(new Date(t.due), date));
    return { meetings: todayMeetings, todos: todoList, open, dueToday, overdue };
  }

  async todayDigest(date = new Date()) {
    const agenda = await this.loadAgenda(date);
    const lines = ["**今天 · " + (date.getMonth() + 1) + "月" + date.getDate() + "日**", ""];
    lines.push("**会议 " + agenda.meetings.length + " 场**");
    if (!agenda.meetings.length) lines.push("今天没有会议。");
    for (const m of agenda.meetings) {
      const start = meetingStart(m);
      const end = meetingEnd(m);
      lines.push(
        "· " + (start ? pad(start.getHours()) + ":" + pad(start.getMinutes()) : "待定") +
        (end ? "–" + pad(end.getHours()) + ":" + pad(end.getMinutes()) : "") +
        " " + cleanText(m.title, 40) + (m.location ? " · " + cleanText(m.location, 20) : "")
      );
    }
    lines.push("");
    lines.push("**待办**：今天 " + agenda.dueToday.length + " · 逾期 " + agenda.overdue.length + " · 进行中 " + agenda.open.length);
    for (const t of agenda.dueToday.concat(agenda.overdue).slice(0, 8)) {
      const due = t.due ? "（" + String(t.due).slice(5) + "）" : "";
      lines.push("· " + cleanText(t.title, 50) + due);
    }
    if (!agenda.dueToday.length && !agenda.overdue.length) lines.push("今天没有到期或逾期的待办。");
    return lines.join("\n");
  }

  async todoDigest(date = new Date()) {
    const agenda = await this.loadAgenda(date);
    const lines = ["**待办**：进行中 " + agenda.open.length + " 项", ""];
    const bucket = (title, list) => {
      if (!list.length) return;
      lines.push("**" + title + "**");
      for (const t of list.slice(0, 10)) {
        lines.push("· " + cleanText(t.title, 50) + (t.due ? "（" + String(t.due).slice(5) + "）" : ""));
      }
      lines.push("");
    };
    bucket("今天到期", agenda.dueToday);
    bucket("已逾期", agenda.overdue);
    const later = agenda.open.filter((t) => !agenda.dueToday.includes(t) && !agenda.overdue.includes(t));
    bucket("之后", later);
    if (!agenda.open.length) lines.push("清空了，没有进行中的待办。");
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- 提醒

  startReminders() {
    this.stopReminders();
    if (!this.config.remind.enabled) return;
    this.reminderTimer = setInterval(() => {
      this.tickReminders().catch((error) => this.log("[tidywork] 提醒检查失败：" + String(error)));
    }, 30000);
    // 启动后 10 秒先跑一次，避免刚开插件时要等半分钟
    setTimeout(() => this.tickReminders().catch(() => {}), 10000);
  }

  stopReminders() {
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  sentKey(key, date = new Date()) {
    return dayKey(date) + "|" + key;
  }

  wasSent(key, date = new Date()) {
    return Boolean(this.state.sent[this.sentKey(key, date)]);
  }

  markSent(key, date = new Date()) {
    this.state.sent[this.sentKey(key, date)] = now();
    // 只保留最近 7 天的去重记录
    const cutoff = now() - 7 * 86400000;
    for (const [k, at] of Object.entries(this.state.sent)) {
      if (!(at >= cutoff)) delete this.state.sent[k];
    }
  }

  async tickReminders() {
    const cfg = this.config.remind;
    if (!cfg.enabled || !this.status.connected) return;
    const nowDate = new Date();
    if (inQuiet(cfg, nowDate)) return;
    const cur = hhmm(nowDate);
    const targets = this.activeTargets();
    if (!targets.length) return;

    const due = [];
    if (cur === cfg.dailyAt && !this.wasSent("daily", nowDate)) {
      due.push({ key: "daily", text: await this.todayDigest(nowDate) });
    }
    if (cur === cfg.todoAt && !this.wasSent("todo", nowDate)) {
      const agenda = await this.loadAgenda(nowDate);
      if (agenda.dueToday.length || agenda.overdue.length) {
        const lines = ["**待办提醒**", ""];
        for (const t of agenda.dueToday.concat(agenda.overdue).slice(0, 8)) {
          lines.push("· " + cleanText(t.title, 50) + (t.due ? "（" + String(t.due).slice(5) + "）" : ""));
        }
        due.push({ key: "todo", text: lines.join("\n") });
      }
    }

    const lead = Number(cfg.meetingLeadMinutes) || 15;
    const meetings = (await this.readMeetings()) || [];
    for (const m of meetings) {
      const start = meetingStart(m);
      if (!start || !sameDay(start, nowDate)) continue;
      const diffMin = (start.getTime() - nowDate.getTime()) / 60000;
      if (diffMin <= lead && diffMin > -1) {
        const key = "meeting:" + (m.id || cleanText(m.title, 20));
        if (this.wasSent(key, nowDate)) continue;
        const lines = [
          "**" + lead + " 分钟后就开会**",
          "",
          "· " + cleanText(m.title, 50),
          "· " + pad(start.getHours()) + ":" + pad(start.getMinutes()) + (m.location ? " · " + cleanText(m.location, 30) : "")
        ];
        due.push({ key, text: lines.join("\n") });
      }
    }

    for (const item of due) {
      for (const target of targets) {
        try {
          await this.sendTo(target, item.text, "card");
        } catch (error) {
          this.log("[tidywork] 提醒发送失败（" + target.kind + "）：" + String(error));
        }
      }
      this.markSent(item.key, nowDate);
      this.state.stats.reminded += 1;
    }
    if (due.length) await this.persistState();
  }

  // ---------------------------------------------------------------- 对外

  async testSend() {
    const targets = this.activeTargets();
    if (!targets.length) throw new Error("还没有推送目标：先在飞书里给机器人发一句话（私聊或群里 @ 它）");
    const target = targets[0];
    await this.sendTo(target, "**TidyWork 测试消息**\n\n这条能收到，说明推送链路已经通了。", "card");
    return { ok: true, target };
  }

  snapshot() {
    return {
      configured: Boolean(this.config.appId && this.config.appSecret),
      enabled: this.config.enabled,
      connected: this.status.connected,
      connecting: this.status.connecting,
      state: this.status.state,
      lastError: this.status.lastError,
      appId: this.config.appId,
      hasSecret: Boolean(this.config.appSecret),
      bot: { name: this.state.bot.name, openId: this.state.bot.openId },
      controller: Boolean(this.hasController()),
      group: this.config.group,
      remind: this.config.remind,
      allowedOpenIds: this.config.allowedOpenIds,
      targets: this.state.targets.map((t) => ({ kind: t.kind, id: t.id, remind: t.remind !== false, lastAt: t.lastAt })),
      sessions: Object.entries(this.state.sessions).map(([key, v]) => ({ key, sessionId: v.sessionId, title: v.title, updatedAt: v.updatedAt })),
      stats: this.state.stats
    };
  }

  statusSnapshot() {
    return this.snapshot();
  }

  /** 本地自测：不经过飞书，直接走同一套「建会话 → 提问 → 取回复」 */
  async localAsk(text) {
    const answer = await this.askAgent(String(text || "").trim() || "今天有哪些安排？", "local-test", "本地测试");
    return { reply: answer.reply, sessionId: answer.sessionId };
  }
}

/** 深合并：只对普通对象做一层递归，数组整体替换 */
function mergeConfig(base, patch) {
  const out = JSON.parse(JSON.stringify(base || {}));
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      out[key] = mergeConfig(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
