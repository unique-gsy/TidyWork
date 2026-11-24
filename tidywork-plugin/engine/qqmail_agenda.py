#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - C 阶段待办清单编排（组合 A/B 原子能力）。

组合关系：
- 邮件元数据/全文：qqmail_core.QQMailClient.search_items / _fetch_full
- 日历事件：qqmail_caldav.CalDAVClient.query_events
- 时间与分类：qqmail_todo（纯函数）
本模块只负责「扫描 → 合并去重 → 存清单 → 渲染」，不新增任何底层协议实现。
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

_RE_REPLY_SUBJECT = re.compile(r"(?:^|[\s])(?:re|回复|答复|fwd|转发|fw)\s*[：:]", re.I)

import qqmail_common as common
import qqmail_todo as todo
from qqmail_caldav import CalDAVClient
from qqmail_core import QQMailClient

TAG_TODO = "待反馈"
TAG_TODO_PLAIN = "一般待办"
TAG_MEETING = "会议"
TAG_META = {
    TAG_TODO: {"badge": "🟧 待反馈", "emoji": "🟧"},
    TAG_TODO_PLAIN: {"badge": "🟩 一般待办", "emoji": "🟩"},
    TAG_MEETING: {"badge": "🟦 会议", "emoji": "🟦"},
}
STATUS_LABEL = {
    "pending": "待处理",
    "accepted": "已确认参加",
    "declined": "已拒绝",
    "done": "已完成",
}

DEFAULT_STATE_FILE = "todo.json"
DEFAULT_SCAN_DAYS = 7
DEFAULT_CALENDAR_DAYS = 14
DEFAULT_MAX_MAILS = 40


# ---------------------------------------------------------------------------
# 状态文件
# ---------------------------------------------------------------------------

def state_path(custom: str = "") -> Path:
    if custom:
        return Path(custom).expanduser()
    return common.package_root() / DEFAULT_STATE_FILE


def load_state(custom: str = "") -> dict[str, Any]:
    path = state_path(custom)
    if not path.exists():
        return {"version": 1, "updated_at": "", "items": [], "declined_keys": []}
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise common.QQMailError(f"待办清单文件损坏或无法读取（{path}）：{exc}") from exc
    if not isinstance(data, dict):
        raise common.QQMailError(f"待办清单文件格式不正确（{path}）")
    data.setdefault("version", 1)
    data.setdefault("items", [])
    data.setdefault("declined_keys", [])
    return data


def save_state(state: dict[str, Any], custom: str = "") -> Path:
    path = state_path(custom)
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = common.local_iso(common.local_now())
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 条目构造
# ---------------------------------------------------------------------------

def _short_id(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:5]


def _sender_label(item: dict[str, Any]) -> str:
    sender = item.get("from") or {}
    name = (sender.get("name") or "").strip()
    email = (sender.get("email") or "").strip()
    if name and email:
        return f"{name} <{email}>"
    return name or email or "-"


def _mail_source(item: dict[str, Any]) -> dict[str, Any]:
    from_box = item.get("from") if isinstance(item.get("from"), dict) else {}

    def _emails(key: str) -> list[str]:
        return [b.get("email", "").lower()
                for b in (item.get(key) or [])
                if isinstance(b, dict) and b.get("email")]

    return {
        "kind": "mail",
        "folder": item.get("folder") or "inbox",
        "uid": item.get("item_id") or "",
        "subject": item.get("subject") or "",
        "from": _sender_label(item),
        "from_email": from_box.get("email", "") or "",
        "to_emails": _emails("to_recipients") + _emails("cc_recipients"),
        "date": item.get("date_time_received") or item.get("date_time_sent") or "",
        "message_id": item.get("message_id") or "",
    }


def _calendar_source(ev, calendar_href: str) -> dict[str, Any]:
    organizer = (ev.organizer or "").strip()
    if organizer.lower().startswith("mailto:"):
        organizer = organizer[7:]
    return {
        "kind": "calendar",
        "calendar": calendar_href,
        "uid": ev.uid or "",
        "href": ev.href or "",
        "subject": ev.summary or "",
        "from": organizer,
        "from_email": organizer,
        "date": str(ev.start or ""),
        "message_id": "",
    }


def _normalize_title(text: str) -> str:
    value = todo.strip_quoted(text or "")
    value = re.sub(r"^(re|fw|fwd|答复|回复|转发)\s*[:：]\s*", "", value, flags=re.I)
    value = re.sub(r"[【】\[\]（）()《》<>“”\"'·、,，。.！!？?：:\-—_/\\\s]+", "", value)
    return value.lower()


_MEETING_TIME_WINDOW_MIN = 60  # 同一场会议允许的开始时间偏差（分钟，容忍时区/录入误差）


def _norm_attendees(attendees: list[str]) -> set[str]:
    """把参会人列表归一化成可比较的集合（小写 email，兼容 mailto:/<email>/纯名字）。"""
    out: set[str] = set()
    for raw in attendees or []:
        x = (raw or "").strip().lower()
        if not x:
            continue
        if x.startswith("mailto:"):
            x = x[len("mailto:"):]
        m = re.search(r"<([^>]+)>", x)
        if m:
            x = m.group(1).strip()
        if x:
            out.add(x)
    return out


def _time_state(a: dict[str, Any], b: dict[str, Any]) -> str:
    """时间维度：match=吻合 / conflict=冲突 / missing=缺失。"""
    sa, sb = a.get("meeting_start"), b.get("meeting_start")
    if not sa or not sb:
        return "missing"
    try:
        da = datetime.fromisoformat(sa)
        db = datetime.fromisoformat(sb)
    except ValueError:
        return "missing"
    if da.date() != db.date():
        return "conflict"
    if abs((da - db).total_seconds()) > _MEETING_TIME_WINDOW_MIN * 60:
        return "conflict"
    return "match"


def _loc_state(a: dict[str, Any], b: dict[str, Any]) -> str:
    la = _normalize_location(a.get("location") or "")
    lb = _normalize_location(b.get("location") or "")
    if la and lb:
        return "match" if la == lb else "conflict"
    return "missing"


def _att_state(a: dict[str, Any], b: dict[str, Any]) -> str:
    aa = _norm_attendees(a.get("attendees") or [])
    ab = _norm_attendees(b.get("attendees") or [])
    if aa and ab:
        return "match" if (aa & ab) else "conflict"
    return "missing"


def _title_match(a: dict[str, Any], b: dict[str, Any]) -> bool:
    ta = _normalize_title(a.get("title", ""))
    tb = _normalize_title(b.get("title", ""))
    if not ta or not tb:
        return False
    return ta == tb or difflib.SequenceMatcher(None, ta, tb).ratio() >= 0.75


def _party_match(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """邀请 ↔ 回复讨论同一会：通过发件人/收件人互换或一致判断。"""
    sa = a.get("source") or {}
    sb = b.get("source") or {}
    if sa.get("kind") != "mail" or sb.get("kind") != "mail":
        return False
    fa = (sa.get("from_email") or "").lower()
    fb = (sb.get("from_email") or "").lower()
    if not fa or not fb:
        return False
    ta = set(sa.get("to_emails") or [])
    tb = set(sb.get("to_emails") or [])
    # 互发：a 的发件人是 b 的收件人，且 b 的发件人是 a 的收件人（邀请→回复）
    if fa in tb and fb in ta:
        return True
    # 同一发件人反复发同一场会（通知/提醒/追问）
    if fa == fb:
        return True
    return False


def _same_meeting(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """邮件/日历同一场会议去重：硬冲突强拆 + 多要素一致才合并。

    度（贴合用户口径）：
    - 时间/地点/参会人任一「明确冲突」（地点不一致、参会人无交集、时间差超窗口）
      → 一定是两场，直接拆开；
    - 无冲突时，统计「出现且可比」的维度里一致的数量（时间/地点/参会人/标题/收发件人）；
    - 单个要素一致说明不了什么，≥2 个不同要素都一致才判为同一场；
    - 收发件人互发（邀请↔回复）作为语义链路强信号参与计数。
    """
    t = _time_state(a, b)
    loc = _loc_state(a, b)
    att = _att_state(a, b)
    title = _title_match(a, b)
    party = _party_match(a, b)

    if "conflict" in (t, loc, att):
        return False

    matches = (sum(1 for s in (t, loc, att) if s == "match")
               + (1 if title else 0) + (1 if party else 0))
    return matches >= 2


def build_mail_item(item: dict[str, Any], detail: dict[str, Any],
                    self_email: str, ref: datetime) -> Optional[dict[str, Any]]:
    """把一封邮件（含正文/附件）转成待办条目；不属于两类则返回 None。"""
    body = detail.get("body_text") or detail.get("preview") or ""
    has_ics, ics_event = _ics_from_detail(detail)
    cls = todo.classify_text(
        item.get("subject", ""), body,
        (item.get("from") or {}).get("email", ""), self_email,
        has_ics=has_ics, importance=item.get("importance", "Normal"), ref=ref)
    if not cls["tag"]:
        return None

    source = _mail_source(item)
    key = f"mail:{source['folder']}:{source['uid']}"
    title = item.get("subject") or "(无主题)"
    event = title
    summary_from = "subject"
    if cls["tag"] in (TAG_TODO, TAG_TODO_PLAIN):
        digest = todo.summarize_event(body)
        if digest and len(digest) >= 8:
            event, summary_from = digest, "body"
    base = {
        "key": key, "short_id": _short_id(key),
        "tag": cls["tag"],
        "title": title,
        "summary": event,
        "summary_from": summary_from,
        "excerpt": todo.make_excerpt(body),
        "source": source,
        "confidence": cls["confidence"],
        "signals": cls["signals"],
        "status": "pending",
        "needs_decision": bool(cls["needs_decision"]),
        "created_at": common.local_iso(ref),
        "updated_at": common.local_iso(ref),
    }

    if cls["tag"] in (TAG_TODO, TAG_TODO_PLAIN):
        deadline = cls["deadline"] or {}
        feedback = cls["feedback"]
        emails = list(feedback.get("emails") or [])
        names = list(feedback.get("names") or [])
        first_person = bool(feedback.get("first_person"))
        inferred = False
        sender_email = (item.get("from") or {}).get("email", "")
        # 只有「待反馈」才推断反馈对象；「一般待办」没有反馈对象，保持为空
        if cls["tag"] == TAG_TODO and not emails and not names and sender_email and sender_email.lower() != self_email.lower():
            emails = [sender_email]
            inferred = not first_person
        base.update({
            "deadline": deadline.get("date", ""),
            "deadline_time": deadline.get("time", ""),
            "deadline_text": deadline.get("deadline_text", ""),
            "deadline_limiter": deadline.get("deadline_limiter", ""),
            "deadline_confidence": deadline.get("confidence", 0),
            "feedback_to": emails,
            "feedback_names": names,
            "feedback_inferred": inferred,
            "feedback_first_person": first_person and bool(emails),
            "urgency": todo.detect_urgency(body),
        })
        return base

    # 会议
    start = end = ""
    location = cls["location"]
    attendees: list[str] = []
    if ics_event is not None:
        start = _iso(ics_event.start)
        end = _iso(ics_event.end)
        location = ics_event.location or location
        attendees = list(ics_event.attendees or [])
    if not start:
        start, end = todo.meeting_window(body, ref)
    if not start and cls["time_candidates"]:
        cand = cls["time_candidates"][0]
        if cand["date"]:
            start = datetime.combine(
                date.fromisoformat(cand["date"]),
                todo_time(cand["hour"], cand["minute"])).isoformat(timespec="minutes")
            end = ""
    base.update({
        "meeting_start": start,
        "meeting_end": end,
        "all_day": bool(ics_event.all_day) if ics_event is not None else (bool(start) and not cls["time_candidates"]),
        "location": location,
        "attendees": attendees,
        "meeting_role": cls["meeting_role"],
        "needs_decision": bool(cls["needs_decision"]),
        "deadline": "",
    })
    return base


def todo_time(hour: int, minute: int):
    from datetime import time as _time
    return _time(int(hour), int(minute))


def _iso(value) -> str:
    if isinstance(value, datetime):
        return common.local_iso(value)
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(),
                                common.effective_local_tz()).isoformat(timespec="minutes")
    return str(value or "")


def _ics_from_detail(detail: dict[str, Any]):
    """从附件中解析会议邀请（.ics）；返回 (是否有ics, 事件或None)。"""
    import icalendar as ical
    for att in detail.get("attachments") or []:
        name = (att.get("name") or "").lower()
        if not name.endswith(".ics"):
            continue
        payload = att.get("_payload") or b""
        if not payload:
            continue
        text = ""
        for enc in ("utf-8", "utf-16", "latin-1"):
            try:
                text = payload.decode(enc)
                break
            except UnicodeDecodeError:
                text = ""
        if not text:
            continue
        try:
            root = ical.parse_icalendar(text)
            events = root.subcomponents("VEVENT")
        except Exception:  # noqa: BLE001 - 附件损坏不应中断扫描
            continue
        if events:
            return True, ical.component_to_event(events[0])
    return False, None


def build_calendar_item(ev, calendar_href: str, self_email: str,
                        ref: datetime) -> Optional[dict[str, Any]]:
    if (ev.status or "").upper() == "CANCELLED":
        return None
    source = _calendar_source(ev, calendar_href)
    key = f"cal:{calendar_href}:{source['uid']}"
    organizer = (ev.organizer or "").lower()
    is_mine = bool(organizer) and self_email.lower() in organizer
    return {
        "key": key, "short_id": _short_id(key),
        "tag": TAG_MEETING,
        "title": ev.summary or "(无标题会议)",
        "summary": ev.summary or "",
        "excerpt": (ev.description or "")[:160],
        "source": source,
        "confidence": "high",
        "signals": ["日历事件"],
        "status": "pending",
        "meeting_start": _iso(ev.start),
        "meeting_end": _iso(ev.end),
        "all_day": bool(ev.all_day),
        "location": ev.location or "",
        "attendees": list(ev.attendees or []),
        "meeting_role": "我发起" if is_mine else "他人通知我",
        "needs_decision": not is_mine,
        "deadline": "",
        "created_at": common.local_iso(ref),
        "updated_at": common.local_iso(ref),
    }


# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------

def _batch_details(client: QQMailClient, uids: list[str], folder: str) -> dict[str, dict[str, Any]]:
    """同一次连接里批量取全文，降低 QQ 的建连频率。"""
    out: dict[str, dict[str, Any]] = {}
    if not uids:
        return out
    target = client.resolve_folder(folder)
    try:
        with client.imap() as conn:
            with client._selected(conn, target, readonly=True):
                for uid in uids:
                    try:
                        item = client._fetch_full(conn, uid, folder)
                        out[str(uid)] = item
                    except common.QQMailError:
                        continue
    except Exception as exc:  # noqa: BLE001 - 批量通道失败时退回逐封读取
        if not out:
            for uid in uids:
                try:
                    out[str(uid)] = client.get_item_detail(uid, folder)
                except common.QQMailError:
                    continue
    return out


_PREFILTER_HINTS = (
    "会议", "例会", "召开", "出席", "参会", "邀请", "地点", "日程", "预约",
    "培训", "讲座", "沙龙", "座谈", "评审", "复盘", "汇报", "答辩", "面试",
    "截止", "截至", "反馈", "报送", "提交", "填报", "截止时间", "之前", "前完成",
    "待办", "任务", "办理", "申领", "确认", "会",
)


def _prefilter(items: list[dict[str, Any]], self_email: str, ref: datetime,
               cap: Optional[int] = None) -> list[dict[str, Any]]:
    """廉价筛：先用主题+预览分类，再看关键词提示，避免为几百封无关邮件拉全文。

    QQ 头部拉取通常不带 preview，正文里的信号拿不到，所以候选数不超过 cap 时
    直接全量读全文（成本可控且更准），只有超过 cap 才按分数/关键词裁剪。
    """
    if cap is not None and len(items) <= cap:
        return list(items)
    picked = []
    for item in items:
        cls = todo.classify_text(item.get("subject", ""), item.get("preview", ""),
                                 (item.get("from") or {}).get("email", ""), self_email, ref=ref)
        text = f"{item.get('subject', '')} {item.get('preview', '')}"
        if (cls["tag"] or cls["scores"]["meeting"] >= 3 or cls["scores"]["todo"] >= 3
                or any(h in text for h in _PREFILTER_HINTS)):
            picked.append(item)
    return picked


def _apply_rsvp_replies(client: QQMailClient, items: list[dict[str, Any]],
                        since: str, limit: int = 150) -> dict[str, int]:
    """遍历发件箱里我对邀请的回复，判定「参加/不参加」并直接改写会议条目状态。"""
    pending = [it for it in items if it["tag"] == TAG_MEETING and it.get("needs_decision")]
    if not pending:
        return {"checked": 0, "resolved": 0}
    titles = {todo.normalize_subject(it.get("title", "")) for it in pending}
    meta = client.search_items("sentitems", filters=common.MailSearchFilters(after=since), limit=limit)
    cands = []
    for p in meta:
        norm = todo.normalize_subject(p.get("subject", ""))
        if norm in titles or _RE_REPLY_SUBJECT.search(p.get("subject", "")):
            cands.append(p)
    if not cands:
        return {"checked": 0, "resolved": 0}
    details = _batch_details(client, [p.get("item_id") for p in cands], "sentitems")
    resolved = 0
    for it in pending:
        norm = todo.normalize_subject(it.get("title", ""))
        src = it.get("source") or {}
        src = src if isinstance(src, dict) else {}
        msgid = src.get("message_id", "") or ""
        sender = src.get("from_email", "") or ""
        decision: Optional[str] = None
        for p in cands:
            d = details.get(str(p.get("item_id")))
            if not d:
                continue
            if msgid and (d.get("in_reply_to") or "").lower() == msgid.lower():
                decision = todo.parse_rsvp_reply(d.get("body_text") or "")
                if decision:
                    break
            if todo.normalize_subject(d.get("subject", "")) == norm:
                tos = [b.get("email", "").lower() for b in (d.get("to_recipients") or [])]
                if not sender or sender.lower() in tos:
                    decision = todo.parse_rsvp_reply(d.get("body_text") or "")
                    if decision:
                        break
        if decision == "accept":
            it["status"] = "accepted"
            it["needs_decision"] = False
            it["decided_at"] = common.local_iso(common.local_now())
            it["rsvp"] = "reply-accept"
            resolved += 1
        elif decision == "decline":
            it["status"] = "declined"
            it["rsvp"] = "reply-decline"
            resolved += 1
    return {"checked": len(cands), "resolved": resolved}


def scan(cfg: common.Config, *, days: int = DEFAULT_SCAN_DAYS,
         folder: str = "inbox", include_sent: bool = True,
         include_calendar: bool = True, calendar: str = "",
         calendar_days: int = DEFAULT_CALENDAR_DAYS,
         max_mails: int = DEFAULT_MAX_MAILS, limit: int = 300,
         ref: Optional[datetime] = None) -> dict[str, Any]:
    """扫描邮件与日历，返回新条目列表（不写盘）。"""
    ref_dt = ref or common.local_now()
    since = (ref_dt - timedelta(days=max(days, 1))).date().strftime("%Y-%m-%d")
    client = QQMailClient(cfg)
    items: list[dict[str, Any]] = []
    stats: dict[str, Any] = {"mail_scanned": 0, "mail_detail_fetched": 0,
                             "mail_days": days,
                             "calendar_scanned": 0, "skipped": []}

    def _scan_folder(folder_name: str, only_meetings: bool, cap: int):
        filters = common.MailSearchFilters(after=since)
        meta = client.search_items(folder_name, filters=filters, limit=limit)
        stats["mail_scanned"] += len(meta)
        picked = _prefilter(meta, cfg.email, ref_dt, cap)
        if only_meetings:
            picked = [p for p in picked
                      if not _RE_REPLY_SUBJECT.search(p.get("subject", ""))
                      and todo.classify_text(p.get("subject", ""), p.get("preview", ""),
                                            (p.get("from") or {}).get("email", ""), cfg.email,
                                            ref=ref_dt)["tag"] == TAG_MEETING]
        picked = picked[:cap]
        details = _batch_details(client, [p.get("item_id") for p in picked], folder_name)
        stats["mail_detail_fetched"] += len(details)
        for p in picked:
            detail = details.get(str(p.get("item_id")))
            if not detail:
                continue
            built = build_mail_item(p, detail, cfg.email, ref_dt)
            if built:
                items.append(built)

    _scan_folder(folder, False, max_mails)
    if include_sent:
        try:
            _scan_folder("sentitems", True, max(10, max_mails // 2))
        except common.QQMailError as exc:
            stats["skipped"].append(f"已发送扫描失败：{exc}")

    if include_calendar and cfg.caldav_enabled:
        try:
            caldav = CalDAVClient(cfg)
            href = caldav.resolve_calendar(calendar)
            start = datetime.combine(ref_dt.date() - timedelta(days=1),
                                     datetime.min.time(), common.effective_local_tz())
            end = start + timedelta(days=calendar_days + 1)
            events = caldav.query_events(href, start, end)
            stats["calendar_scanned"] = len(events)
            for ev in events:
                built = build_calendar_item(ev, href, cfg.email, ref_dt)
                if built:
                    items.append(built)
        except Exception as exc:  # noqa: BLE001 - 日历失败不应影响邮件清单
            stats["skipped"].append(f"日历扫描失败：{exc}")

    if include_sent:
        try:
            rsvp = _apply_rsvp_replies(client, items, since)
            stats["rsvp_replies_checked"] = rsvp["checked"]
            stats["rsvp_resolved"] = rsvp["resolved"]
        except common.QQMailError as exc:
            stats["skipped"].append(f"参会回执扫描失败：{exc}")

    return {"items": _dedupe(items), "stats": stats, "range": {"after": since,
                                                               "days": days}}


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """同一场会议同时出现在邮件和日历时只留一条（优先保留邮件，信息更全）。"""
    kept: list[dict[str, Any]] = []
    for item in items:
        dup = None
        for exist in kept:
            if exist["tag"] == TAG_MEETING and item["tag"] == TAG_MEETING and _same_meeting(exist, item):
                dup = exist
                break
        if dup is None:
            kept.append(item)
            continue
        # 合并：邮件优先作为主来源，日历补 uid/地点/参与人
        if dup["source"]["kind"] == "calendar" and item["source"]["kind"] == "mail":
            item["calendar_uid"] = dup["source"].get("uid", "")
            for field in ("location", "attendees"):
                if not item.get(field) and dup.get(field):
                    item[field] = dup[field]
            kept[kept.index(dup)] = item
        else:
            for field in ("location", "attendees", "meeting_end"):
                if not dup.get(field) and item.get(field):
                    dup[field] = item[field]
            if item["source"]["kind"] == "calendar":
                dup["calendar_uid"] = item["source"].get("uid", "")
    return kept


def merge(state: dict[str, Any], new_items: list[dict[str, Any]]) -> dict[str, int]:
    """把新条目并入清单：保留已有状态，跳过已拒绝的，返回统计。"""
    slots = {it["key"]: idx for idx, it in enumerate(state.get("items", []))}
    declined = set(state.get("declined_keys", []))
    counts = {"added": 0, "updated": 0, "kept_done": 0, "skipped_declined": 0}
    for item in new_items:
        key = item["key"]
        if key in declined:
            counts["skipped_declined"] += 1
            continue
        if item.get("status") == "declined":
            # 扫描时从回执判断出「不参加」：记入 declined_keys 防复活，不放进清单
            if key not in state.setdefault("declined_keys", []):
                state["declined_keys"].append(key)
            counts["skipped_declined"] += 1
            continue
        if key not in slots:
            slots[key] = len(state["items"])
            state["items"].append(item)
            counts["added"] += 1
            continue
        old = state["items"][slots[key]]
        status = old.get("status", "pending")
        deadline_changed = bool(item.get("deadline")) and item.get("deadline") != old.get("deadline")
        meeting_changed = bool(item.get("meeting_start")) and item.get("meeting_start") != old.get("meeting_start")
        merged = dict(old)
        rsvp_decision = item.get("rsvp") in ("reply-accept", "reply-decline")
        for field, value in item.items():
            if field in ("status", "created_at", "decided_at"):
                continue
            if value not in (None, "", [], {}):
                merged[field] = value
        merged["updated_at"] = common.local_iso(common.local_now())
        if rsvp_decision and item.get("status") in ("accepted", "declined"):
            # 回执识别出的状态要生效（declined 已在上方 continue，这里通常只有 accepted）
            merged["status"] = item["status"]
        elif status == "done" and (deadline_changed or meeting_changed):
            merged["status"] = "pending"   # 时间被改期，重新回到待处理
            merged["reopened_reason"] = "时间已变更"
        else:
            merged["status"] = status
        state["items"][slots[key]] = merged
        counts["updated"] += 1
        if status != "pending":
            counts["kept_done"] += 1
    return counts


# ---------------------------------------------------------------------------
# 查找 / 状态流转
# ---------------------------------------------------------------------------

def find_item(state: dict[str, Any], ref: str) -> dict[str, Any]:
    ref = (ref or "").strip().lower()
    if not ref:
        raise common.QQMailError("缺少待办编号")
    exact = [it for it in state["items"] if it["key"].lower() == ref]
    if exact:
        return exact[0]
    hits = [it for it in state["items"] if it["short_id"].lower() == ref]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise common.QQMailError(f"编号 {ref} 命中多条，请用完整 key 指定")
    prefix = [it for it in state["items"] if it["short_id"].lower().startswith(ref)]
    if len(prefix) == 1:
        return prefix[0]
    if len(prefix) > 1:
        raise common.QQMailError(f"编号 {ref} 命中多条，请写全 5 位编号")
    raise common.QQMailError(f"清单里没有编号 {ref} 的条目")


def set_status(state: dict[str, Any], ref: str, status: str) -> dict[str, Any]:
    item = find_item(state, ref)
    if status == "accepted" and item["tag"] != TAG_MEETING:
        raise common.QQMailError("只有「会议」类条目可以确认参加；待反馈类请用 todo-done 标记完成")
    item["status"] = status
    item["decided_at"] = common.local_iso(common.local_now())
    if status == "declined":
        keys = state.setdefault("declined_keys", [])
        if item["key"] not in keys:
            keys.append(item["key"])
    return item


def add_manual(state: dict[str, Any], *, tag: str, title: str, deadline: str = "",
               feedback_to: str = "", meeting_start: str = "", location: str = "",
               note: str = "") -> dict[str, Any]:
    if tag not in (TAG_TODO, TAG_TODO_PLAIN, TAG_MEETING):
        raise common.QQMailError("tag 只能是「一般待办」「待反馈」或「会议」")
    now = common.local_iso(common.local_now())
    key = f"manual:{hashlib.sha1((title + now).encode('utf-8')).hexdigest()[:10]}"
    item = {
        "key": key, "short_id": _short_id(key), "tag": tag,
        "title": title, "summary": title, "excerpt": note,
        "source": {"kind": "manual", "folder": "", "uid": "", "subject": title,
                   "from": "", "date": now, "message_id": ""},
        "confidence": "high", "signals": ["手动添加"], "status": "pending",
        "needs_decision": tag == TAG_MEETING,
        "deadline": deadline, "deadline_time": "", "deadline_text": deadline,
        "feedback_to": [x.strip() for x in feedback_to.split(",") if x.strip()],
        "feedback_names": [], "feedback_inferred": False,
        "meeting_start": meeting_start, "meeting_end": "", "all_day": False,
        "location": location, "attendees": [],
        "meeting_role": "手动添加" if tag == TAG_MEETING else "",
        "created_at": now, "updated_at": now,
    }
    state["items"].append(item)
    return item


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------

def _deadline_state(item: dict[str, Any], today: date) -> tuple[str, str]:
    deadline = item.get("deadline") or ""
    if not deadline:
        return ("未写明", "⚪")
    try:
        d = date.fromisoformat(deadline)
    except ValueError:
        return (deadline, "⚪")
    delta = (d - today).days
    if delta < 0:
        return (f"已逾期 {abs(delta)} 天", "🔴")
    if delta == 0:
        return ("今天截止", "🟠")
    if delta == 1:
        return ("明天截止", "🟠")
    if delta <= 3:
        return (f"剩 {delta} 天", "🟡")
    return (f"剩 {delta} 天", "⚪")


def _deadline_text(item: dict[str, Any]) -> str:
    """截止时间列：绝对年月日（含时刻）优先，并保留正文的截止限定词（前 / 下班前 等）。"""
    d = item.get("deadline") or ""
    t = item.get("deadline_time") or ""
    lim = item.get("deadline_limiter") or ""
    if d:
        out = d
        if t:
            out += " " + t
        if lim:
            out += " " + lim
        return out
    raw = (item.get("deadline_text") or "").strip()
    return raw or "未写明"


_WEEKDAY_CN = ("一", "二", "三", "四", "五", "六", "日")


def _parse_start(item: dict[str, Any]) -> Optional[datetime]:
    start = item.get("meeting_start") or ""
    if not start:
        return None
    try:
        return datetime.fromisoformat(start)
    except ValueError:
        return None


def _meeting_date_text(item: dict[str, Any], today: date) -> str:
    dt = _parse_start(item)
    if dt is None:
        return "待定"
    base = dt.strftime("%Y-%m-%d")
    d = dt.date()
    monday = today - timedelta(days=today.weekday())
    if monday <= d <= monday + timedelta(days=6):
        hint = f"本周{_WEEKDAY_CN[d.weekday()]}"
    elif monday + timedelta(days=7) <= d <= monday + timedelta(days=13):
        hint = f"下周{_WEEKDAY_CN[d.weekday()]}"
    else:
        hint = ""
    return f"{base}（{hint}）" if hint else base


def _meeting_clock_text(item: dict[str, Any]) -> str:
    if item.get("all_day"):
        return "全天"
    dt = _parse_start(item)
    if dt is None:
        return ""
    half = "上午" if dt.hour < 12 else "下午"
    return f"{half} {dt.hour:02d}:{dt.minute:02d}"


def _meeting_time_text(item: dict[str, Any]) -> str:
    dt = _parse_start(item)
    if dt is None:
        return "待定"
    label = dt.strftime("%m-%d %H:%M")
    if item.get("all_day"):
        label = dt.strftime("%m-%d") + "（全天）"
    return label


_KNOWN_LOCATIONS = (
    ("闹市口", "闹市口/总部 807"),
    ("总部", "闹市口/总部 807"),
    ("东环", "东环 707"),
    ("ploymeet", "Ploymeet 2233"),
)
_TENCENT_DEFAULT_NO = "128282037307"


def _normalize_location(loc: str) -> str:
    """把邮件/日历里的地点原文归一到既定办公地点类型。"""
    if not loc:
        return ""
    low = loc.lower()
    if ("腾讯会议" in loc or "meeting.tencent" in low or "tencentmeeting" in low
            or "voovmeeting" in low):
        m = re.search(r"(\d{9,12})", loc)
        num = m.group(1) if m else _TENCENT_DEFAULT_NO
        return f"腾讯会议 {num}"
    for kw, name in _KNOWN_LOCATIONS:
        if kw in low:
            return name
    return "外部会议"


_FOLDER_CN = {"inbox": "收件箱", "sentitems": "已发送"}


def _fmt_day(value: str) -> str:
    raw = (value or "")[:10]
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", raw)
    if m:
        return f"{int(m.group(2))}-{int(m.group(3))}"
    return raw or "日期不明"


def _natural_sender(src: dict[str, Any]) -> str:
    label = (src.get("from") or "").strip()
    email = (src.get("from_email") or "").strip()
    name = ""
    m = re.match(r"^(.*?)\s*<([^>]+)>\s*$", label)
    if m:
        name = m.group(1).strip()
        if not email:
            email = m.group(2).strip()
    if not email:
        email = label
    if name:
        if name == email.split("@", 1)[0]:
            return email
        return f"{name}（{email}）"
    return email or "发件人不明"


def _fmt_day_full(value: str) -> str:
    raw = (value or "")[:10]
    if re.match(r"^\d{4}-\d{2}-\d{2}$", raw):
        return raw
    return raw or "日期不明"


def _source_text(item: dict[str, Any]) -> str:
    src = item.get("source") or {}
    if src.get("kind") == "mail":
        email = (src.get("from_email") or "").strip()
        day = _fmt_day_full(src.get("date") or "")
        return f"发件人：{email or '未知'}<br>时间：{day}"
    if src.get("kind") == "calendar":
        day = _fmt_day_full(src.get("date") or "") or _fmt_day_full(item.get("meeting_start") or "")
        return day
    return "手动添加"


def _feedback_text(item: dict[str, Any]) -> str:
    emails = item.get("feedback_to") or []
    names = item.get("feedback_names") or []
    parts = []
    if names:
        parts.append("、".join(names))
    if emails:
        parts.append("、".join(emails))
    text = " / ".join(parts) if parts else "未写明"
    if item.get("feedback_first_person"):
        text += "（发件人）"
    elif item.get("feedback_inferred"):
        text += "（默认回复发件人）"
    return text


def _decide_hint(item: dict[str, Any]) -> str:
    return f"回复「{item['short_id']} 参加」或「{item['short_id']} 不参加」"


def _attend_choice(item: dict[str, Any]) -> str:
    """「是否参加」列只有两种取值：待确认 / 确认参加。

    只有「别人发来、我还没点选」才算待确认；我发起的邀约、我自己建的日历、
    已点「参加」或已办完的会，都算确认参加（我必定参加）。「不参加」的会在
    visible_items 里已被移出，不在这里显示。
    """
    if item.get("needs_decision") and item.get("status", "pending") == "pending":
        return "待确认"
    return "确认参加"


def _attend_status(item: dict[str, Any]) -> str:
    """合并「角色 + 是否参加」为单列「参加状态」。

    我发起（含手动添加的会）→ 确认参加（本人发起）；
    别人通知我：未表态 → 待确认，已点/回执「参加」→ 已确认参加；
    「不参加」的会在 visible_items 里已移出，不在此显示。
    """
    role = item.get("meeting_role") or ""
    if role.startswith("我发起") or role == "手动添加":
        return "确认参加（本人发起）"
    if item.get("needs_decision") and item.get("status", "pending") == "pending":
        return "待确认"
    if item.get("status") == "accepted":
        return "已确认参加"
    return "确认参加"


def visible_items(state: dict[str, Any], *, status: str = "active",
                  tag: str = "", include_past: bool = False,
                  ref: Optional[datetime] = None) -> list[dict[str, Any]]:
    ref_dt = ref or common.local_now()
    today = ref_dt.date()
    out: list[dict[str, Any]] = []
    for item in state.get("items", []):
        st = item.get("status", "pending")
        if status == "active" and st in ("declined", "done"):
            continue
        if st == "declined":
            # 不参加的会议直接从清单移除，只在 declined_keys 里留痕防复活
            continue
        if status not in ("active", "all") and st != status:
            continue
        if tag and item.get("tag") != tag:
            continue
        if not include_past and item.get("tag") == TAG_MEETING and item.get("meeting_start"):
            try:
                end = datetime.fromisoformat(item["meeting_start"])
                if item.get("meeting_end"):
                    end = datetime.fromisoformat(item["meeting_end"])
                if end.date() < today - timedelta(days=1):
                    continue
            except ValueError:
                pass
        out.append(item)

    def sort_key(it):
        primary = it.get("deadline") or (it.get("meeting_start") or "")[:10]
        overdue = 0
        if it.get("deadline"):
            try:
                if date.fromisoformat(it["deadline"]) < today:
                    overdue = -1
            except ValueError:
                pass
        return (overdue, primary or "9999-12-31", it.get("title", ""))

    out.sort(key=sort_key)
    return out


def render_list(state: dict[str, Any], items: list[dict[str, Any]],
                title: str = "待反馈清单", ref: Optional[datetime] = None) -> str:
    ref_dt = ref or common.local_now()
    today = ref_dt.date()
    todo_rows = [i for i in items if i["tag"] in (TAG_TODO, TAG_TODO_PLAIN)]
    plain_rows = [i for i in items if i["tag"] == TAG_TODO_PLAIN]
    fb_rows = [i for i in items if i["tag"] == TAG_TODO]
    meeting_rows = [i for i in items if i["tag"] == TAG_MEETING]
    pending_decisions = [i for i in meeting_rows if i.get("needs_decision")
                         and i.get("status", "pending") == "pending"]

    lines = [f"# 📋 {title}", ""]
    lines.append(f"- 统计：🟩 一般待办 {len(plain_rows)} 条 · 🟧 待反馈 {len(fb_rows)} 条 · 🟦 会议 {len(meeting_rows)} 条"
                 f" · 待你确认 {len(pending_decisions)} 场")
    lines.append("- 标签：🟩 一般待办（有截止、无需反馈）｜ 🟧 待反馈（有截止、要向人反馈）｜ 🟦 会议（要开会/被邀请参会）")

    if not items:
        lines += ["", "清单为空：近段时间没有识别到待反馈或会议类邮件/日程。"]
        return "\n".join(lines) + "\n"

    # ---------------- 表一：待办（一般待办 + 待反馈） ----------------
    lines += ["", f"## 📋 待办（{len(todo_rows)} 条）", ""]
    if todo_rows:
        lines.append("| # | 事件 | 截止时间 | 类型 | 反馈对象 | 来源 |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for item in todo_rows:
            event_text = item.get("summary") or item.get("title") or ""
            kind_text = "🟧 待反馈" if item["tag"] == TAG_TODO else "🟩 一般待办"
            fb_text = _feedback_text(item) if item["tag"] == TAG_TODO else "-"
            lines.append(
                f"| {item['short_id']} | {common.short_text(event_text, 34)} "
                f"| {common.short_text(_deadline_text(item), 30)} "
                f"| {kind_text} "
                f"| {common.short_text(fb_text, 32)} "
                f"| {_source_text(item)} |")
    else:
        lines.append("（暂无）")

    # ---------------- 表二：会议 ----------------
    lines += ["", f"## 🟦 会议（{len(meeting_rows)} 条）", ""]
    if meeting_rows:
        lines.append("| # | 会议 | 会议时间 | 地点 | 参加状态 | 会议来源 |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for item in meeting_rows:
            date_text = _meeting_date_text(item, today)
            clock = _meeting_clock_text(item)
            when = f"{date_text}<br>{clock}" if clock else date_text
            loc = _normalize_location(item.get("location") or "") or "-"
            lines.append(
                f"| {item['short_id']} | {common.short_text(item.get('title') or '', 28)} "
                f"| {when} | {common.short_text(loc, 22)} "
                f"| {_attend_status(item)} | {_source_text(item)} |")
    else:
        lines.append("（暂无）")

    if pending_decisions:
        lines += ["", "## 待你确认是否参加的会议", "",
                  "在「参加状态」列对应的是「待确认」，回复选择后我会立刻更新表单：",
                  "`<编号> 参加` → 参加状态变为「已确认参加」· `<编号> 不参加` → 从表单移除。", ""]
        for item in pending_decisions[:10]:
            lines.append(f"- `{item['short_id']}` {_meeting_time_text(item)} "
                         f"{common.short_text(item.get('title') or '', 34)}"
                         f"（{item.get('meeting_role') or '他人通知我'}） → {_decide_hint(item)}")

    done_like = [i for i in items if i["tag"] in (TAG_TODO, TAG_TODO_PLAIN) and i.get("status") == "done"]
    if done_like:
        lines += ["", "## 已完成（待办）", ""]
        for item in done_like[:10]:
            emoji = "🟧" if item["tag"] == TAG_TODO else "🟩"
            lines.append(f"- {emoji} {common.short_text(item.get('summary') or item.get('title') or '', 40)}"
                         f"（已完成）")

    lines += ["", "> 说明：本清单由技能按规则抽取，不代替你判断。待反馈的「事件」取自正文要求句，"
                  "抽不出时退回邮件主题；「来源 / 会议来源」列：邮件写发件人与时间，日程写日期，方便回溯定位。"]
    return "\n".join(lines) + "\n"


def render_scan_result(items: list[dict[str, Any]], stats: dict[str, Any],
                       started: str, saved: bool,
                       state: dict[str, Any], ref: Optional[datetime] = None) -> str:
    head = [f"# 🔎 待办扫描（{started}）", ""]
    todo_n = len([i for i in items if i["tag"] in (TAG_TODO, TAG_TODO_PLAIN)])
    plain_n = len([i for i in items if i["tag"] == TAG_TODO_PLAIN])
    fb_n = len([i for i in items if i["tag"] == TAG_TODO])
    meet_n = len([i for i in items if i["tag"] == TAG_MEETING])
    head.append(f"- 命中：🟩 一般待办 {plain_n} 条 · 🟧 待反馈 {fb_n} 条 · 🟦 会议 {meet_n} 条")
    head.append(f"- 扫描范围：近 {stats.get('mail_days', '')} 天邮件（读全文 {stats.get('mail_detail_fetched', 0)} 封）"
                f" + 日历 {stats.get('calendar_scanned', 0)} 个事件")
    if stats.get("skipped"):
        head.append("- 跳过：" + "；".join(stats["skipped"]))
    if saved:
        head.append("- 已并入清单；会议确认后再决定是否保留")
    else:
        head.append("- 本次仅预览，未写入清单（加 --save 可写入）")
    head += ["", render_list(state, items, "扫描结果", ref)]
    return "\n".join(head)
