#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWork 前端 v2 重构：批量替换（视觉 token、删除记账/移动端/本地解析）"""
import re, sys
from pathlib import Path

P = Path("/Users/guosy/Desktop/AI/TidyWork/方寸.html")
src = P.read_text(encoding="utf-8")
orig_len = len(src)
applied = []

def sub(old, new, count=1, label=""):
    global src
    n = src.count(old)
    if n != count:
        print(f"[WARN] {label}: expect {count} got {n}")
        return
    src = src.replace(old, new)
    applied.append(label)

# ---- 1. favicon：蓝紫渐变 -> 朱砂单色白线三横 ----
sub(
 '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 64 64\'%3E%3Cdefs%3E%3ClinearGradient id=\'g\' x1=\'0\' y1=\'0\' x2=\'1\' y2=\'1\'%3E%3Cstop offset=\'0\' stop-color=\'%234D6BFF\'/%3E%3Cstop offset=\'1\' stop-color=\'%232F4BD8\'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width=\'64\' height=\'64\' rx=\'16\' fill=\'url(%23g)\'/%3E%3Cpath d=\'M19 24h26M19 40h26\' stroke=\'%23fff\' stroke-width=\'5\' stroke-linecap=\'round\'/%3E%3Ccircle cx=\'32\' cy=\'32\' r=\'4\' fill=\'%23fff\'/%3E%3C/svg%3E">',
 '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 64 64\'%3E%3Crect width=\'64\' height=\'64\' rx=\'14\' fill=\'%23B84A2E\'/%3E%3Cpath d=\'M20 24h24M20 40h24\' stroke=\'%23fff\' stroke-width=\'5\' stroke-linecap=\'round\'/%3E%3C/svg%3E">',
 label="favicon")

# ---- 2. :root -> 纸墨 token（保留变量名，整体换值） ----
sub(
 """:root{
  --primary:#3b5bfd; --primary-soft:#eef1ff; --primary-hover:#2f4bd8;
  --bg:#f5f6f8; --card:#ffffff; --aside:#ffffff;
  --text:#1f2329; --text-sub:#646a73; --text-faint:#9aa0a8;
  --border:#ebedf0; --hover:#f4f5f7;
  --success:#67c23a; --success-soft:#f0f9eb; --warning:#e6a23c; --danger:#f56c6c;
  --radius:14px;
  --shadow:0 1px 2px rgba(31,35,41,.04), 0 4px 16px rgba(31,35,41,.04);
  --radius-lg:20px;
}""",
 """:root{
  --primary:#B84A2E; --primary-soft:#F6E9E2; --primary-hover:#9E3C24;
  --bg:#F8F7F4; --card:#FFFFFF; --aside:#FFFFFF;
  --text:#1C1E1C; --text-sub:#6B6F66; --text-faint:#A4A79E;
  --border:#E8E4DC; --hover:#F0EDE6;
  --success:#3E7A63; --success-soft:#EAF3EE; --warning:#C08A2D; --danger:#C0392B;
  --radius:14px;
  --shadow:0 1px 2px rgba(28,30,28,.05), 0 4px 16px rgba(28,30,28,.05);
  --radius-lg:20px;
  --font-display:"Noto Serif SC","Songti SC","STSong",serif;
  --ease-out:cubic-bezier(0.22,1,0.36,1);
}""",
 label="root tokens")

# ---- 3. body 字体 ----
sub(
 'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;font-size:14px}',
 'body{font-family:"Manrope","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased;font-size:14px;overflow-x:clip}',
 label="body font")

# ---- 4. 品牌 logo 渐变 -> 朱砂 ----
sub('background:linear-gradient(135deg,#4D6BFF,#2F4BD8);display:flex', 'background:#B84A2E;display:flex', label="brand-logo")

# ---- 5. transition:all -> 白名单过渡 ----
before = src
src = re.sub(r"transition:all (\.\d+s)", r"transition:background \1 var(--ease-out),color \1 var(--ease-out),border-color \1 var(--ease-out),box-shadow \1 var(--ease-out)", src)
if src != before:
    applied.append("transition:all")
else:
    print("[WARN] transition:all no match")

# ---- 6. 删记账 CSS 段 ----
m_start = src.find("/* ===== 记账 ===== */")
m_end = src.find("/* ===== 笔记 ===== */")
if m_start >= 0 and m_end > m_start:
    src = src[:m_start] + src[m_end:]
    applied.append("expense css")
else:
    print("[WARN] expense css markers not found", m_start, m_end)

# ---- 7. 删移动端组件声明 + 媒体查询 ----
m_start = src.find("/* ===== 移动端组件(桌面隐藏) ===== */")
m_end = src.find("</style>")
if m_start >= 0 and m_end > m_start:
    src = src[:m_start] + src[m_end:]
    applied.append("mobile css")
else:
    print("[WARN] mobile css markers not found", m_start, m_end)

P.write_text(src, encoding="utf-8")
print(f"OK applied={applied}")
print(f"len {orig_len} -> {len(src)}")
