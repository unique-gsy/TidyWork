/** TidyWork 笔记 · Vditor ir 试点
 *  只做三件事：把同一份 Markdown 交给两种渲染并排看、把 Typora 的两个"手感开关"补上、把大纲对上。
 *  没有构建步骤，浏览器直接打开即可（需要通过 http 提供，file:// 拉不到 lute）。 */
import { mdToHtml, MD_CSS } from "./legacy-md.js";

const DOCS = [
  { id: "quarter-review", title: "Q4 季度复盘与下季度规划", file: "./samples/quarter-review.md" },
  { id: "review-minutes", title: "需求评审纪要", file: "./samples/review-minutes.md" },
  { id: "editor-choice", title: "笔记编辑器选型：Vditor 试点", file: "./samples/editor-choice.md" },
  { id: "features", title: "画廊 · 公式 · Callout 验收", file: "./samples/features.md" },
];

const qs = new URLSearchParams(location.search);
const darkMode = qs.get("theme") === "dark";
const $ = (id) => document.getElementById(id);
const shell = document.querySelector(".tw-shell");
const store = {
  get: (k) => { try { return localStorage.getItem("tw-note-demo:v7:" + k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem("tw-note-demo:v7:" + k, v); } catch (e) {} },
};

let current = null;
let vditor = null;
let focusOn = false;
let typeOn = false;
let saveTimer = null;

/* ---------- 渲染层增强：表格公式 / 画廊 / 灯箱（与插件 client.js 同一套口径） ---------- */
function twColToIndex(letters) {
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
function twParseCell(ref) {
  const m = String(ref).toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { c: twColToIndex(m[1]), r: Number(m[2]) - 1 };
}
function twNum(v) {
  if (v == null) return NaN;
  const s = String(v).replace(/[,，%\s]/g, "");
  if (s === "") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
function twFormatNum(n) {
  if (!Number.isFinite(n)) return "—";
  return String(Math.round(n * 1e6) / 1e6);
}
function twEvalFormula(grid, formula) {
  const src = String(formula || "").trim().replace(/^=/, "");
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const n = Number(src.slice(i, j));
      if (!Number.isFinite(n)) throw new Error("数字有误");
      tokens.push({ t: "num", v: n }); i = j; continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z]/.test(src[j])) j += 1;
      const word = src.slice(i, j).toUpperCase();
      const rest = src.slice(j);
      const cellM = rest.match(/^\s*(\d+)/);
      if (/^[A-Z]+$/.test(word) && cellM) {
        let k = j + cellM[0].length;
        const ref = word + cellM[1];
        const rangeM = src.slice(k).match(/^\s*:\s*([A-Z]+)(\d+)/);
        if (rangeM) { tokens.push({ t: "range", a: twParseCell(ref), b: twParseCell(rangeM[1] + rangeM[2]) }); k += rangeM[0].length; }
        else tokens.push({ t: "cell", v: twParseCell(ref) });
        i = k; continue;
      }
      tokens.push({ t: "func", v: word }); i = j; continue;
    }
    if ("+-*/(),".includes(ch)) { tokens.push({ t: ch }); i += 1; continue; }
    throw new Error("无法识别的字符");
  }
  let p = 0;
  const peek = () => tokens[p];
  const cellValue = (ref) => { if (!ref) return NaN; const row = grid[ref.r]; return twNum(row ? row[ref.c] : undefined); };
  const rangeList = (a, b) => {
    if (!a || !b) return [];
    const out = [];
    const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r), c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
    for (let r = r1; r <= r2; r += 1) for (let c = c1; c <= c2; c += 1) { const row = grid[r]; out.push(row ? row[c] : undefined); }
    return out;
  };
  function parsePrimary() {
    const tk = tokens[p];
    if (!tk) throw new Error("公式不完整");
    if (tk.t === "num") { p += 1; return tk.v; }
    if (tk.t === "cell") { p += 1; return cellValue(tk.v); }
    if (tk.t === "range") { p += 1; return rangeList(tk.a, tk.b).map((x) => twNum(x)); }
    if (tk.t === "func") {
      p += 1;
      if (peek() && peek().t === "(") p += 1; else throw new Error("函数缺少括号");
      const args = [];
      if (!(peek() && peek().t === ")")) { while (true) { args.push(parseExpr()); if (peek() && peek().t === ",") { p += 1; continue; } break; } }
      if (peek() && peek().t === ")") p += 1;
      const flat = [];
      args.forEach((a) => (Array.isArray(a) ? flat.push(...a) : flat.push(a)));
      if (tk.v === "COUNT") return flat.filter((x) => String(x == null ? "" : x).trim() !== "").length;
      const nums = flat.map(twNum).filter((n) => !Number.isNaN(n));
      switch (tk.v) {
        case "SUM": return nums.reduce((s, n) => s + n, 0);
        case "AVG": return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : NaN;
        case "MAX": return nums.length ? Math.max(...nums) : NaN;
        case "MIN": return nums.length ? Math.min(...nums) : NaN;
        default: throw new Error("不支持的函数 " + tk.v);
      }
    }
    if (tk.t === "(") { p += 1; const v = parseExpr(); if (peek() && peek().t === ")") p += 1; return v; }
    throw new Error("公式有误");
  }
  function parseUnary() { if (peek() && peek().t === "-") { p += 1; return -parseUnary(); } if (peek() && peek().t === "+") { p += 1; return parseUnary(); } return parsePrimary(); }
  function parseMulDiv() { let l = parseUnary(); while (peek() && (peek().t === "*" || peek().t === "/")) { const op = peek().t; p += 1; const r = parseUnary(); l = op === "*" ? l * r : l / r; } return l; }
  function parseAddSub() { let l = parseMulDiv(); while (peek() && (peek().t === "+" || peek().t === "-")) { const op = peek().t; p += 1; const r = parseMulDiv(); l = op === "+" ? l + r : l - r; } return l; }
  function parseExpr() { return parseAddSub(); }
  const result = parseExpr();
  if (p < tokens.length) throw new Error("公式有多余内容");
  if (typeof result !== "number" || Number.isNaN(result)) throw new Error("结果无数值");
  return result;
}
function twCellText(td) {
  return (td.innerText || td.textContent || "").trim();
}
function twEnhanceTables(root) {
  root.querySelectorAll("table").forEach((table) => {
    const trs = Array.from(table.querySelectorAll("tr"));
    const raw = trs.map((tr) => Array.from(tr.querySelectorAll("th,td")).map((td) => twCellText(td)));
    const res = trs.map(() => []);
    // 第一遍：逐格求值并缓存结果；被引用的公式格优先用已算出的数值，支持链式合计
    trs.forEach((tr, r) => {
      Array.from(tr.querySelectorAll("th,td")).forEach((td, c) => {
        const text = raw[r][c];
        if (!/^=/.test(text)) { res[r][c] = null; return; }
        const grid = raw.map((row, rr) => row.map((cell, cc) => (typeof res[rr][cc] === "number" && !Number.isNaN(res[rr][cc]) ? String(res[rr][cc]) : cell)));
        try { res[r][c] = twEvalFormula(grid, text); } catch (e) { res[r][c] = NaN; }
      });
    });
    // 第二遍：结果写进 data-fx 属性，由 CSS 伪元素渲染；不插入子节点，避免被回读进源码
    trs.forEach((tr, r) => {
      Array.from(tr.querySelectorAll("th,td")).forEach((td, c) => {
        if (!/^=/.test(raw[r][c])) { delete td.dataset.fx; return; }
        const v = res[r][c];
        td.dataset.fx = typeof v === "number" && !Number.isNaN(v) ? twFormatNum(v) : "公式有误";
        td.title = raw[r][c];
      });
    });
  });
}
function twGroupGallery(root) {
  Array.from(root.querySelectorAll(":scope > .tw-gallery")).forEach((g) => {
    const frag = document.createDocumentFragment();
    while (g.firstChild) frag.appendChild(g.firstChild);
    g.replaceWith(frag);
  });
  const groups = []; let cur = [];
  Array.from(root.children).forEach((node) => {
    const isImgP = node.tagName === "P" && node.querySelector("img");
    if (isImgP) cur.push(node); else { if (cur.length) groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  groups.forEach((group) => {
    if (group.length < 2) return;
    const wrap = document.createElement("div");
    wrap.className = "tw-gallery"; wrap.dataset.count = String(group.length);
    group[0].before(wrap); group.forEach((p) => wrap.appendChild(p));
  });
}
const twLightbox = (() => {
  let box = null, imgEl = null, countEl = null, imgs = [], idx = 0, scale = 1, tx = 0, ty = 0;
  let dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;
  function build() {
    if (box) return;
    box = document.createElement("div"); box.className = "tw-lb";
    box.innerHTML = '<img alt="" draggable="false" /><button type="button" class="tw-lb-btn tw-lb-close" aria-label="关闭">✕</button><button type="button" class="tw-lb-btn tw-lb-prev" aria-label="上一张">‹</button><button type="button" class="tw-lb-btn tw-lb-next" aria-label="下一张">›</button><div class="tw-lb-count"></div>';
    imgEl = box.querySelector("img"); countEl = box.querySelector(".tw-lb-count");
    document.body.appendChild(box);
    box.querySelector(".tw-lb-close").addEventListener("click", close);
    box.querySelector(".tw-lb-prev").addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
    box.querySelector(".tw-lb-next").addEventListener("click", (e) => { e.stopPropagation(); step(1); });
    box.addEventListener("click", (e) => { if (e.target === box) close(); });
    imgEl.addEventListener("wheel", (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
    imgEl.addEventListener("dblclick", reset);
    imgEl.addEventListener("mousedown", (e) => { dragging = true; startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty; imgEl.classList.add("dragging"); });
    document.addEventListener("mousemove", (e) => { if (!dragging) return; tx = startTx + e.clientX - startX; ty = startTy + e.clientY - startY; apply(); });
    document.addEventListener("mouseup", () => { dragging = false; imgEl.classList.remove("dragging"); });
    document.addEventListener("keydown", (e) => { if (!box || box.style.display === "none") return; if (e.key === "Escape") close(); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1); });
  }
  function apply() { imgEl.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")"; }
  function reset() { scale = 1; tx = 0; ty = 0; apply(); }
  function zoom(f) { scale = Math.min(4, Math.max(0.5, scale * f)); if (scale === 1) { tx = 0; ty = 0; } apply(); }
  function step(d) { if (!imgs.length) return; idx = (idx + d + imgs.length) % imgs.length; render(); }
  function render() { imgEl.src = imgs[idx].getAttribute("src"); imgEl.alt = imgs[idx].getAttribute("alt") || ""; countEl.textContent = (idx + 1) + " / " + imgs.length; reset(); }
  function open(list, i) { build(); imgs = list; idx = i; box.style.display = "flex"; render(); }
  function close() { if (box) box.style.display = "none"; imgs = []; }
  function bind(root) { root.addEventListener("click", (e) => { const img = e.target.closest && e.target.closest("img"); if (!img) return; const list = Array.from(root.querySelectorAll("img")); const i = list.indexOf(img); if (i >= 0) open(list, i); }); }
  return { bind };
})();
let enhanceTimer = null;
function twEnhanceNote(root) {
  const rerun = () => { twGroupGallery(root); twEnhanceTables(root); };
  rerun();
  const mo = new MutationObserver(() => { clearTimeout(enhanceTimer); enhanceTimer = setTimeout(rerun, 120); });
  mo.observe(root, { childList: true, subtree: true });
  twLightbox.bind(root);
  return () => mo.disconnect();
}

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
    try { md = await (await fetch(doc.file + "?v=7")).text(); } catch (e) { md = "# 加载失败\n\n" + doc.file; }
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
      after: () => {
        setStatus("编辑器就绪"); markFocus();
        document.__twVditor = vditor;
        const root = document.querySelector(".vditor-ir > .vditor-reset");
        if (root) twEnhanceNote(root);
      },
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
$("btnPdf").addEventListener("click", () => {
  const root = document.querySelector(".vditor-ir > .vditor-reset");
  if (!root) { setStatus("编辑器尚未就绪"); return; }
  const clone = root.cloneNode(true);
  clone.querySelectorAll(".vditor-ir__marker").forEach((m) => m.remove());
  clone.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    if (!src) return;
    try { img.setAttribute("src", new URL(src, location.href).href); } catch (e) {}
  });
  const win = window.open("", "_blank");
  if (!win) { setStatus("浏览器拦截了弹出窗口"); return; }
  const title = escapeHtml($("docTitle").textContent || "未命名笔记");
  const css = [
    "body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#15181e;max-width:820px;margin:0 auto;padding:32px;line-height:1.8}",
    "h1{font-size:24px;margin:0 0 18px}h2{font-size:20px;margin:20px 0 10px}",
    "img{max-width:100%;border-radius:8px}.tw-gallery{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:12px 0;width:100%}.tw-gallery p{margin:0}",
    "table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}th,td{border:1px solid #d5d8de;padding:6px 10px}",
    "td[data-fx]::after,th[data-fx]::after{content:attr(data-fx);color:#2f5bff;margin-left:6px;font-size:12px}",
    "blockquote.callout{border-left:3px solid #2f5bff;padding:8px 14px;border-radius:8px;background:#f6f8ff;margin:12px 0}",
    "@media print{body{padding:0;max-width:none}}"
  ].join("");
  win.document.write("<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'/><title>" + title + "</title><style>" + css + "</style></head><body><h1>" + title + "</h1>" + clone.outerHTML + "</body></html>");
  win.document.close();
  win.focus();
  setTimeout(() => { try { win.print(); } catch (e) {} }, 300);
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
