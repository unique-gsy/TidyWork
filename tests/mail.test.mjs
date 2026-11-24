// 邮箱模块 · 映射与投影测试（不联网、不依赖 Python 引擎）
// 用法：node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailModule, __mailInternals } from "../tidywork-plugin/lib/mail.js";

const { mapTodo, mapMeeting, safeId, safeValue, safeFolder, safeInt } = __mailInternals;

/** 最小的存储替身：readStore/saveStore 直接读写 JSON 文件，行为与主插件一致。 */
function fakeDeps(root) {
  const queues = new Map();
  const withQueue = (key, fn) => {
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(key, next.then(() => {}, () => {}));
    return next;
  };
  const readStore = async (file, seedsKey) => {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" && seedsKey) return { version: 1, items: [] };
      throw error;
    }
  };
  const saveStore = async (file, data) => {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify(data, null, 2), "utf8");
  };
  let n = 0;
  return {
    dataRoot: root,
    withQueue,
    readStore,
    saveStore,
    rid: (prefix) => prefix + String(++n).padStart(4, "0"),
    localStamp: () => "2026-11-24T22:30:00+08:00"
  };
}

const STATE = {
  version: 1,
  updated_at: "2026-11-24T21:00:00",
  items: [
    {
      key: "mail:feedback:aaa",
      short_id: "00001",
      tag: "待反馈",
      title: "确认下周排期",
      urgency: "high",
      deadline: "2026-11-26",
      deadline_text: "本周三前",
      status: "pending",
      feedback_to: ["a@x.com"],
      source: { subject: "排期确认", from: "b@x.com" }
    },
    {
      key: "mail:todo:bbb",
      short_id: "00002",
      tag: "一般待办",
      title: "填报销单",
      urgency: "normal",
      deadline: "",
      status: "done",
      source: { subject: "报销提醒", from: "c@x.com" }
    },
    {
      key: "mail:meeting:ccc",
      short_id: "00003",
      tag: "会议",
      title: "产品评审",
      meeting_start: "2026-11-25T15:00",
      meeting_end: "2026-11-25T15:30",
      location: "腾讯会议 123456789",
      attendees: ["a@x.com", "b@x.com"],
      meeting_role: "我参与",
      needs_decision: true,
      status: "pending",
      source: { subject: "邀请：产品评审", from: "pm@x.com" }
    },
    {
      key: "mail:meeting:ddd",
      short_id: "00004",
      tag: "会议",
      title: "已拒绝的会",
      meeting_start: "2026-11-26T10:00",
      meeting_end: "2026-11-26T11:00",
      status: "declined"
    },
    {
      key: "mail:meeting:eee",
      short_id: "00005",
      tag: "会议",
      title: "周会",
      meeting_start: "2026-11-27T09:30",
      meeting_end: "2026-11-27T10:00",
      status: "accepted"
    }
  ]
};

test("映射：优先级统一到高/中/低，截止日与来源落到看板字段", () => {
  const feedback = mapTodo(STATE.items[0]);
  assert.equal(feedback.priority, "high");
  assert.equal(feedback.due, "2026-11-26");
  assert.equal(feedback.done, false);
  assert.equal(feedback.source.type, "mail");
  assert.equal(feedback.source.subject, "排期确认");
  assert.equal(feedback.mailKey, "mail:feedback:aaa");

  const todo = mapTodo(STATE.items[1]);
  assert.equal(todo.priority, "mid");
  assert.equal(todo.due, "none");
  assert.equal(todo.done, true);
});

test("映射：会议保留起止时间，rsvp 独立于时间状态", () => {
  const meet = mapMeeting(STATE.items[2]);
  assert.equal(meet.date, "2026-11-25");
  assert.equal(meet.startTime, "15:00");
  assert.equal(meet.endTime, "15:30");
  assert.equal(meet.duration, "15:00 - 15:30");
  assert.equal(meet.rsvp, "pending");
  assert.equal(meet.participants, 2);

  assert.equal(mapMeeting(STATE.items[4]).rsvp, "confirmed");
  assert.equal(mapMeeting({ tag: "会议", title: "x", meeting_start: "2026-11-25T09:00", status: "declined" }).rsvp, "declined");
});

test("投影：待办与会议按 mailKey upsert，declined 不进看板，重复同步不产生重复条目", async () => {
  const root = await mkdtemp(join(tmpdir(), "tw-mail-"));
  try {
    await mkdir(join(root, "mail"), { recursive: true });
    await writeFile(join(root, "mail", "todo.json"), JSON.stringify(STATE), "utf8");
    const deps = fakeDeps(root);
    const mail = createMailModule(deps);

    const first = await mail.sync();
    assert.equal(first.todos, 2);
    assert.equal(first.meetings, 2);

    const todos = JSON.parse(await readFile(join(root, "todos.json"), "utf8"));
    const meetings = JSON.parse(await readFile(join(root, "meetings.json"), "utf8"));
    assert.equal(todos.items.length, 2);
    assert.equal(meetings.items.length, 2);
    assert.ok(!meetings.items.some((m) => m.title === "已拒绝的会"));

    const second = await mail.sync();
    assert.equal(second.todos, 0);
    assert.equal(second.meetings, 0);
    assert.equal(JSON.parse(await readFile(join(root, "todos.json"), "utf8")).items.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("投影：引擎侧消失的条目会从看板清理，手动条目不受影响", async () => {
  const root = await mkdtemp(join(tmpdir(), "tw-mail-"));
  try {
    await mkdir(join(root, "mail"), { recursive: true });
    const reduced = { version: 1, items: [STATE.items[2]] };
    await writeFile(join(root, "mail", "todo.json"), JSON.stringify(reduced), "utf8");
    const deps = fakeDeps(root);
    const mail = createMailModule(deps);
    await mail.sync();

    const manual = { id: "t1", title: "手输的待办", priority: "mid", category: "工作", due: "today", done: false };
    await writeFile(join(root, "todos.json"), JSON.stringify({ version: 1, items: [manual] }), "utf8");
    const result = await mail.sync();
    assert.equal(result.todos, 0);

    const todos = JSON.parse(await readFile(join(root, "todos.json"), "utf8"));
    assert.equal(todos.items.length, 1);
    assert.equal(todos.items[0].title, "手输的待办");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("参数校验：选项注入、编号格式、数字边界都被挡住", () => {
  assert.throws(() => safeValue("-rf", 10, "标题"), /不能以 - 开头/);
  assert.equal(safeValue("正常标题", 10, "标题"), "正常标题");
  assert.throws(() => safeId("a; rm -rf /"), /格式不正确/);
  assert.equal(safeId("00001"), "00001");
  assert.throws(() => safeFolder("-x"), /不能以 - 开头/);
  assert.equal(safeFolder("收件箱"), "收件箱");
  assert.equal(safeInt(999, 1, 90, 7), 90);
  assert.equal(safeInt("abc", 1, 90, 7), 7);
});

test("兼容旧版数据：mail_key/urgent/normal/中文 rsvp 会被归一，不产生重复条目", async () => {
  const root = await mkdtemp(join(tmpdir(), "tw-mail-"));
  try {
    await mkdir(join(root, "mail"), { recursive: true });
    await writeFile(join(root, "mail", "todo.json"), JSON.stringify(STATE), "utf8");
    // 旧版交付包写出来的看板数据
    await writeFile(
      join(root, "todos.json"),
      JSON.stringify({
        version: 1,
        items: [{ id: "t_old", title: "填报销单", priority: "urgent", category: "工作", due: "none", done: false, mail_key: "mail:todo:bbb", origin: "mail" }]
      }),
      "utf8"
    );
    await writeFile(
      join(root, "meetings.json"),
      JSON.stringify({
        version: 1,
        items: [{ id: "m_old", title: "产品评审", date: "2026-11-25", time: "15:00", duration: "15:00 - 15:30", rsvp_status: "待确认", mail_key: "mail:meeting:ccc", origin: "mail" }]
      }),
      "utf8"
    );
    const mail = createMailModule(fakeDeps(root));
    await mail.sync();

    const todos = JSON.parse(await readFile(join(root, "todos.json"), "utf8"));
    assert.equal(todos.items.length, 2, "旧条目被复用，不应再新增一条");
    const migrated = todos.items.find((x) => x.id === "t_old");
    assert.equal(migrated.mailKey, "mail:todo:bbb");
    assert.equal(migrated.priority, "mid");
    assert.equal(migrated.source.type, "mail");

    const meetings = JSON.parse(await readFile(join(root, "meetings.json"), "utf8"));
    assert.equal(meetings.items.length, 2);
    const migratedMeet = meetings.items.find((x) => x.id === "m_old");
    assert.equal(migratedMeet.mailKey, "mail:meeting:ccc");
    assert.equal(migratedMeet.rsvp, "pending");
    assert.equal(migratedMeet.startTime, "15:00");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
