/** TidyWork 笔记 · Vditor ir 试点
 *  只做三件事：把同一份 Markdown 交给两种渲染并排看、把 Typora 的两个"手感开关"补上、把大纲对上。
 *  没有构建步骤，浏览器直接打开即可（需要通过 http 提供，file:// 拉不到 lute）。 */
import { mdToHtml, MD_CSS } from "./legacy-md.js";

const DOCS = [
  { id: "quarter-review", title: "Q4 季度复盘与下季度规划", file: "./samples/quarter-review.md" },
  { id: "review-minutes", title: "需求评审纪要", file: "./samples/review-minutes.md" },
  { id: "editor-choice", title: "笔记编辑器选型：Vditor 试点", file: "./samples/editor-choice.md" },
];

const qs = new URLSearchParams(location.search);
const darkMode = qs.get("theme") === "dark";
const $ = (id) => document.getElementById(id);
const shell = document.querySelector(".tw-shell");
const store = {
  get: (k) => { try { return localStorage.getItem("tw-note-demo:" + k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem("tw-note-demo:" + k, v); } catch (e) {} },
};

let current = null;
let vditor = null;
let focusOn = false;
let typeOn = false;
let saveTimer = null;

/* ---------- 现状渲染 ---------- */
const mdCssOnce = () => {
  if (document.getElementById("tidywork-md-css")) return;
  const st = document.createElement("style");
  st.id = "tidywork-md-css";
  st.textContent = MD_CSS;
  document.head.appendChild(st);
};

/* ---------- 大纲 ---------- */
function parseOutline(md) {
  const lines = String(md || "").split("\n");
  const heads = [];
  let inFence = false;
  lines.forEach((l) => {
    if (/^ {0,3}(?:```|~~~)/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const m = l.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (m) heads.push({ level: m[1].length, text: m[2].replace(/\s+#+\s*$/, "").replace(/[*_`~]/g, "").trim() });
  });
  return heads;
}

function renderOutline(md) {
  const list = $("outlineList");
  list.innerHTML = "";
  parseOutline(md).forEach((h, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tw-out tw-out--h" + Math.min(h.level, 3);
    b.textContent = h.text || "（无标题）";
    b.addEventListener("click", () => scrollToHeading(idx));
    list.appendChild(b);
  });
}

function scrollToHeading(idx) {
  const root = document.querySelector(".vditor-reset");
  if (!root) return;
  const nodes = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const target = nodes[idx];
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
}

/* ---------- 专注模式：只亮光标所在的那一块 ---------- */
function markFocus() {
  const root = document.querySelector(".vditor-ir > .vditor-reset");
  if (!root) return;
  if (!focusOn) {
    [...root.children].forEach((el) => el.classList.remove("tw-active"));
    return;
  }
  let active = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount && sel.anchorNode && root.contains(sel.anchorNode)) {
    let node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    while (node && node.parentElement !== root) node = node.parentElement;
    active = node && node.parentElement === root ? node : null;
  }
  if (!active) {
    // 没有光标时退化成"视口中线所在的那一块"，避免整页都变灰
    const box = root.getBoundingClientRect();
    const mid = box.top + Math.min(box.height, 420) * 0.45;
    let best = null;
    let bestDist = Infinity;
    [...root.children].forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top - mid);
      if (d < bestDist) { bestDist = d; best = el; }
    });
    active = best;
  }
  [...root.children].forEach((el) => el.classList.toggle("tw-active", el === active));
}

document.addEventListener("selectionchange", markFocus);

function setStatus(text) { $("status").textContent = text; }

function flushSave() {
  if (!current || !vditor) return;
  store.set(current.id, vditor.getValue());
  const d = new Date();
  setStatus("已保存 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"));
}

function scheduleSave() {
  setStatus("未保存");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 900);
}

/* ---------- 打字机模式 ---------- */
function typewriter() {
  if (!typeOn) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  if (!r || !r.height) return;
  const c = document.querySelector(".vditor-content");
  if (!c) return;
  const box = c.getBoundingClientRect();
  const target = box.top + box.height * 0.42;
  const delta = r.top - target;
  if (Math.abs(delta) > 22) c.scrollTop += delta;
}

/* ---------- 载入文档 ---------- */
async function openDoc(doc) {
  if (current && vditor) flushSave();
  current = doc;
  [...document.querySelectorAll(".tw-doc")].forEach((b) => b.classList.toggle("tw-doc--on", b.dataset.id === doc.id));
  $("docTitle").textContent = doc.title;

  const saved = store.get(doc.id);
  let md = saved;
  if (md == null) {
    try { md = await (await fetch(doc.file)).text(); } catch (e) { md = "# 加载失败\n\n" + doc.file; }
  }
  await applyDoc(md);
  setStatus(saved == null ? "来自样例文件" : "已恢复本地草稿");
}

async function applyDoc(md) {
  const legacy = $("legacyBody");
  mdCssOnce();
  legacy.innerHTML = mdToHtml(md, false);
  renderOutline(md);
  if (!vditor) {
    vditor = new Vditor("editor", {
      cdn: "./vendor/vditor",
      mode: "ir",
      value: md,
      height: "100%",
      theme: darkMode ? "dark" : "classic",
      icon: "ant",
      toolbar: [],
      counter: { enable: false },
      cache: { enable: false },
      resize: { enable: false },
      outline: { enable: false },
      tab: "\t",
      placeholder: "开始写…",
      preview: {
        delay: 120,
        theme: { current: darkMode ? "dark" : "light", path: "./vendor/vditor/dist/css/content-theme" },
        hljs: { style: darkMode ? "atom-one-dark" : "github", lineNumber: false },
        markdown: { sanitize: true, toc: false },
      },
      input: () => { scheduleSave(); syncLegacy(); renderOutline(vditor ? vditor.getValue() : ""); },
      after: () => { setStatus("编辑器就绪"); markFocus(); },
    });
    return;
  }
  vditor.setValue(md, true);
}

function syncLegacy() {
  if ($("legacyPane").hidden || !vditor) return;
  $("legacyBody").innerHTML = mdToHtml(vditor.getValue(), false);
}

/* ---------- 开关 ---------- */
$("btnCompare").addEventListener("click", (e) => {
  const on = $("legacyPane").hidden;
  $("legacyPane").hidden = !on;
  $("editorLabel").hidden = !on;
  e.currentTarget.setAttribute("aria-pressed", on ? "true" : "false");
  if (on) syncLegacy();
});

$("btnFocus").addEventListener("click", (e) => {
  focusOn = !focusOn;
  shell.classList.toggle("tw-focus-on", focusOn);
  e.currentTarget.setAttribute("aria-pressed", focusOn ? "true" : "false");
  markFocus();
});

$("btnType").addEventListener("click", (e) => {
  typeOn = !typeOn;
  e.currentTarget.setAttribute("aria-pressed", typeOn ? "true" : "false");
  if (typeOn) typewriter();
});

["keyup", "click", "input"].forEach((ev) => document.addEventListener(ev, typewriter, true));

/* ---------- 列表 ---------- */
DOCS.forEach((doc) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "tw-doc";
  b.dataset.id = doc.id;
  b.innerHTML = '<div class="tw-doc-title"></div><div class="tw-doc-preview"></div>';
  b.querySelector(".tw-doc-title").textContent = doc.title;
  b.querySelector(".tw-doc-preview").textContent = "本地样例 · Markdown";
  b.addEventListener("click", () => openDoc(doc));
  $("docList").appendChild(b);
});

/* 截图 / 演示用：?compare=1&focus=1&doc=editor-choice&theme=dark */
const first = (qs.get("doc") && DOCS.find((d) => d.id === qs.get("doc"))) || DOCS[0];

if (darkMode) document.body.setAttribute("data-theme", "dark");
openDoc(first).then(() => {
  if (qs.get("paper") === "1" && !darkMode) document.body.style.background = "#f7f8fa";
  if (qs.get("compare") === "1") $("btnCompare").click();
  if (qs.get("focus") === "1") $("btnFocus").click();
  if (qs.get("scroll")) {
    setTimeout(() => {
      const n = Number(qs.get("scroll")) || 0;
      [".vditor-content", ".vditor", ".vditor-ir > .vditor-reset"].forEach((s) => {
        const el = document.querySelector(s);
        if (el && el.scrollHeight > el.clientHeight + 4) el.scrollTop = n;
      });
    }, 1200);
  }
});

window.addEventListener("beforeunload", flushSave);
