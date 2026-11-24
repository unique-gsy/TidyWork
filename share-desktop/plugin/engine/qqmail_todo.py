#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - C 阶段待办抽取引擎（纯函数，离线可测）。

只做确定性提取，不做自然语言改写：
- 中文日期/时间/相对时间/期限解析
- 截止时间的锚点识别（截止/前/最晚/请于…）
- 反馈对象（邮箱 / 姓名）抽取
- 邮件归类为「待反馈」「会议」两类，并给出置信度与依据

上层（qqmail_agenda.py）负责把这里的结果拼成待办清单条目；
对话层的“事件是什么”一句话总结由大模型基于 excerpt 完成。
"""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta
from typing import Any, Optional

import qqmail_common as common


# ---------------------------------------------------------------------------
# 中文数字 / 基础工具
# ---------------------------------------------------------------------------

_CN_DIGIT = {
    "零": 0, "〇": 0, "一": 1, "壹": 1, "二": 2, "两": 2, "贰": 2, "三": 3, "叁": 3,
    "四": 4, "肆": 4, "五": 5, "伍": 5, "六": 6, "陆": 6, "七": 7, "柒": 7,
    "八": 8, "捌": 8, "九": 9, "玖": 9,
}

_CN_NUM_CHARS = "零〇一壹二两贰三叁四肆五伍六陆七柒八捌九玖十"


def cn_to_int(text: str) -> Optional[int]:
    """把「三」「十二」「二十三」「两」转成整数；纯阿拉伯数字直接转。"""
    raw = (text or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return int(raw)
    if "十" in raw:
        left, _, right = raw.partition("十")
        tens = 1 if not left else _CN_DIGIT.get(left)
        ones = 0 if not right else _CN_DIGIT.get(right)
        if tens is None or ones is None:
            return None
        return tens * 10 + ones
    if len(raw) == 1:
        return _CN_DIGIT.get(raw)
    return None


_WEEKDAY_CN = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
_WEEKDAY_CN_NUM = {"1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5, "7": 6}


def _week_start(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _month_last_day(year: int, month: int) -> date:
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - timedelta(days=1)


def _safe_date(year: int, month: int, day: int, ref: date) -> Optional[date]:
    """构造日期；月份/日期越界时返回 None（不猜）。"""
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _add_workdays(base: date, count: int) -> date:
    cur = base
    added = 0
    while added < max(count, 0):
        cur = cur + timedelta(days=1)
        if cur.weekday() < 5:
            added += 1
    return cur


# ---------------------------------------------------------------------------
# 候选结构
# ---------------------------------------------------------------------------

def _cand(raw: str, start: int, end: int, *, date_value: Optional[date] = None,
          has_time: bool = False, hour: int = -1, minute: int = 0,
          kind: str = "", confidence: float = 0.8, note: str = "") -> dict[str, Any]:
    return {
        "raw": raw, "start": start, "end": end,
        "date": date_value.isoformat() if date_value else "",
        "time": (f"{hour:02d}:{minute:02d}" if has_time and hour >= 0 else ""),
        "hour": hour, "minute": minute,
        "has_time": bool(has_time and hour >= 0),
        "kind": kind, "confidence": confidence, "note": note,
    }


# ---------------------------------------------------------------------------
# 日期抽取
# ---------------------------------------------------------------------------

_RE_YMD = re.compile(r"(20\d{2})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?")
_RE_YMD_SLASH = re.compile(r"(20\d{2})/(\d{1,2})/(\d{1,2})")
_RE_MD = re.compile(r"(?<![\d.])(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]")
_RE_MD_SLASH = re.compile(r"(?<![\d/])(\d{1,2})\s*[/]\s*(\d{1,2})(?![\d/])")
_RE_RELATIVE = re.compile(r"(今天|今日|本日|明天|明日|明早|明晚|后天|大后天|昨天|前天)")
_RE_WEEKDAY = re.compile(r"(本|这|下|上)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天1-7])")
_RE_NEXT_WEEK = re.compile(r"(下下)\s*(?:周|星期|礼拜)|(下周|下星期|下个星期)(?![一二三四五六日天1-7])")
_RE_WEEK_ANY = re.compile(r"(本|这)\s*(?:周|星期)(?![一二三四五六日天])")
_RE_MONTH_EDGE = re.compile(r"(本|这个|下个|下)?\s*月\s*(初|底|末|中)")
_RE_MONTH_DAY = re.compile(r"(下个?|本)?\s*月\s*(\d{1,2})\s*[日号]")


def find_date_candidates(text: str, ref: Optional[datetime] = None) -> list[dict[str, Any]]:
    """从文本中找出所有日期候选（含相对日期），返回按位置排序的列表。"""
    ref_dt = ref or common.local_now()
    today = ref_dt.date()
    out: list[dict[str, Any]] = []

    for m in _RE_YMD.finditer(text):
        d = _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)), today)
        if d:
            out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                             kind="absolute", confidence=0.98))

    for m in _RE_MD.finditer(text):
        month, day = int(m.group(1)), int(m.group(2))
        year = today.year
        d = _safe_date(year, month, day, today)
        if d is None:
            continue
        # 无年份且已过去超过 60 天：按明年解释（跨年通知）
        if d < today - timedelta(days=60):
            d = _safe_date(year + 1, month, day, today) or d
        out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                         kind="month_day", confidence=0.93))

    for m in _RE_MD_SLASH.finditer(text):
        month, day = int(m.group(1)), int(m.group(2))
        if not (1 <= month <= 12 and 1 <= day <= 31):
            continue
        year = today.year
        d = _safe_date(year, month, day, today)
        if d is None:
            continue
        if d < today - timedelta(days=60):
            d = _safe_date(year + 1, month, day, today) or d
        out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                         kind="month_day_slash", confidence=0.72))

    for m in _RE_RELATIVE.finditer(text):
        word = m.group(1).replace("明早", "明天").replace("明晚", "明天")
        offset = {"今天": 0, "今日": 0, "本日": 0, "明天": 1, "明日": 1,
                  "后天": 2, "大后天": 3, "昨天": -1, "前天": -2}[word]
        out.append(_cand(m.group(0), m.start(), m.end(),
                         date_value=today + timedelta(days=offset),
                         kind="relative", confidence=0.95))

    for m in _RE_WEEKDAY.finditer(text):
        prefix = m.group(1) or ""
        token = m.group(2)
        idx = _WEEKDAY_CN.get(token)
        if idx is None:
            idx = _WEEKDAY_CN_NUM.get(token)
        if idx is None:
            continue
        shift = {"本": 0, "这": 0, "": 0, "下": 1, "上": -1}.get(prefix, 0)
        d = _week_start(today) + timedelta(days=idx + 7 * shift)
        confidence = 0.9 if prefix else 0.82
        note = "" if prefix else "未写本周/下周，按最近一次解释"
        if not prefix and d < today:
            d = d + timedelta(days=7)
        out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                         kind="weekday", confidence=confidence, note=note))

    for m in _RE_NEXT_WEEK.finditer(text):
        weeks = 2 if m.group(1) else 1
        out.append(_cand(m.group(0), m.start(), m.end(),
                         date_value=_week_start(today) + timedelta(days=7 * weeks),
                         kind="next_week", confidence=0.75,
                         note="只写了「下周」没有星期几"))

    for m in _RE_WEEK_ANY.finditer(text):
        out.append(_cand(m.group(0), m.start(), m.end(),
                         date_value=_week_start(today) + timedelta(days=6),
                         kind="this_week", confidence=0.8,
                         note="按本周最后一天（周日）解释"))

    for m in _RE_MONTH_EDGE.finditer(text):
        prefix, edge = m.group(1) or "", m.group(2)
        year, month = today.year, today.month
        if prefix == "下" or prefix == "下个":
            month += 1
            if month > 12:
                month, year = 1, year + 1
        if edge == "初":
            d = date(year, month, 1)
        elif edge == "中":
            d = date(year, month, 15)
        else:
            d = _month_last_day(year, month)
        out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                         kind="month_edge", confidence=0.7))

    for m in _RE_MONTH_DAY.finditer(text):
        day = int(m.group(2))
        prefix = m.group(1) or ""
        year, month = today.year, today.month
        if prefix in ("下", "下个"):
            month += 1
            if month > 12:
                month, year = 1, year + 1
        d = _safe_date(year, month, day, today)
        if d:
            out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                             kind="month_day", confidence=0.8))

    out.sort(key=lambda c: (c["start"], -c["confidence"]))
    # 同位置去重：保留置信度最高的一个
    deduped: list[dict[str, Any]] = []
    for c in out:
        if deduped and c["start"] < deduped[-1]["end"]:
            if c["confidence"] > deduped[-1]["confidence"]:
                deduped[-1] = c
            continue
        deduped.append(c)
    return deduped


# ---------------------------------------------------------------------------
# 时间抽取
# ---------------------------------------------------------------------------

_PERIOD_WORDS = {
    "凌晨": "am", "早上": "am", "早晨": "am", "上午": "am", "清晨": "am",
    "中午": "noon", "下午": "pm", "傍晚": "pm", "晚上": "pm", "晚间": "pm", "夜里": "pm",
}
_RE_PERIOD = re.compile(r"(凌晨|早上|早晨|上午|清晨|中午|下午|傍晚|晚上|晚间|夜里)")
_RE_COLON_TIME = re.compile(r"(\d{1,2})\s*[:：]\s*(\d{2})(?!\s*\d)")
_RE_CN_TIME = re.compile(
    r"(\d{1,2}|[一二两三四五六七八九十]+)\s*[点时]"
    r"(?:\s*(半|\d{1,2}\s*分|\d{1,2}))?"
)


def _apply_period(hour: int, period: str) -> tuple[int, bool]:
    """按上午/下午等词修正 12 小时制；返回 (小时, 是否明确)。"""
    mode = _PERIOD_WORDS.get(period, "")
    if mode == "pm":
        if hour < 12:
            return hour + 12, True
        return hour, True
    if mode == "am":
        if hour == 12:
            return 0, True
        return hour, True
    if mode == "noon":
        return 12, True
    return hour, False


def find_time_candidates(text: str) -> list[dict[str, Any]]:
    """抽取时间点（19:00 / 晚上7点半 / 下午3点）。"""
    out: list[dict[str, Any]] = []

    for m in _RE_COLON_TIME.finditer(text):
        hour, minute = int(m.group(1)), int(m.group(2))
        if hour > 23 or minute > 59:
            continue
        period = ""
        prefix = text[max(0, m.start() - 6):m.start()]
        pm = _RE_PERIOD.search(prefix)
        if pm:
            period = pm.group(1)
            start = max(0, m.start() - 6) + pm.start()
        else:
            start = m.start()
        hour2, explicit = _apply_period(hour, period)
        out.append(_cand(text[start:m.end()], start, m.end(),
                         has_time=True, hour=hour2, minute=minute,
                         kind="clock", confidence=0.95 if explicit else 0.9,
                         note="" if explicit else "24 小时制或未标上午下午"))

    for m in _RE_CN_TIME.finditer(text):
        hour = cn_to_int(m.group(1))
        if hour is None or hour > 24:
            continue
        tail = (m.group(2) or "").strip()
        if tail == "半":
            minute = 30
        elif tail.endswith("分"):
            minute = int(tail.replace("分", "").strip()) if tail.replace("分", "").strip().isdigit() else 0
        elif tail.isdigit():
            minute = int(tail)
        else:
            minute = 0
        if minute > 59:
            continue
        period_m = _RE_PERIOD.search(text[max(0, m.start() - 6):m.start()])
        period = period_m.group(1) if period_m else ""
        start = m.start()
        if period_m:
            start = max(0, m.start() - 6) + period_m.start()
        hour2, explicit = _apply_period(hour, period)
        out.append(_cand(text[start:m.end()], start, m.end(),
                         has_time=True, hour=hour2, minute=minute,
                         kind="cn_clock", confidence=0.92 if explicit else 0.7,
                         note="" if explicit else "未标上午下午，小时可能有歧义"))

    out.sort(key=lambda c: c["start"])
    deduped: list[dict[str, Any]] = []
    for c in out:
        if deduped and c["start"] < deduped[-1]["end"]:
            if c["confidence"] > deduped[-1]["confidence"]:
                deduped[-1] = c
            continue
        deduped.append(c)
    return deduped


_RE_DURATION = re.compile(
    r"(?P<n>\d{1,3}|[一二两三四五六七八九十]+)\s*"
    r"(?P<unit>个?\s*工作日|个?\s*自然日|天|日|周|个?\s*星期|个?\s*礼拜)"
    r"(?P<suffix>之内|以内|内|内完成|内反馈|内提交|前)?"
)


def find_duration_candidates(text: str, ref: Optional[datetime] = None) -> list[dict[str, Any]]:
    """「3 天内」「5 个工作日内」「一周内」→ 推算截止日期。"""
    ref_dt = ref or common.local_now()
    today = ref_dt.date()
    out: list[dict[str, Any]] = []
    for m in _RE_DURATION.finditer(text):
        n = cn_to_int(m.group("n"))
        if n is None or n <= 0 or n > 365:
            continue
        unit = m.group("unit").replace(" ", "")
        if "工作日" in unit:
            d = _add_workdays(today, n)
            note = f"{n} 个工作日"
        elif "周" in unit or "星期" in unit or "礼拜" in unit:
            d = today + timedelta(days=7 * n)
            note = f"{n} 周"
        else:
            d = today + timedelta(days=n)
            note = f"{n} 天"
        out.append(_cand(m.group(0), m.start(), m.end(), date_value=d,
                         kind="duration", confidence=0.85, note=note))
    return out


# ---------------------------------------------------------------------------
# 日期 + 时间合并
# ---------------------------------------------------------------------------

def extract_datetimes(text: str, ref: Optional[datetime] = None) -> list[dict[str, Any]]:
    """把日期与时间合并成「已解析的时刻」列表。"""
    dates = find_date_candidates(text, ref) + find_duration_candidates(text, ref)
    dates.sort(key=lambda c: c["start"])
    times = find_time_candidates(text)
    merged: list[dict[str, Any]] = []
    used_times: set[int] = set()

    for d in dates:
        best: Optional[dict[str, Any]] = None
        for i, t in enumerate(times):
            if i in used_times:
                continue
            gap_after = t["start"] - d["end"]
            gap_before = d["start"] - t["end"]
            if -2 <= gap_after <= 12 or -2 <= gap_before <= 8:
                best = t
                break
        item = dict(d)
        if best is not None:
            used_times.add(times.index(best))
            item["has_time"] = True
            item["time"] = best["time"]
            item["hour"] = best["hour"]
            item["minute"] = best["minute"]
            item["confidence"] = min(d["confidence"], best["confidence"])
            item["span"] = (d["start"], max(d["end"], best["end"]))
        merged.append(item)

    return merged


# ---------------------------------------------------------------------------
# 截止时间判定
# ---------------------------------------------------------------------------

_DEADLINE_BEFORE = re.compile(
    r"(截止|截至|deadline|due|最晚|最迟|请于|务必于|须于|必须在|限于|限|前完成|到期)")
_DEADLINE_AFTER = re.compile(
    r"(之前|以前|截止|前|之内|以内|内完成|内反馈|内提交|内回复|前反馈|前回复|前提交|前回复|前完成)")
_SOON_WORDS = re.compile(r"(尽快|立即|马上|今日内|今天内|本周内|速|急)")
_DEADLINE_SUBJECT = re.compile(r"(截止|反馈|报送|提交|上报|完成|期限|时限|due)")


def _window(text: str, start: int, end: int, before: int = 24, after: int = 24) -> tuple[str, str]:
    return text[max(0, start - before):start], text[end:end + after]


def score_deadline(text: str, cand: dict[str, Any], subject: str = "") -> int:
    """给候选日期打「像截止时间」的分。"""
    before, after = _window(text, cand["start"], cand["end"])
    score = 0
    m_before = _DEADLINE_BEFORE.search(before)
    m_after = _DEADLINE_AFTER.search(after)
    if m_before:
        score += 3
        # 「截止时间：」就在前面，最可信
        if re.search(r"(截止时间|截止日期|deadline)\s*[:：]?\s*$", before):
            score += 3
    if m_after:
        score += 3
        if m_after.group(0) in ("前", "之前", "以前"):
            score += 1
        if re.search(r"^\s*(前|之前|以前)", after):
            score += 1
    if _DEADLINE_SUBJECT.search(subject or ""):
        score += 1
    if cand.get("has_time"):
        score += 2
    return score


def pick_deadline(text: str, ref: Optional[datetime] = None,
                  subject: str = "") -> Optional[dict[str, Any]]:
    """选出最可能作为「截止时间」的那个日期；没有明确时间词时返回最近一个带期限词的。"""
    cands = extract_datetimes(text, ref)
    ranked = sorted(
        ((score_deadline(text, c, subject), i, c) for i, c in enumerate(cands)),
        key=lambda x: (-x[0], x[2]["start"]),
    )
    for score, _, cand in ranked:
        if score >= 3:
            out = dict(cand)
            out["score"] = score
            out["deadline_text"] = _deadline_phrase(text, cand)
            out["deadline_limiter"] = _deadline_limiter(text, cand)
            return out
    return None


def _deadline_phrase(text: str, cand: dict[str, Any]) -> str:
    before, after = _window(text, cand["start"], cand["end"], before=16, after=16)
    raw = (before + cand["raw"] + after).strip()
    raw = raw.lstrip("：:，,。；;、）) ")
    raw = " ".join(raw.split())[:60]
    if raw.count("（") > raw.count("）"):      # 截断处留下半个括号，去掉它
        raw = raw[:raw.rfind("（")]
    return raw.strip(" ，,；;")


_RE_DEADLINE_LIMITER = re.compile(
    r"^(下班之前|下班前|下班时|下班|之前|以前|中午之前|中午前|中午|上午|下午|前|之内|以内)"
)


def _deadline_limiter(text: str, cand: dict[str, Any]) -> str:
    """取日期词后面紧跟的截止限定词（前 / 下班前 / 上午 / 下午 等），用于深度参考正文。"""
    end = cand.get("span", (cand["start"], cand["end"]))[1]
    after = text[end:end + 12]
    m = _RE_DEADLINE_LIMITER.match(after)
    return m.group(1) if m else ""


def detect_urgency(text: str) -> str:
    if _SOON_WORDS.search(text or ""):
        return "high"
    return "normal"


# ---------------------------------------------------------------------------
# 反馈对象抽取
# ---------------------------------------------------------------------------

_RE_EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
_RE_FEEDBACK_VERB = re.compile(
    r"(发给|发到|反馈|回复|报送|提交|上报|发送|抄送|交至|报至|发至|反馈至|联系|答复|回执)"
    r"\s*(?:给|至|到|于)?\s*[:：]?\s*"
    r"(?P<target>[^\s，。；、,;：:（）()\n]{2,24})"
)
_RE_FEEDBACK_ME = re.compile(
    r"(?:反馈|回复|报送|提交|上报|发送|发|报|交|联系|答复|回执)"
    r"\s*(?:给|至|到|于)?\s*[:：]?\s*(?:本人|我)"
)


def extract_feedback_targets(text: str, self_email: str = "") -> dict[str, Any]:
    """抽取「反馈给谁」：优先邮箱，其次姓名；两者都无则返回空。"""
    body = text or ""
    me = (self_email or "").lower()
    emails: list[str] = []
    names: list[str] = []
    evidence = ""

    for m in _RE_EMAIL.finditer(body):
        value = m.group(0).strip().rstrip(".")
        if value.lower() == me:
            continue
        if value not in emails:
            emails.append(value)
            if not evidence:
                before, after = _window(body, m.start(), m.end(), before=24, after=4)
                evidence = (before + value).strip()[-60:]

    for m in _RE_FEEDBACK_VERB.finditer(body):
        target = (m.group("target") or "").strip()
        target = re.split(r"(?:前|之前|以前|之内|以内|并|且|后|时)", target)[0].strip()
        if not target:
            continue
        if _RE_EMAIL.fullmatch(target):
            continue
        if target.startswith("我") or target in ("本人", "给我", "大家", "各位", "全员", "所有人"):
            continue
        if len(target) > 12:
            continue
        if target not in names:
            names.append(target)
            if not evidence:
                evidence = m.group(0).strip()[:60]

    return {
        "emails": emails,
        "names": names,
        "evidence": evidence,
        "has_explicit": bool(emails or names),
        "first_person": bool(_RE_FEEDBACK_ME.search(body)),
    }


# ---------------------------------------------------------------------------
# 正文清洗 / 摘要片段
# ---------------------------------------------------------------------------

_QUOTE_MARKERS = [
    "-----原始邮件-----", "----- 原始邮件 -----", "------------------ 原始邮件",
    "-----Original Message-----", "----- Forwarded", "在 20", "写道:", "wrote:",
    "发件人: ", "From: ", "-----邮件原件-----",
]


def strip_quoted(body: str) -> str:
    text = body or ""
    cut = len(text)
    for marker in _QUOTE_MARKERS:
        idx = text.find(marker, 40)
        if 40 <= idx < cut:
            cut = idx
    text = text[:cut]
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(">"):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


_GREETING = re.compile(r"^(各位|大家|您好|你好|尊敬的|亲爱的|all|hi|hello|领导|同事们)[^\n]{0,40}\n", re.I)


def make_excerpt(body: str, limit: int = 160) -> str:
    text = strip_quoted(body)
    text = _GREETING.sub("", text)
    text = re.sub(r"\n{2,}", "\n", text)
    one_line = " ".join(text.split())
    return one_line[:limit]


# 从正文里挑「要求句」当事件描述：优先含 请/需/须/务必/应 的那句
_RE_ASK_SENT = re.compile(r"([^。；！?\n]{0,80}(?:请|需|须|务必|应于|应|要求)[^。；！?\n]{0,120}(?:。|；|！|$))")
_RE_SENT_SPLIT = re.compile(r"[。；！?]")


def summarize_event(body: str, limit: int = 46) -> str:
    """根据正文给出「这件事是什么」的一句话摘要；抽不到就返回空串。"""
    text = strip_quoted(body)
    text = re.sub(r"TIDYWORKY-[A-Za-z0-9\-]+", "", text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    # 去掉称呼行（「各处室：」「各位同事：」「各相关同志：」）
    while lines and len(lines[0]) <= 16 and lines[0].rstrip().endswith(("：", ":")):
        lines.pop(0)
    # 去掉落款（纯日期、单位名、人名）
    while len(lines) > 1:
        last = lines[-1]
        if (re.fullmatch(r"20\d{2}年\d{1,2}月\d{1,2}日", last)
                or (len(last) <= 12 and re.search(r"(部|处|室|办|公司)$", last))
                or len(last) <= 4):
            lines.pop()
        else:
            break
    text = " ".join(" ".join(lines).split())
    text = text.strip(" ：:，,。")
    if not text:
        return ""

    ask = _RE_ASK_SENT.search(text)
    if ask:
        picked = ask.group(1)
    else:
        m = _RE_SENT_SPLIT.search(text)
        picked = text[:m.start()] if m else text
    picked = picked.strip(" ：:，,")
    clause = re.split(r"，(?=(?:并|同时|另外|以及|如))", picked)[0]
    clause = re.sub(r"[（(][^）)]*$", "", clause)      # 去掉被截断的左括号
    clause = clause.strip(" ，,。；;（(")
    if len(clause) > limit:
        cut = clause.rfind("，", 0, limit)
        clause = clause[:cut] if cut > limit // 2 else clause[:limit]
    clause = re.sub(r"[（(][^）)]*）?$", "", clause)   # 截断后再清一次悬挂括号
    return clause.strip(" ，,。；;、（）()")


# ---------------------------------------------------------------------------
# 参会回执（我回复的邮件里判断参加 / 不参加）
# ---------------------------------------------------------------------------

_RE_SUBJECT_PREFIX = re.compile(r"^\s*(?:re|回复|答复|fwd|转发|fw)\s*[：:]\s*", re.I)
_RE_RSVP_DECLINE = re.compile(
    r"(不参加|不能参加|无法参加|没法参加|参加不了|不能出席|无法出席|出席不了|去不了|来不了|"
    r"没空|没时间|有冲突|缺席|请假|不去了|改期吧)")
_RE_RSVP_ACCEPT = re.compile(
    r"(确认参加|一定参加|按时参加|准时参加|参加|出席|能来|会到|准时到|按时到|没问题|可以|好的)")


def normalize_subject(subject: str) -> str:
    """去掉 Re:/回复:/转发: 前缀并归一化，用于把回复邮件和原邀请对上。"""
    s = (subject or "").strip()
    prev = None
    while s and s != prev:
        prev = s
        s = _RE_SUBJECT_PREFIX.sub("", s, count=1)
    return re.sub(r"\s+", "", s).lower()


def parse_rsvp_reply(body: str) -> Optional[str]:
    """从我自己回复的邮件正文判断是否参加；返回 accept / decline / None（未表态）。"""
    text = strip_quoted(body)
    # 只取我写的那段（第一个引用标记之前），避免把原邀请里的「请准时参加」误判成我参加
    cut = len(text)
    for marker in _QUOTE_MARKERS:
        idx = text.find(marker)
        if 0 <= idx < cut:
            cut = idx
    text = " ".join(text[:cut].split())
    if not text:
        return None
    if _RE_RSVP_DECLINE.search(text):
        return "decline"
    if _RE_RSVP_ACCEPT.search(text):
        return "accept"
    return None


# ---------------------------------------------------------------------------
# 会议信号
# ---------------------------------------------------------------------------

_MEETING_STRONG = re.compile(
    r"(会议通知|会议邀请|邀请函|召开|参会|出席|列席|研讨会|评审会|座谈会|碰头会|例会|周会|月会"
    r"|培训会|宣讲会|答辩|路演|腾讯会议|钉钉会议|飞书会议|视频会|电话会|线上会|meeting|webinar|zoom)")
_MEETING_WEAK = re.compile(r"(会议|开会|议程|主持|签到|地点[:：]|会议室|议程表|形式[:：])")
_MEETING_TITLE = re.compile(r"[\u4e00-\u9fa5]{1,4}会")
_MEETING_TITLE_BAD = {"机会", "体会", "理会", "误会", "社会", "协会", "商会", "工会", "聚会", "约会", "宴会", "晚会", "舞会", "庙会", "展销会", "交易会", "博览会", "游园会", "灯会", "花会", "堂会", "学会", "委员会"}
_LEADING_WORDS = "有个这那的了过在和与及就是去来"


def meeting_title(text: str) -> str:
    """从一句话里抽出会议名称（如「需求会」「评审会」），抽不到返回空串。"""
    for w in reversed(_MEETING_TITLE.findall(text or "")):
        if w in _MEETING_TITLE_BAD:
            continue
        w = w.lstrip(_LEADING_WORDS)
        mm = re.search(r"[室楼店馆厅场区座](.+会)$", w)
        if mm:
            w = mm.group(1)
        w = w.lstrip("开办举行")
        if w and w not in _MEETING_TITLE_BAD:
            return w
    return ""


_MEETING_INVITE = re.compile(
    r"(邀请您|邀请你|诚邀|敬请.{0,4}(参加|出席)|请.{0,6}(参加|出席|参会)|能否参加|是否参加"
    r"|是否方便|方便的话|请确认|确认是否|征求.{0,4}意见|时间待定|另行通知|待定)")
_MEETING_FIXED = re.compile(
    r"(定于|定在|将于|准时|届时|请务必|务必参加|准时参加|如期|不变|会议安排如下|日程如下)")

TODO_STRONG = re.compile(
    r"(截止|反馈|报送|上报|提交|填报|申报|回执|完成情况|材料|请于|前反馈|前提交|前回复|前完成"
    r"|统计表|汇总表|台账|审批|办理|签收|确认单|问卷调查|deadline)")
TODO_WEAK = re.compile(r"(请|需要|完成|提供|配合|办理|截止|之前|材料|表格|回复)")

_EXCLUDE_SUBJECT = re.compile(
    r"(验证码|校验码|账单|月结|发票已|电子发票|物流|快递|优惠|促销|秒杀|领取|订阅|退订"
    r"|unsubscribe|newsletter|周报订阅|广告|营销|满意度调查问卷链接|中奖)")
_EXCLUDE_SENDER = re.compile(r"(no-?reply|mailer-daemon|postmaster|notifications?@|noreply)", re.I)


def classify_text(subject: str, body: str, sender_email: str, self_email: str,
                  has_ics: bool = False, importance: str = "Normal",
                  ref: Optional[datetime] = None) -> dict[str, Any]:
    """对一封邮件做「待反馈 / 会议 / 其他」归类，并给出可解释的依据。"""
    ref_dt = ref or common.local_now()
    subject = subject or ""
    text = strip_quoted(body or "")
    haystack = subject + "\n" + text

    meeting_strong = bool(_MEETING_STRONG.search(haystack))
    meeting_weak = bool(_MEETING_WEAK.search(haystack))
    invite = bool(_MEETING_INVITE.search(haystack))
    fixed = bool(_MEETING_FIXED.search(haystack))
    todo_strong = bool(TODO_STRONG.search(haystack))
    todo_weak = bool(TODO_WEAK.search(haystack))
    excluded = bool(_EXCLUDE_SUBJECT.search(subject)) or bool(_EXCLUDE_SENDER.search(sender_email or ""))

    datetimes = extract_datetimes(haystack, ref_dt)
    time_cands = [c for c in datetimes if c.get("has_time")]
    location = _extract_location(text)
    meeting_name = meeting_title(text)
    deadline = pick_deadline(text, ref_dt, subject)
    feedback = extract_feedback_targets(text, self_email)

    meeting_score = 0
    if meeting_strong:
        meeting_score += 6
    if meeting_weak:
        meeting_score += 2
    if invite:
        meeting_score += 2
    if has_ics:
        meeting_score += 8
    if time_cands:
        meeting_score += 3
    if location:
        meeting_score += 2
    if meeting_name:
        meeting_score += 5

    todo_score = 0
    if todo_strong:
        todo_score += 5
    if deadline:
        todo_score += 4
    if feedback["has_explicit"]:
        todo_score += 2
    if todo_weak:
        todo_score += 1
    if re.search(r"(待办|任务|要求|需完成|请完成)", haystack):
        todo_score += 2

    tag = ""
    if excluded and meeting_score < 8:
        tag = ""
    elif meeting_score >= 7 and meeting_score >= todo_score:
        tag = "会议"
    elif todo_score >= 6:
        tag = "待反馈" if feedback["has_explicit"] else "一般待办"
    elif meeting_score >= 5 and time_cands:
        tag = "会议"

    is_mine = (sender_email or "").lower() == (self_email or "").lower()
    meeting_role = ""
    needs_decision = False
    if tag == "会议":
        if is_mine:
            # 我发给别人的会议 → 我一定参加
            meeting_role = "我发起·已定"
        elif invite and not fixed:
            # 邀请口气（邀我参会、待我确认）→ 不一定参加，需前端手动确认
            meeting_role = "他人邀请·待确认"
            needs_decision = True
        else:
            # 通知口气（定于/准时/务必）→ 我一定参加
            meeting_role = "他人通知我"

    confidence = "low"
    if tag == "会议" and (time_cands or has_ics):
        confidence = "high" if (meeting_strong or has_ics) else "medium"
    elif tag == "会议":
        confidence = "low"
    elif tag in ("待反馈", "一般待办"):
        if deadline and feedback["has_explicit"]:
            confidence = "high"
        elif deadline:
            confidence = "medium"
        else:
            confidence = "low"

    signals: list[str] = []
    if meeting_strong:
        signals.append("会议关键词")
    if has_ics:
        signals.append("会议邀请附件(.ics)")
    if time_cands:
        signals.append("有明确时间")
    if invite:
        signals.append("邀请/待确认口气")
    if fixed:
        signals.append("已定/通知口气")
    if deadline:
        signals.append("截止时间")
    if feedback["has_explicit"]:
        signals.append("反馈对象")
    if importance == "High":
        signals.append("高优先级")

    return {
        "tag": tag,
        "confidence": confidence,
        "deadline": deadline,
        "feedback": feedback,
        "datetimes": datetimes,
        "time_candidates": time_cands,
        "location": location,
        "meeting_role": meeting_role,
        "needs_decision": needs_decision,
        "is_mine": is_mine,
        "scores": {"meeting": meeting_score, "todo": todo_score},
        "signals": signals,
    }


_RE_LOCATION = re.compile(
    r"(?:地点|会议地点|地址|会议室|会场|venue|location)\s*[:：]\s*([^\n，。；;]{2,40})", re.I)
_RE_LOCATION_SUFFIX = re.compile(r"在(.{1,20}(?:楼|室|层|座|区|馆|店|厅|场))")
_RE_LOCATION_AT = re.compile(r"在(.{1,24}?)(?=有|开|办|举行|召开|进行|碰头|商量|讨论|见|约|聊|谈)")
_TIME_IN_LOC = re.compile(r"(天|周|月|点|时|分|秒|上午|下午|中午|晚上|早上|明早|明晚|\d+\s*[:：]\s*\d+)")


def _clean_loc(s: str) -> str:
    return s.strip().rstrip("。；;，,")[:40]


def _extract_location(text: str) -> str:
    m = _RE_LOCATION.search(text or "")
    if m:
        return _clean_loc(m.group(1))
    m = _RE_LOCATION_SUFFIX.search(text or "")
    if m:
        loc = _clean_loc(m.group(1))
        if loc and not _TIME_IN_LOC.search(loc):
            return loc
    m = _RE_LOCATION_AT.search(text or "")
    if m:
        loc = _clean_loc(m.group(1))
        if loc and not _TIME_IN_LOC.search(loc):
            return loc
    return ""
# 会议时间窗（开始 + 结束）
# ---------------------------------------------------------------------------

_RE_TIME_RANGE = re.compile(
    r"(?:(\d{1,2})\s*[:：]\s*(\d{2}))\s*[-~—至到]\s*(?:(\d{1,2})\s*[:：]\s*(\d{2}))")


def meeting_window(text: str, ref: Optional[datetime] = None) -> tuple[str, str]:
    """尝试给出会议起止（本地 ISO）；只有日期时结束=当天 23:59。"""
    text = strip_quoted(text or "")
    datetimes = extract_datetimes(text, ref)
    if not datetimes:
        return "", ""
    cand = datetimes[0]
    if not cand["date"]:
        return "", ""
    if cand.get("has_time"):
        start = datetime.combine(date.fromisoformat(cand["date"]),
                                 time(int(cand["hour"]), int(cand["minute"])),
                                 common.effective_local_tz())
        end = start + timedelta(hours=1)
        m = _RE_TIME_RANGE.search(text)
        if m:
            try:
                h2, m2 = int(m.group(3)), int(m.group(4))
                end2 = start.replace(hour=h2, minute=m2)
                if end2 > start:
                    end = end2
            except ValueError:
                pass
        return start.isoformat(timespec="minutes"), end.isoformat(timespec="minutes")
    start = datetime.combine(date.fromisoformat(cand["date"]), time.min,
                             common.effective_local_tz())
    return start.isoformat(timespec="minutes"), (start + timedelta(days=1)).isoformat(timespec="minutes")