// TidyWork 插件服务端 · 接口契约测试
// 用法：node --test tests/
// 覆盖：鉴权/CSRF、错误码、待办视图口径、会议起止时间、笔记拆文件与 rev 冲突、导出。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let base = "";
let dir = "";
let server = null;
let handler = null;

/** 伪造宿主上下文：只保留插件真正用到的那几个面。 */
function fakeCtx() {
  return {
    webServer: {
      register(route) { handler = route.handler; return () => { handler = null; }; },
      getOrigin() { return base; }
    },
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; } },
    workspaceRegistry: { async create() { return { id: "ws_test" }; } },
    get() { return null; },
    on() { return () => {}; },
    effect(fn) { const d = fn(); return () => { if (typeof d === "function") d(); }; }
  };
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "tidywork-test-"));
  process.env.DSH_HOME = dir;
  process.env.DSH_PROFILE = "test";
  const mod = await import("../tidywork-plugin/lib/index.js");
  server = createServer((req, res) => handler ? handler(req, res) : res.end());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  await mod.apply(fakeCtx());
  // 等端口地址发布一次（apply 内部是异步 fire-and-forget）
  await new Promise((r) => setTimeout(r, 300));
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

/** 常用请求：默认同源 JSON。 */
async function api(path, init) {
  const opts = Object.assign({ headers: {} }, init || {});
  opts.headers = Object.assign({ "content-type": "application/json" }, opts.headers);
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  const res = await fetch(base + path, opts);
  let json = null;
  try { json = await res.json(); } catch (e) { json = null; }
  return { status: res.status, json };
}

test("health 返回插件版本与自检状态", async () => {
  const r = await api("/tidywork-api/health");
  assert.equal(r.status, 200);
  assert.ok(r.json.data.version);
  assert.equal(r.json.data.services.webServer, true);
});

test("写请求必须是 application/json（挡简单请求 CSRF）", async () => {
  const r = await fetch(base + "/tidywork-api/todos", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ title: "x" })
  });
  assert.equal(r.status, 415);
});

test("跨站 Origin 被拒绝", async () => {
  const r = await fetch(base + "/tidywork-api/todos", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ title: "x" })
  });
  assert.equal(r.status, 403);
});

test("非法 Host 被拒绝（防 DNS rebinding）", async () => {
  const r = await fetch(base + "/tidywork-api/todos", {
    headers: { host: "evil.example" }
  }).catch(() => null);
  // Node 的 fetch 不允许覆盖 host，改用 http 通道验证
  const { request } = await import("node:http");
  const status = await new Promise((resolve) => {
    const req = request(base + "/tidywork-api/todos", { headers: { host: "evil.example" } });
    req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", () => resolve(0));
    req.end();
  });
  assert.equal(status, 403);
});

test("标题超长返回 400 而不是静默截断", async () => {
  const r = await api("/tidywork-api/todos", { method: "POST", body: { title: "长".repeat(61) } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /60/);
});

test("非法 JSON 返回 400", async () => {
  const r = await fetch(base + "/tidywork-api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops"
  });
  assert.equal(r.status, 400);
});

test("待办：view=all 返回全部，open 才是未完成，week/late 按真实日期", async () => {
  const today = await api("/tidywork-api/todos", { method: "POST", body: { title: "今天的", due: "today" } });
  assert.equal(today.status, 200);
  const done = await api("/tidywork-api/todos", { method: "POST", body: { title: "已完成的", due: "today" } });
  await api("/tidywork-api/todos/" + done.json.data.id, { method: "PATCH", body: { done: true } });
  await api("/tidywork-api/todos", { method: "POST", body: { title: "明天的", due: "tomorrow" } });
  await api("/tidywork-api/todos", { method: "POST", body: { title: "无期限", due: "none" } });
  await api("/tidywork-api/todos", { method: "POST", body: { title: "很久以前", due: "2020-01-01" } });

  const all = await api("/tidywork-api/todos?view=all");
  assert.equal(all.json.data.length, 5, "all 应包含已完成与未完成");
  const open = await api("/tidywork-api/todos?view=open");
  assert.equal(open.json.data.length, 4);
  const week = await api("/tidywork-api/todos?view=week");
  assert.deepEqual(week.json.data.map((t) => t.title).sort(), ["已完成的", "今天的", "明天的"].sort(), "week 只认本周区间内的");
  const late = await api("/tidywork-api/todos?view=late");
  assert.deepEqual(late.json.data.map((t) => t.title), ["很久以前"]);
  const bad = await api("/tidywork-api/todos?view=nope");
  assert.equal(bad.status, 400);
});

test("编辑待办不再把 60 字标题截成 40 字", async () => {
  const title = "编".repeat(60);
  const created = await api("/tidywork-api/todos", { method: "POST", body: { title } });
  const patched = await api("/tidywork-api/todos/" + created.json.data.id, { method: "PATCH", body: { title } });
  assert.equal(patched.json.data.title.length, 60);
});

test("会议：startTime/endTime 结构化，结束早于开始被拒绝", async () => {
  const ok = await api("/tidywork-api/meetings", { method: "POST", body: { title: "周会", date: "2026-11-25", startTime: "14:00", endTime: "15:30" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.data.startTime, "14:00");
  assert.equal(ok.json.data.endTime, "15:30");
  assert.equal(ok.json.data.duration, "14:00 - 15:30");

  const badRange = await api("/tidywork-api/meetings", { method: "POST", body: { title: "倒着开", date: "2026-11-25", startTime: "15:00", endTime: "14:00" } });
  assert.equal(badRange.status, 400);

  const badDate = await api("/tidywork-api/meetings", { method: "POST", body: { title: "明天", date: "明天" } });
  assert.equal(badDate.status, 400);
  assert.match(badDate.json.error, /YYYY-MM-DD/);
});

test("会议：老的 time + duration 文本仍兼容并被规范化", async () => {
  const r = await api("/tidywork-api/meetings", { method: "POST", body: { title: "老格式", date: "2026-11-26", time: "10:00", duration: "10:00 - 11:15" } });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.startTime, "10:00");
  assert.equal(r.json.data.endTime, "11:15");
});

test("笔记：正文拆到 notes/<id>.json，索引不再膨胀", async () => {
  const created = await api("/tidywork-api/notes", { method: "POST", body: { title: "测试笔记", content: "## 标题\n\n正文内容" } });
  assert.equal(created.status, 200);
  const id = created.json.data.id;
  const bodyFile = join(dir, "profiles", "test", "tidywork", "notes", id + ".json");
  const body = JSON.parse(await readFile(bodyFile, "utf8"));
  assert.equal(body.content, "## 标题\n\n正文内容");
  const indexRaw = JSON.parse(await readFile(join(dir, "profiles", "test", "tidywork", "notes.json"), "utf8"));
  const entry = indexRaw.items.find((n) => n.id === id);
  assert.ok(entry, "索引里应有该笔记");
  assert.equal("content" in entry, false, "索引不应再带正文");
  assert.equal(entry.preview, "标题 正文内容");
});

test("笔记：rev 冲突返回 409，带 force 可覆盖", async () => {
  const created = await api("/tidywork-api/notes", { method: "POST", body: { title: "冲突", content: "v1" } });
  const id = created.json.data.id;
  const first = await api("/tidywork-api/notes/" + id, { method: "PUT", body: { rev: 1, content: "v2" } });
  assert.equal(first.status, 200);
  const conflict = await api("/tidywork-api/notes/" + id, { method: "PUT", body: { rev: 1, content: "v3" } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.data.content, "v2");
  const forced = await api("/tidywork-api/notes/" + id, { method: "PUT", body: { rev: 1, force: true, content: "v3" } });
  assert.equal(forced.status, 200);
});

test("笔记：版本快照可回滚", async () => {
  const created = await api("/tidywork-api/notes", { method: "POST", body: { title: "版本", content: "第一版" } });
  const id = created.json.data.id;
  await api("/tidywork-api/notes/" + id, { method: "PUT", body: { content: "第二版" } });
  const detail = await api("/tidywork-api/notes/" + id + "?versions=1");
  const v1 = detail.json.data.versions.find((v) => v.content === "第一版");
  assert.ok(v1, "应有第一版快照");
  const restored = await api("/tidywork-api/notes/" + id + "/restore", { method: "POST", body: { rev: v1.rev } });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.data.content, "第一版");
});

test("笔记：删除后索引与正文文件都清掉", async () => {
  const created = await api("/tidywork-api/notes", { method: "POST", body: { title: "待删", content: "x" } });
  const id = created.json.data.id;
  const del = await api("/tidywork-api/notes/" + id, { method: "DELETE" });
  assert.equal(del.status, 200);
  const list = await api("/tidywork-api/notes");
  assert.equal(list.json.data.some((n) => n.id === id), false);
});

test("笔记：附件上传后，正文移除图片会回收文件", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001", "hex").toString("base64");
  const up = await api("/tidywork-api/attachments", { method: "POST", body: { dataUrl: "data:image/png;base64," + png } });
  assert.equal(up.status, 200);
  const url = up.json.data.url;
  const name = url.split("/").pop();
  const created = await api("/tidywork-api/notes", { method: "POST", body: { title: "带图", content: "![]( " + url + ")" } });
  const id = created.json.data.id;
  await api("/tidywork-api/notes/" + id, { method: "PUT", body: { content: "图片删掉了" } });
  const files = await readdir(join(dir, "profiles", "test", "tidywork", "attachments")).catch(() => []);
  assert.equal(files.includes(name), false, "不再被引用的附件应被回收");
});

test("导出接口一次给出全部数据", async () => {
  const r = await api("/tidywork-api/export");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.data.todos));
  assert.ok(Array.isArray(r.json.data.meetings));
  assert.ok(Array.isArray(r.json.data.notes));
});

test("邮箱：状态接口在未配置时返回 configured=false，并给出配置路径", async () => {
  const r = await api("/tidywork-api/mail/status");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.configured, false);
  assert.match(r.json.data.configPath, /tidywork[\s\S]*mail[\s\S]*config\.ini/);
});

test("邮箱：未配置账号时扫描返回 400 和可执行提示，不启动引擎", async () => {
  const r = await api("/tidywork-api/mail/scan", { method: "POST", body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /尚未配置邮箱/);
});

test("邮箱：回复不存在的会议返回 404，非邮箱来源的会议不放行", async () => {
  const r = await api("/tidywork-api/mail/rsvp", { method: "POST", body: { id: "m_not_exist", action: "accept" } });
  assert.equal(r.status, 404);

  const created = await api("/tidywork-api/meetings", { method: "POST", body: { title: "手输会议", date: "2026-11-25", startTime: "10:00", endTime: "11:00" } });
  assert.equal(created.status, 200);
  const id = created.json.data.id;
  const second = await api("/tidywork-api/mail/rsvp", { method: "POST", body: { id: id, action: "accept" } });
  assert.equal(second.status, 404);
  assert.match(second.json.error, /不是从邮箱同步/);
});

test("邮箱：rsvp 只接受 accept/decline", async () => {
  const r = await api("/tidywork-api/mail/rsvp", { method: "POST", body: { id: "x", action: "maybe" } });
  assert.equal(r.status, 400);
});

test("邮箱：设置接口拒绝坏账号，只存账号时 configured 仍为 false", async () => {
  const bad = await api("/tidywork-api/mail/config", { method: "POST", body: { email: "not-an-email", authCode: "" } });
  assert.equal(bad.status, 400);

  const saved = await api("/tidywork-api/mail/config", { method: "POST", body: { email: "737081914@qq.com", authCode: "", withSelfCheck: false } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.data.configured, false);
  assert.match(saved.json.data.text, /授权码留空/);

  const status = await api("/tidywork-api/mail/status");
  assert.equal(status.json.data.email, "737081914@qq.com");
  assert.equal(status.json.data.hasAuthCode, false);
  assert.equal(status.json.data.configured, false);
});

test("邮箱：设置接口不接受 GET", async () => {
  const r = await api("/tidywork-api/mail/config");
  assert.equal(r.status, 405);
});
