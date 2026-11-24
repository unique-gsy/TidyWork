#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - CLI 入口（对标京东 soap_mail_cli.py）。

子命令名、参数名、默认时间窗、Markdown 渲染与京东保持一致；后端换芯为 QQ IMAP/SMTP。
写操作（发送/回复/转发/标记/移动/删除/新建文件夹）与京东一样由 SKILL.md 约束
「调用前先向用户确认」，CLI 本身直接执行。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, date, time
from pathlib import Path
from typing import Any

import qqmail_common as common
from qqmail_core import QQMailClient
from qqmail_caldav import CalDAVClient
import qqmail_agenda as agenda
import icalendar as ical


# ---------------------------------------------------------------------------
# 输出 / 基础工具（复刻京东 soap_mail_cli 的渲染）
# ---------------------------------------------------------------------------

def output_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def parse_email_list(raw: str) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def parse_paths(raw: str) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def read_text(value: str) -> str:
    """正文支持：@路径 读文件，或 - 从 stdin 读（避免 Windows 长文本/引号问题）。"""
    if value == "-":
        return sys.stdin.read()
    if value.startswith("@"):
        return Path(value[1:]).expanduser().read_text(encoding="utf-8")
    return value


def _short_text(value: str, limit: int = 36) -> str:
    text = " ".join((value or "").split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def _readable_sender(item: dict[str, Any]) -> str:
    sender = item.get("from") or item.get("sender") or {}
    name = (sender.get("name") or "").strip()
    email = (sender.get("email") or "").strip()
    if name and email:
        return f"{name} <{email}>"
    return name or email or "-"


def _status_text(item: dict[str, Any]) -> str:
    flags = ["未读" if not item.get("is_read", False) else "已读"]
    if item.get("has_attachments"):
        flags.append("有附件")
    importance = (item.get("importance") or "").strip()
    if importance:
        flags.append(f"重要级别:{importance}")
    categories = item.get("categories") or []
    if categories:
        flags.append("标签:" + ",".join(categories[:3]))
    return " / ".join(flags)


def _status_icon(item: dict[str, Any]) -> str:
    if not item.get("is_read", False):
        if (item.get("importance") or "").lower() == "high":
            return "🚨"
        if item.get("has_attachments"):
            return "📎"
        return "📩"
    if item.get("has_attachments"):
        return "📬"
    return "✅"


def _importance_icon(item: dict[str, Any]) -> str:
    importance = (item.get("importance") or "").lower()
    if importance == "high":
        return "🔥"
    if importance == "low":
        return "🫧"
    return "•"


def _folder_icon(folder_name: str) -> str:
    name = (folder_name or "").lower()
    if "inbox" in name or "收件" in name:
        return "📥"
    if "sent" in name or "发件" in name:
        return "📤"
    if "draft" in name or "草稿" in name:
        return "📝"
    if "deleted" in name or "trash" in name or "已删除" in name:
        return "🗑️"
    if "junk" in name or "垃圾" in name:
        return "🚫"
    return "📁"


def _collect_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(payload.get("items"), list):
        return payload["items"]
    if isinstance(payload.get("item"), dict):
        return [payload["item"]]
    return []


def _summary_stats(items: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(items),
        "unread": sum(1 for item in items if not item.get("is_read", False)),
        "attachments": sum(1 for item in items if item.get("has_attachments")),
        "high_importance": sum(1 for item in items if (item.get("importance") or "").lower() == "high"),
    }


def _markdown_table(items: list[dict[str, Any]], max_rows: int = 12) -> str:
    header = "| 状态 | 时间 | 发件人 | 主题 | 文件夹 |"
    sep = "| --- | --- | --- | --- | --- |"
    rows = [header, sep]
    for item in items[:max_rows]:
        rows.append(
            "| "
            + " | ".join(
                [
                    _short_text(f"{_status_icon(item)} {_importance_icon(item)} {_status_text(item)}", 36),
                    _short_text(item.get("date_time_received") or item.get("date_time_sent") or "-", 19),
                    _short_text(_readable_sender(item), 24),
                    _short_text(item.get("subject") or "-", 28),
                    _short_text(f"{_folder_icon(item.get('folder') or '')} {item.get('folder') or '-'}", 18),
                ]
            )
            + " |"
        )
    if len(items) > max_rows:
        rows.append(f"| … | … | … | 仅展示前 {max_rows} 行（共 {len(items)} 封） | … |")
    return "\n".join(rows)


def build_markdown_result_view(title: str, payload: dict[str, Any], max_rows: int = 12) -> str:
    items = _collect_items(payload)
    stats = _summary_stats(items)
    lines = [
        f"# 📬 {title}",
        "",
        f"- 📊 总数：{stats['total']}",
        f"- 📩 未读：{stats['unread']}",
        f"- 📎 含附件：{stats['attachments']}",
        f"- 🔥 高优先级：{stats['high_importance']}",
        "",
        "## 📋 邮件列表",
        "",
        _markdown_table(items, max_rows=max_rows) if items else "_暂无邮件_",
    ]
    return "\n".join(lines) + "\n"


def _render_attachment_list_lines(attachments: list[dict[str, Any]], *, title: str = "## 📎 附件") -> list[str]:
    if not attachments:
        return []
    lines = [title, "", f"- 附件总数：{len(attachments)}", "",
             "| 序号 | 文件名 | 大小(Byte) | 类型 |", "| --- | --- | --- | --- |"]
    for idx, att in enumerate(attachments[:20], start=1):
        lines.append(
            "| "
            + " | ".join([
                str(idx),
                _short_text(att.get("name") or "-", 40),
                str(att.get("size") or 0),
                _short_text(att.get("content_type") or "-", 30),
            ])
            + " |"
        )
    if len(attachments) > 20:
        lines.append(f"| … | 仅展示前 20 项（共 {len(attachments)} 项） | … | … |")
    return lines


def build_detail_markdown(payload: dict[str, Any]) -> str:
    item = payload.get("item") or {}
    sender = item.get("from") or {}
    lines = [
        "# 📧 邮件详情",
        "",
        f"**主题：** {item.get('subject') or '(无主题)'}",
        "",
        f"- 发件人：{_readable_sender(item)}",
        f"- 收件人：{item.get('display_to') or '-'}",
        f"- 抄送：{item.get('display_cc') or '-'}",
        f"- 时间：{item.get('date_time_received') or item.get('date_time_sent') or '-'}",
        f"- 状态：{_status_text(item)}",
        f"- 邮件 ID（UID）：{item.get('item_id') or '-'}",
        f"- 所在文件夹：{item.get('folder') or '-'}",
        "",
        "## 📝 正文",
        "",
        item.get("body_text") or "（无纯文本正文）",
        "",
    ]
    attachments = item.get("attachments") or []
    if attachments:
        lines += _render_attachment_list_lines(attachments, title="## 📎 附件列表")
    else:
        lines += ["## 📎 附件列表", "", "_无附件_"]
    return "\n".join(lines) + "\n"


def build_folders_markdown(payload: dict[str, Any]) -> str:
    folders = payload.get("folders") or []
    lines = ["# 📁 文件夹列表", "", f"- 文件夹总数：{len(folders)}", "",
             "| 文件夹 | 类型 | 总数 | 未读 |", "| --- | --- | --- | --- |"]
    for folder in folders:
        logical = folder.get("folder_class") or "usercreated"
        lines.append("| " + " | ".join([
            _short_text(f"{_folder_icon(folder.get('display_name'))} {folder.get('display_name')}", 30),
            logical,
            str(folder.get("total_count", 0)),
            str(folder.get("unread_count", 0)),
        ]) + " |")
    return "\n".join(lines) + "\n"


def build_daily_stats_markdown(payload: dict[str, Any]) -> str:
    rows = payload.get("daily_stats") or []
    totals = payload.get("totals") or {}
    lines = [
        "# 📅 邮件按天统计",
        "",
        f"- 时间范围：{payload.get('after')} 至 {payload.get('before')}",
        f"- 总邮件数：{totals.get('total', payload.get('total_count', 0))}",
        f"- 日均：{totals.get('avg_per_day', '-')}",
        "",
    ]
    if not rows:
        lines.append("_该时间范围内没有邮件_")
        return "\n".join(lines) + "\n"
    lines += ["| 日期 | 星期 | 邮件总数 | 未读数 | 已读数 |",
              "| --- | --- | --- | --- | --- |"]
    for row in rows:
        lines.append("| " + " | ".join([
            row.get("date_label") or row.get("date") or "-",
            row.get("weekday") or "-",
            str(row.get("total", 0)),
            str(row.get("unread", 0)),
            str(row.get("read", 0)),
        ]) + " |")
    return "\n".join(lines) + "\n"


def _action_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        item for item in items
        if (not item.get("is_read", False))
        and (
            item.get("has_attachments")
            or (item.get("importance") or "").lower() == "high"
            or any(tag in "".join(item.get("categories") or []).lower()
                   for tag in ("重要", "urgent", "待办", "vip", "important"))
        )
    ]


def build_markdown_summary(payload: dict[str, Any], max_rows: int = 12) -> str:
    items = _collect_items(payload)
    stats = _summary_stats(items)
    title = payload.get("summary_title") or payload.get("folder") or "邮件总结"
    lines = [
        f"# 📬 {title} 总结",
        "",
        f"- 📊 总数：{stats['total']}",
        f"- 📩 未读：{stats['unread']}",
        f"- 📎 含附件：{stats['attachments']}",
        f"- 🔥 高优先级：{stats['high_importance']}",
        "",
        "## 📋 总览表",
        "",
        _markdown_table(items, max_rows=max_rows) if items else "_暂无邮件_",
    ]
    action_needed = _action_items(items)
    if action_needed:
        lines += ["", "## ⚠️ 建议优先处理", "",
                  _markdown_table(action_needed, max_rows=min(max_rows, 8))]
    if items:
        lines += ["", "## 👀 简要观察", ""]
        if stats["unread"]:
            lines.append(f"- 未读邮件有 {stats['unread']} 封，建议优先处理表格中的未读项。")
        if stats["attachments"]:
            lines.append(f"- 含附件邮件有 {stats['attachments']} 封，适合优先关注需要下载或审阅材料的邮件。")
        if stats["high_importance"]:
            lines.append(f"- 高优先级邮件有 {stats['high_importance']} 封，建议尽快确认是否需要回复。")
        top_subjects = [item.get("subject") for item in items[:3] if item.get("subject")]
        if top_subjects:
            lines.append("- 近期主题重点：" + "；".join(top_subjects))
    return "\n".join(lines) + "\n"


def build_recipient_lookup_markdown(payload: dict[str, Any], max_rows: int = 10) -> str:
    contacts = payload.get("contacts") or []
    lines = [
        f"# 👥 联系人查询：{payload.get('condition') or ''}",
        "",
        f"- 匹配数：{payload.get('count', 0)}（来自近 30 天往来邮件）",
        "",
    ]
    if not contacts:
        lines.append("_未查询到匹配联系人_")
        return "\n".join(lines) + "\n"
    lines += ["| 序号 | 姓名 | 邮箱 | 来源 |", "| --- | --- | --- | --- |"]
    for idx, contact in enumerate(contacts[:max_rows], start=1):
        lines.append("| " + " | ".join([
            str(idx),
            _short_text(contact.get("display_name") or "-", 18),
            _short_text(contact.get("email") or "-", 30),
            contact.get("source") or "recent_mail",
        ]) + " |")
    return "\n".join(lines) + "\n"


def build_write_markdown(payload: dict[str, Any], title: str) -> str:
    icon = "✅" if payload.get("success") else "❌"
    lines = [f"# {icon} {title}", ""]
    if payload.get("action"):
        lines.append(f"- 操作类型：{payload['action']}")
    if payload.get("count") is not None:
        lines.append(f"- 处理数量：{payload['count']}")
    for label, key in (("收件人", "to"), ("抄送", "cc"), ("主题", "subject"),
                       ("标签", "category"), ("目标文件夹", "target_folder"),
                       ("删除类型", "delete_type"), ("保存路径", "saved_path"),
                       ("Message-ID", "message_id")):
        value = payload.get(key)
        if value:
            lines.append(f"- {label}：{value}")
    if payload.get("note"):
        lines += ["", f"> ⚠️ {payload['note']}"]
    if payload.get("items"):
        lines += ["", "## 明细", "", _markdown_table(payload["items"], max_rows=12)]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 日程（CalDAV）渲染
# ---------------------------------------------------------------------------

def _event_time_range(ev) -> str:
    if ev.all_day:
        return f"{ev.start}（全天）"
    s = common.to_local(ev.start)
    e = common.to_local(ev.end)
    if s.date() == e.date():
        return f"{s.strftime('%Y-%m-%d %H:%M')}–{e.strftime('%H:%M')}"
    return f"{s.strftime('%Y-%m-%d %H:%M')}–{e.strftime('%Y-%m-%d %H:%M')}"


def _alarm_label(ev) -> str:
    if not ev.alarms_minutes:
        return "无"
    parts = []
    for m in sorted(set(ev.alarms_minutes)):
        if m % (60 * 24) == 0:
            parts.append(f"提前{m // (60 * 24)}天")
        elif m % 60 == 0:
            parts.append(f"提前{m // 60}小时")
        else:
            parts.append(f"提前{m}分钟")
    return "、".join(parts)


def build_calendars_markdown(cals: list) -> str:
    lines = ["# 🗓️ 日历列表", "", f"- 日历总数：{len(cals)}", "",
             "| 序号 | 日历名称 | 支持组件 | 路径 |", "| --- | --- | --- | --- |"]
    for idx, c in enumerate(cals, 1):
        lines.append("| " + " | ".join([
            str(idx),
            _short_text(c.display_name, 24),
            ",".join(c.components) or "-",
            _short_text(c.href, 40),
        ]) + " |")
    return "\n".join(lines) + "\n"


def build_events_markdown(title: str, events: list, range_label: str,
                          max_rows: int = 20) -> str:
    lines = [
        f"# 🗓️ {title}",
        "",
        f"- 时间范围：{range_label}",
        f"- 日程总数：{len(events)}",
        "",
        "| 序号 | 时间 | 标题 | 地点 | 提醒 |",
        "| --- | --- | --- | --- | --- |",
    ]
    if not events:
        lines.append("_该时间范围内暂无日程_")
        return "\n".join(lines) + "\n"
    # 按开始时间升序
    ordered = sorted(events, key=lambda e: (e.all_day, e.start or 0))
    for idx, ev in enumerate(ordered[:max_rows], 1):
        lines.append("| " + " | ".join([
            str(idx),
            _short_text(_event_time_range(ev), 24),
            _short_text(ev.summary or "(无标题)", 28),
            _short_text(ev.location or "-", 16),
            _short_text(_alarm_label(ev), 16),
        ]) + " |")
    if len(ordered) > max_rows:
        lines.append(f"| … | … | 仅展示前 {max_rows} 条（共 {len(ordered)} 条） | … | … |")
    return "\n".join(lines) + "\n"


def build_event_detail_markdown(ev) -> str:
    lines = [
        "# 📅 日程详情",
        "",
        f"**标题：** {ev.summary or '(无标题)'}",
        "",
        f"- 时间：{_event_time_range(ev)}",
        f"- 地点：{ev.location or '-'}",
        f"- 提醒：{_alarm_label(ev)}",
        f"- 组织者：{ev.organizer or '-'}",
        f"- 参与人：{', '.join(ev.attendees) if ev.attendees else '-'}",
        f"- 状态：{ev.status or '-'}",
        f"- UID：{ev.uid}",
        f"- 路径：{ev.href or '-'}",
        "",
        "## 📝 描述",
        "",
        ev.description or "（无描述）",
        "",
    ]
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------

def get_client(args: argparse.Namespace) -> QQMailClient:
    cfg = common.load_config(getattr(args, "config", "") or None)
    return QQMailClient(cfg)


def get_caldav_client(args: argparse.Namespace) -> CalDAVClient:
    cfg = common.load_config(getattr(args, "config", "") or None)
    return CalDAVClient(cfg)


def normalize_delete_type(value: str) -> str:
    v = (value or "").strip().lower().replace("_", "").replace("-", "")
    if v in ("harddelete", "permanentdelete", "permanent"):
        return "hard_delete"
    return "move_to_deleted_items"


def cmd_folders(args: argparse.Namespace) -> None:
    client = get_client(args)
    folders = client.list_folders()
    payload = {"success": True, "folders": folders}
    if args.format == "json":
        return output_json(payload)
    print(build_folders_markdown(payload), end="")


def cmd_create_folder(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.create_folder(args.display_name)
    payload = {"success": True, "action": "create_folder", "count": 1,
               "display_name": res["display_name"], "folder_class": "usercreated",
               "folder": {"id": res["id"]}}
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "创建文件夹结果"), end="")


def _build_filters(args: argparse.Namespace) -> common.MailSearchFilters:
    return common.MailSearchFilters(
        sender=args.sender, recipient=args.recipient, subject=args.subject,
        body_keyword=args.body_keyword, after=args.after, before=args.before,
        unread_only=args.unread, read_only=args.read,
        has_attachments=args.has_attachments, category=args.category,
        importance=args.importance,
    )


def cmd_search(args: argparse.Namespace) -> None:
    client = get_client(args)
    items = client.search_items(args.folder, _build_filters(args),
                                limit=args.limit, page_size=100,
                                max_pages=args.max_pages)
    payload = {"success": True, "folder": args.folder, "items": items}
    if args.format == "json":
        return output_json(payload)
    print(build_markdown_result_view(f"{args.folder} 查询结果", payload, max_rows=args.max_rows), end="")


def cmd_detail(args: argparse.Namespace) -> None:
    client = get_client(args)
    item = client.get_item_detail(args.item_id, args.folder)
    payload = {"success": True, "item": item}
    if args.format == "json":
        return output_json(payload)
    print(build_detail_markdown(payload), end="")


def cmd_attachment_check(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.attachment_check(args.item_id, args.folder)
    payload = {"success": True, **res}
    if args.format == "json":
        return output_json(payload)
    lines = [f"# 📎 附件检查：{res.get('subject') or res.get('item_id')}", ""]
    if not res.get("attachments"):
        lines.append("_无附件_")
    else:
        lines += _render_attachment_list_lines(res["attachments"])
    print("\n".join(lines) + "\n", end="")


def cmd_download_attachment(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.download_attachment(args.item_id, args.attachment_index,
                                     args.folder, args.out_dir or "")
    payload = {"success": True, "action": "download_attachment", "count": 1,
               "saved_path": res["saved_path"], "subject": res["name"]}
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "附件下载结果"), end="")


def cmd_send(args: argparse.Namespace) -> None:
    client = get_client(args)
    attachments = parse_paths(args.attachments)
    res = client.send_mail(
        to_raw=args.to_recipients, subject=args.subject, body=read_text(args.body),
        cc_raw=args.cc_recipients, bcc_raw=args.bcc_recipients,
        body_type=args.body_type, attachments=attachments, importance=args.importance,
    )
    payload = {"success": True, "action": "send",
               "to": ", ".join(res["to"]), "cc": ", ".join(res["cc"]),
               "subject": res["subject"], "message_id": res["message_id"]}
    if res["bcc_count"]:
        payload["cc"] = (payload["cc"] + f"（另密送 {res['bcc_count']} 人）").strip()
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "发送邮件结果"), end="")


def cmd_reply(args: argparse.Namespace) -> None:
    client = get_client(args)
    attachments = parse_paths(args.attachments)
    res = client.reply_mail(
        item_id=args.item_id, body=read_text(args.body), folder=args.folder,
        reply_all=args.reply_all, cc_raw=args.cc or "", bcc_raw=args.bcc or "",
        body_type=args.body_type, with_quote=args.include_original,
        attachments=attachments, importance=args.importance,
    )
    payload = {"success": True, "action": "reply_all" if args.reply_all else "reply",
               "to": ", ".join(res["to"]), "cc": ", ".join(res["cc"]),
               "subject": res["subject"], "message_id": res["message_id"]}
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "回复邮件结果"), end="")


def cmd_forward(args: argparse.Namespace) -> None:
    client = get_client(args)
    attachments = parse_paths(args.attachments)
    res = client.forward_mail(
        item_id=args.item_id, to_raw=args.to_recipients, body=read_text(args.body),
        folder=args.folder, cc_raw=args.cc_recipients or "", bcc_raw=args.bcc_recipients or "",
        body_type=args.body_type, attachments=attachments,
    )
    payload = {"success": True, "action": "forward",
               "to": ", ".join(res["to"]), "cc": ", ".join(res["cc"]),
               "subject": res["subject"], "message_id": res["message_id"]}
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "转发邮件结果"), end="")


def cmd_daily_stats(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.daily_stats(args.folder, days=args.days, after=args.after, before=args.before)
    payload = {"success": True, "daily_stats": res["days"], "totals": res["totals"],
               "after": res["range"]["after"], "before": res["range"]["before"],
               "total_count": res["totals"]["total"]}
    if args.format == "json":
        return output_json(payload)
    print(build_daily_stats_markdown(payload), end="")


def cmd_pending_important(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.pending_important(args.folder, days=args.days)
    items = res["items"][:args.limit]
    payload = {"success": True, "folder": args.folder, "items": items}
    if args.format == "json":
        return output_json(payload)
    print(build_markdown_result_view("最近重要未回复邮件", payload, max_rows=args.max_rows), end="")


def cmd_person_unhandled(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.person_unhandled(args.sender, args.folder, days=args.days)
    items = res["items"][:args.limit]
    payload = {"success": True, "folder": args.folder, "items": items}
    if args.format == "json":
        return output_json(payload)
    print(build_markdown_result_view(f"{args.sender} 未处理邮件", payload, max_rows=args.max_rows), end="")


def cmd_lookup_recipient(args: argparse.Namespace) -> None:
    client = get_client(args)
    condition = args.condition or args.name or ""
    if not condition:
        raise common.QQMailError("lookup-recipient 需要 --condition 或 --name")
    res = client.lookup_recipient(condition, limit=args.page_size)
    payload = {"success": True, **res}
    if args.format == "json":
        return output_json(payload)
    print(build_recipient_lookup_markdown(payload, max_rows=args.max_rows), end="")


def _simple_batch(args: argparse.Namespace, result: dict[str, Any], action: str, title: str,
                  extra: dict[str, Any] | None = None) -> None:
    payload = {"success": True, "action": action, "count": result.get("updated", result.get("moved", result.get("deleted", 0)))}
    if extra:
        payload.update(extra)
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, title), end="")


def cmd_mark_read(args: argparse.Namespace) -> None:
    client = get_client(args)
    _simple_batch(args, client.mark_read(args.item_ids, args.folder), "mark_read", "批量标记已读结果")


def cmd_mark_unread(args: argparse.Namespace) -> None:
    client = get_client(args)
    _simple_batch(args, client.mark_unread(args.item_ids, args.folder), "mark_unread", "批量标记未读结果")


def cmd_add_category(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.add_category(args.item_ids, args.category, args.folder)
    _simple_batch(args, res, "add_category", "批量打标签结果", {"category": args.category})


def cmd_flag(args: argparse.Namespace) -> None:
    client = get_client(args)
    _simple_batch(args, client.flag_items(args.item_id, args.folder), "flag", "旗标邮件结果")


def cmd_unflag(args: argparse.Namespace) -> None:
    client = get_client(args)
    _simple_batch(args, client.unflag_items(args.item_id, args.folder), "unflag", "取消旗标结果")


def cmd_batch_flag(args: argparse.Namespace) -> None:
    client = get_client(args)
    _simple_batch(args, client.flag_items(args.item_ids, args.folder), "flag", "批量旗标邮件结果")


def cmd_batch_unflag(args: argparse.Namespace) -> None:
    client = get_client(args)
    _simple_batch(args, client.unflag_items(args.item_ids, args.folder), "unflag", "批量取消旗标结果")


def cmd_move(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.move_items(args.item_ids, args.target_folder, args.folder)
    _simple_batch(args, res, "move", "批量移动邮件结果",
                  {"target_folder": res.get("target_folder_id")})


def cmd_delete(args: argparse.Namespace) -> None:
    client = get_client(args)
    delete_type = normalize_delete_type(args.delete_type)
    res = client.delete_items(args.item_ids, args.folder, delete_type=delete_type)
    _simple_batch(args, res, "delete", "批量删除邮件结果",
                  {"delete_type": res.get("delete_type")})


def cmd_self_check(args: argparse.Namespace) -> None:
    client = get_client(args)
    res = client.self_check()
    cfg = common.load_config(getattr(args, "config", "") or None)
    caldav_enabled = bool(cfg.caldav_enabled)
    caldav_status = {"ok": False, "host": "dav.qq.com", "calendar_count": 0,
                     "enabled": caldav_enabled, "msg": ""}
    if caldav_enabled:
        try:
            cals = get_caldav_client(args).list_calendars()
            caldav_status["ok"] = True
            caldav_status["calendar_count"] = len(cals)
        except Exception as exc:  # noqa: BLE001
            caldav_status["msg"] = str(exc)
    res["caldav"] = caldav_status
    all_ok = res["imap"]["ok"] and res["smtp"]["ok"] and (
        caldav_status["ok"] if caldav_enabled else True)
    payload = {"success": bool(all_ok), **res}
    if args.format == "json":
        return output_json(payload)
    if caldav_status["ok"]:
        caldav_text = f"✅ 正常（{caldav_status['calendar_count']} 个日历）"
    elif caldav_enabled:
        caldav_text = "❌ 失败 " + caldav_status["msg"]
    else:
        caldav_text = "⚪ 未启用"
    lines = [
        "# 🔌 连接自检", "",
        f"- 账号：{res['email']}",
        f"- IMAP（{res['imap']['host']}:{res['imap']['port']}）：{'✅ 正常' if res['imap']['ok'] else '❌ 失败'}",
        f"- SMTP（{res['smtp']['host']}:{res['smtp']['port']}）：{'✅ 正常' if res['smtp']['ok'] else '❌ 失败'}",
        f"- CalDAV（dav.qq.com）：{caldav_text}",
        f"- 文件夹数量：{res['folder_count']}",
        f"- 识别到的系统文件夹：{res['special_folders']}",
    ]
    print("\n".join(lines) + "\n")


def cmd_summarize(args: argparse.Namespace) -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        raise common.QQMailError("summarize 需要从 stdin 读取 JSON")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise common.QQMailError(f"stdin 不是合法 JSON：{exc}") from exc
    items = _collect_items(payload)
    stats = _summary_stats(items)
    summary = {
        "success": True,
        "summary_title": payload.get("summary_title") or payload.get("folder") or "邮件总结",
        "folder": payload.get("folder") or "邮件总结",
        "stats": stats,
        "items": items,
        "action_needed": _action_items(items),
    }
    if args.format == "json":
        return output_json(summary)
    print(build_markdown_summary(summary, max_rows=args.max_rows), end="")


# ---------------------------------------------------------------------------
# 日程（CalDAV）命令
# ---------------------------------------------------------------------------

def _parse_event_time(value: str):
    """完整时间 -> datetime；只给日期 -> date（全天）。"""
    dt = common.parse_date_boundary(value)
    if dt is None:
        raise common.QQMailError(
            f"无法解析时间：{value}（应为 YYYY-MM-DD 或 'YYYY-MM-DD HH:MM'）")
    if not common.has_explicit_time(value):
        return dt.date()
    return dt


def _parse_reminders(value: str) -> list[int]:
    if not value:
        return []
    out = []
    for item in value.split(","):
        item = item.strip()
        if item:
            out.append(int(item))
    return out


def _prep_alarms(value: str):
    """QQ 每个事件只保留一个提醒：取第一个；多个时返回提示。"""
    alarms = _parse_reminders(value)
    note = ""
    if len(alarms) > 1:
        note = f"QQ 日程每个事件仅支持一个提醒，已采用第一个（提前{alarms[0]}分钟）"
        alarms = alarms[:1]
    return alarms, note


def _event_to_dict(ev) -> dict[str, Any]:
    def ts(x):
        if isinstance(x, datetime):
            return common.local_iso(x)
        return str(x) if x else ""
    return {
        "uid": ev.uid, "summary": ev.summary, "all_day": ev.all_day,
        "start": ts(ev.start), "end": ts(ev.end),
        "location": ev.location, "description": ev.description,
        "organizer": ev.organizer, "attendees": ev.attendees,
        "alarms_minutes": ev.alarms_minutes, "status": ev.status,
        "href": ev.href,
    }


def _parsed_to_data(ev) -> ical.EventData:
    return ical.EventData(
        uid=ev.uid, summary=ev.summary, start=ev.start, end=ev.end,
        all_day=ev.all_day, description=ev.description, location=ev.location,
        status=ev.status, organizer=ev.organizer, attendees=ev.attendees,
        alarms_minutes=ev.alarms_minutes,
    )


def cmd_calendars(args: argparse.Namespace) -> None:
    cli = get_caldav_client(args)
    cals = cli.list_calendars()
    if args.format == "json":
        return output_json({"success": True,
                            "calendars": [vars(c) for c in cals]})
    print(build_calendars_markdown(cals), end="")


def _event_range(args):
    tz = common.effective_local_tz()
    now = datetime.now(tz)
    if args.start:
        start = common.parse_date_boundary(args.start)
        if not common.has_explicit_time(args.start):
            start = datetime.combine(start.date(), time.min, tz)
    else:
        start = datetime.combine(now.date(), time.min, tz)
    if args.end:
        end = common.parse_date_boundary(args.end, end_of_day=True)
    else:
        end = datetime.combine(start.date(), time.min, tz) + timedelta(days=args.days)
    return start, end


def cmd_list_events(args: argparse.Namespace) -> None:
    cli = get_caldav_client(args)
    cal_href = cli.resolve_calendar(args.calendar)
    start, end = _event_range(args)
    events = cli.query_events(cal_href, start, end)
    range_label = f"{start.strftime('%Y-%m-%d')} 至 {end.strftime('%Y-%m-%d')}"
    if args.format == "json":
        return output_json({"success": True, "calendar": cal_href,
                            "range": [common.local_iso(start), common.local_iso(end)],
                            "events": [_event_to_dict(e) for e in events]})
    title = f"日程（{args.calendar or '日历'}）"
    print(build_events_markdown(title, events, range_label,
                                max_rows=args.max_rows), end="")


def _build_event_data(args, start, end, all_day, uid, attendees, alarms,
                      description, organizer=""):
    return ical.EventData(
        uid=uid, summary=args.title, start=start, end=end, all_day=all_day,
        description=description, location=args.location or "",
        organizer=organizer, attendees=attendees, alarms_minutes=alarms)


def cmd_create_event(args: argparse.Namespace) -> None:
    cli = get_caldav_client(args)
    cfg = common.load_config(getattr(args, "config", "") or None)
    cal_href = cli.resolve_calendar(args.calendar)
    start = _parse_event_time(args.start)
    all_day = bool(args.all_day) or isinstance(start, date) and not isinstance(start, datetime)
    if all_day:
        start = start if isinstance(start, date) and not isinstance(start, datetime) else start.date()
        if args.end:
            end_parsed = _parse_event_time(args.end)
            end = end_parsed if isinstance(end_parsed, date) and not isinstance(end_parsed, datetime) else start + timedelta(days=1)
        else:
            end = start + timedelta(days=1)
    else:
        end = _parse_event_time(args.end) if args.end else start + timedelta(hours=1)
    import uuid
    uid = args.uid or str(uuid.uuid4())
    alarms, alarm_note = _prep_alarms(args.remind)
    ev = _build_event_data(
        args, start, end, all_day, uid,
        parse_email_list(args.attendees), alarms,
        read_text(args.description) if args.description else "",
        organizer=cfg.email)
    href = cli.put_event(cal_href, ev)
    payload = {"success": True, "action": "create_event", "count": 1,
               "subject": ev.summary, "uid": uid, "saved_path": href}
    if alarm_note:
        payload["note"] = alarm_note
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "创建日程结果"), end="")


def cmd_update_event(args: argparse.Namespace) -> None:
    cli = get_caldav_client(args)
    cal_href = cli.resolve_calendar(args.calendar)
    href = cli.find_event_href(cal_href, args.uid)
    existing = cli.get_event(href)
    data = _parsed_to_data(existing)

    if args.title:
        data.summary = args.title
    if args.location is not None:
        data.location = args.location
    if args.description:
        data.description = read_text(args.description)
    if args.attendees:
        data.attendees = parse_email_list(args.attendees)
    update_note = ""
    if args.remind is not None:
        data.alarms_minutes, update_note = _prep_alarms(args.remind)

    if args.start or args.end or args.all_day:
        if args.all_day:
            data.all_day = True
            base = data.start if isinstance(data.start, date) and not isinstance(data.start, datetime) else (data.start.date() if isinstance(data.start, datetime) else date.today())
            if args.start:
                p = _parse_event_time(args.start)
                base = p if isinstance(p, date) and not isinstance(p, datetime) else p.date()
            data.start = base
            data.end = base + timedelta(days=1)
        else:
            old_dur = None
            if isinstance(data.start, datetime) and isinstance(data.end, datetime):
                old_dur = data.end - data.start
            if args.start:
                ns = _parse_event_time(args.start)
                if isinstance(ns, date) and not isinstance(ns, datetime):
                    ns = datetime.combine(ns, time.min, common.effective_local_tz())
                data.start = ns
            if args.end:
                ne = _parse_event_time(args.end)
                if isinstance(ne, date) and not isinstance(ne, datetime):
                    ne = datetime.combine(ne, time.min, common.effective_local_tz())
                data.end = ne
            elif old_dur:
                data.end = data.start + old_dur
            else:
                data.end = data.start + timedelta(hours=1)
            data.all_day = False

    new_href = cli.put_event(cal_href, data)
    payload = {"success": True, "action": "update_event", "count": 1,
               "subject": data.summary, "uid": data.uid, "saved_path": new_href}
    if update_note:
        payload["note"] = update_note
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "更新日程结果"), end="")


def cmd_delete_event(args: argparse.Namespace) -> None:
    cli = get_caldav_client(args)
    cal_href = cli.resolve_calendar(args.calendar)
    href = cli.find_event_href(cal_href, args.uid)
    cli.delete_event(href)
    payload = {"success": True, "action": "delete_event", "count": 1,
               "uid": args.uid, "saved_path": href}
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "删除日程结果"), end="")


def cmd_event_detail(args: argparse.Namespace) -> None:
    cli = get_caldav_client(args)
    cal_href = cli.resolve_calendar(args.calendar)
    href = cli.find_event_href(cal_href, args.uid)
    ev = cli.get_event(href)
    if args.format == "json":
        return output_json({"success": True, "event": _event_to_dict(ev)})
    print(build_event_detail_markdown(ev), end="")


def cmd_event_from_mail(args: argparse.Namespace) -> None:
    mail_client = get_client(args)
    item = mail_client.get_item_detail(args.item_id, args.folder)
    cli = get_caldav_client(args)
    cfg = common.load_config(getattr(args, "config", "") or None)
    cal_href = cli.resolve_calendar(args.calendar)

    tz = common.effective_local_tz()
    if args.start:
        start = _parse_event_time(args.start)
    else:
        # 默认：明天上午 9:00
        tomorrow = datetime.now(tz).date() + timedelta(days=1)
        start = datetime.combine(tomorrow, time(9, 0), tz)
    all_day = bool(args.all_day) or isinstance(start, date) and not isinstance(start, datetime)
    if all_day:
        start = start if isinstance(start, date) and not isinstance(start, datetime) else start.date()
        end = start + timedelta(days=1)
    else:
        end = _parse_event_time(args.end) if args.end else start + timedelta(hours=1)

    title = args.title or item.get("subject") or "(无标题)"
    sender = item.get("from") or {}
    sender_label = _readable_sender(item)
    if args.description:
        description = read_text(args.description)
    else:
        body = item.get("body_text") or ""
        body = body[:1500]
        description = (
            f"来源邮件：{item.get('subject') or ''}\n"
            f"发件人：{sender_label}\n"
            f"收件人：{item.get('display_to') or ''}\n"
            f"原邮件时间：{item.get('date_time_received') or item.get('date_time_sent') or ''}\n"
            f"邮件UID：{item.get('item_id') or ''}\n"
            f"{'=' * 20}\n{body}")
    import uuid
    uid = str(uuid.uuid4())
    alarms, alarm_note = _prep_alarms(args.remind)
    ev = ical.EventData(
        uid=uid, summary=title, start=start, end=end, all_day=all_day,
        description=description, location=args.location or "",
        organizer=cfg.email, attendees=parse_email_list(args.attendees),
        alarms_minutes=alarms)
    href = cli.put_event(cal_href, ev)
    payload = {"success": True, "action": "event_from_mail", "count": 1,
               "subject": title, "uid": uid, "saved_path": href}
    if alarm_note:
        payload["note"] = alarm_note
    if args.format == "json":
        return output_json(payload)
    print(build_write_markdown(payload, "邮件转日程结果"), end="")


# ---------------------------------------------------------------------------
# 待办清单（C 阶段：组合 A/B 原子能力）
# ---------------------------------------------------------------------------

def _todo_state(custom: str = "") -> dict[str, Any]:
    return agenda.load_state(custom or "")


def cmd_todo_scan(args: argparse.Namespace) -> None:
    cfg = common.load_config(getattr(args, "config", "") or None)
    common.assert_config_ready(cfg)
    res = agenda.scan(
        cfg, days=args.days, folder=args.folder,
        include_sent=not args.no_sent,
        include_calendar=not args.no_calendar,
        calendar=args.calendar or "",
        calendar_days=args.calendar_days,
        max_mails=args.max_mails, limit=args.limit)
    state = _todo_state(args.state)
    counts: dict[str, Any] = {}
    if not args.no_save:
        counts = agenda.merge(state, res["items"])
        agenda.save_state(state, args.state or "")
        items = agenda.visible_items(state, status="active")
    else:
        items = _todo_preview_items(res["items"])
    started = common.local_now().strftime("%Y-%m-%d %H:%M")
    payload = {
        "success": True, "action": "todo_scan", "range": res["range"],
        "stats": res["stats"], "merge": counts, "saved": not args.no_save,
        "counts": {"total": len(items),
                   "一般待办": len([i for i in items if i["tag"] == agenda.TAG_TODO_PLAIN]),
                   "待反馈": len([i for i in items if i["tag"] == agenda.TAG_TODO]),
                   "会议": len([i for i in items if i["tag"] == agenda.TAG_MEETING])},
        "items": items,
    }
    if args.format == "json":
        return output_json(payload)
    print(agenda.render_scan_result(items, res["stats"], started,
                                    not args.no_save, state), end="")


def _todo_preview_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """预览模式下按清单口径排序（不读盘）。"""
    fake_state = {"version": 1, "items": items, "declined_keys": []}
    return agenda.visible_items(fake_state, status="all")


def cmd_todo_list(args: argparse.Namespace) -> None:
    state = _todo_state(args.state)
    if not state.get("items"):
        hint = ("待办清单还是空的。先运行 todo-scan 扫描一次（近 7 天邮件 + 日历），"
                "或用 todo-add 手动加一条。")
        if args.format == "json":
            return output_json({"success": True, "action": "todo_list", "count": 0,
                                "items": [], "updated_at": state.get("updated_at", ""),
                                "hint": hint})
        print(f"# 📋 待办清单\n\n- 清单为空。\n- {hint}\n", end="")
        return
    items = agenda.visible_items(state, status=args.status, tag=args.tag or "",
                                 include_past=args.include_past)
    payload = {"success": True, "action": "todo_list", "count": len(items),
               "items": items, "updated_at": state.get("updated_at", "")}
    if args.format == "json":
        return output_json(payload)
    title = f"待办清单（{args.tag}）" if args.tag else "待办清单"
    if args.status == "pending":
        title += " · 仅待处理"
    elif args.status == "done":
        title += " · 仅已完成"
    print(agenda.render_list(state, items, title), end="")


def _todo_status_change(args: argparse.Namespace, status: str, action: str,
                        title: str) -> None:
    state = _todo_state(args.state)
    item = agenda.set_status(state, args.id, status)
    agenda.save_state(state, args.state or "")
    remaining = agenda.visible_items(state, status="active")
    payload = {"success": True, "action": action, "count": 1,
               "item": item, "status": agenda.STATUS_LABEL.get(status, status),
               "remaining": {"total": len(remaining),
                             "一般待办": len([i for i in remaining if i["tag"] == agenda.TAG_TODO_PLAIN]),
                             "待反馈": len([i for i in remaining if i["tag"] == agenda.TAG_TODO]),
                             "会议": len([i for i in remaining if i["tag"] == agenda.TAG_MEETING])}}
    if args.format == "json":
        return output_json(payload)
    lines = [f"# {title}", "",
             f"- 编号：{item['short_id']}",
             f"- 标签：{agenda.TAG_META[item['tag']]['badge']}",
             f"- 事项：{item.get('title') or ''}",
             f"- 状态：{payload['status']}"]
    if item["tag"] == agenda.TAG_MEETING:
        lines.append(f"- 会议时间：{agenda._meeting_time_text(item)}")
        if item.get("location"):
            lines.append(f"- 地点：{item['location']}")
    lines.append(f"- 清单剩余：🟩 {payload['remaining']['一般待办']} · 🟧 {payload['remaining']['待反馈']} · 🟦 {payload['remaining']['会议']}")
    print("\n".join(lines) + "\n")


def cmd_todo_accept(args: argparse.Namespace) -> None:
    _todo_status_change(args, "accepted", "todo_accept", "确认参加结果")


def cmd_todo_decline(args: argparse.Namespace) -> None:
    _todo_status_change(args, "declined", "todo_decline", "已从清单移除")


def cmd_todo_done(args: argparse.Namespace) -> None:
    _todo_status_change(args, "done", "todo_done", "标记完成")


def cmd_todo_add(args: argparse.Namespace) -> None:
    state = _todo_state(args.state)
    item = agenda.add_manual(
        state, tag=args.tag, title=args.title, deadline=args.deadline or "",
        feedback_to=args.feedback_to or "", meeting_start=args.meeting_start or "",
        location=args.location or "", note=args.note or "")
    agenda.save_state(state, args.state or "")
    payload = {"success": True, "action": "todo_add", "count": 1, "item": item}
    if args.format == "json":
        return output_json(payload)
    lines = ["# 已加入待办清单", "",
             f"- 编号：{item['short_id']}",
             f"- 标签：{agenda.TAG_META[item['tag']]['badge']}",
             f"- 事项：{item['title']}"]
    if item.get("deadline"):
        lines.append(f"- 截止：{item['deadline']}")
    if item.get("meeting_start"):
        lines.append(f"- 会议时间：{item['meeting_start']}")
    if item.get("feedback_to"):
        lines.append(f"- 反馈对象：{'、'.join(item['feedback_to'])}")
    print("\n".join(lines) + "\n")


def cmd_todo_parse(args: argparse.Namespace) -> None:
    """把一段自然语言解析成待办/会议字段（本地规则，供 DSH 表单识别框预填）。"""
    import qqmail_todo as todo_engine
    text = read_text(args.text).strip()
    if not text:
        raise common.QQMailError("todo-parse 需要 --text 或 --text @路径 输入")
    ref = common.local_now()

    deadline = todo_engine.pick_deadline(text, ref, "")
    feedback = todo_engine.extract_feedback_targets(text, "")
    cls = todo_engine.classify_text("", text, "", "", ref=ref)
    tag = cls.get("tag", "")

    # 标题：优先一句话摘要，抽不到用原文；会议优先取「XX会」这种会议名称
    title = todo_engine.summarize_event(text, 46).strip() or text.strip()
    if tag == "会议":
        mname = todo_engine.meeting_title(text)
        if mname:
            title = mname

    # 会议：起止 + 地点
    meeting_start = ""
    meeting_end = ""
    location = cls.get("location", "") or ""
    if tag == "会议":
        meeting_start, meeting_end = todo_engine.meeting_window(text, ref)
        if len(meeting_start) > 16:
            meeting_start = meeting_start[:16]
        if len(meeting_end) > 16:
            meeting_end = meeting_end[:16]

    # 截止
    due = ""
    deadline_text = ""
    deadline_time = ""
    deadline_limiter = ""
    if deadline:
        due = deadline.get("date", "")
        deadline_text = deadline.get("deadline_text", "")
        deadline_time = deadline.get("time", "")
        deadline_limiter = deadline.get("deadline_limiter", "")

    # 反馈对象
    feedback_to = list(feedback.get("names", [])) + list(feedback.get("emails", []))

    # 优先级（两级：紧急 / 一般）
    priority = "urgent" if todo_engine.detect_urgency(text) == "high" else "normal"

    # kind
    if tag == "会议":
        kind = "meeting"
    elif tag == "待反馈":
        kind = "feedback"
    else:
        kind = "todo"

    payload = {
        "success": True,
        "action": "todo_parse",
        "kind": kind,
        "title": title,
        "priority": priority,
        "category": "工作",
        "due": due,
        "deadline_text": deadline_text,
        "deadline_time": deadline_time,
        "deadline_limiter": deadline_limiter,
        "feedback_to": feedback_to,
        "location": location,
        "meeting_start": meeting_start,
        "meeting_end": meeting_end,
        "confidence": cls.get("confidence", "low"),
    }
    output_json(payload)


# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------

def add_folder_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--folder", default="inbox", help="逻辑文件夹名 inbox/sentitems/drafts/deleteditems/junkemail，或自定义文件夹名")
    p.add_argument("--format", choices=["json", "markdown"], default="markdown", help="输出格式")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="TidyWorky 邮箱模块（QQ IMAP/SMTP）")
    parser.add_argument("--config", default="", help="config.ini 路径（默认读取技能包根目录 config.ini）")
    parser.add_argument("--debug", action="store_true", help="输出调试信息到 stderr")
    sub = parser.add_subparsers(dest="command", required=True)

    folders = sub.add_parser("folders", help="列出文件夹")
    folders.add_argument("--limit", type=int, default=200)
    folders.add_argument("--format", choices=["json", "markdown"], default="markdown")
    folders.set_defaults(func=cmd_folders)

    create = sub.add_parser("create-folder", help="新建文件夹")
    create.add_argument("--display-name", required=True)
    create.add_argument("--format", choices=["json", "markdown"], default="markdown")
    create.set_defaults(func=cmd_create_folder)

    search = sub.add_parser("search", help="搜索单个文件夹（服务端粗筛+客户端精筛）")
    search.add_argument("--folder", default="inbox")
    search.add_argument("--sender", default="", help="按发件人姓名/邮箱过滤")
    search.add_argument("--recipient", default="", help="按收件人/抄送人过滤")
    search.add_argument("--subject", default="", help="按主题关键词过滤")
    search.add_argument("--body-keyword", default="", help="按正文关键词过滤")
    search.add_argument("--after", default="", help="起始时间 YYYY-MM-DD[ HH:MM:SS]；缺省近 1 天")
    search.add_argument("--before", default="", help="结束时间 YYYY-MM-DD[ HH:MM:SS]")
    search.add_argument("--unread", action="store_true", help="仅未读")
    search.add_argument("--read", action="store_true", help="仅已读")
    search.add_argument("--has-attachments", action="store_true", help="仅含附件")
    search.add_argument("--category", default="", help="按标签关键词过滤")
    search.add_argument("--importance", choices=["High", "Normal", "Low", "high", "normal", "low"], default="")
    search.add_argument("--limit", type=int, default=50)
    search.add_argument("--max-pages", type=int, default=10)
    search.add_argument("--format", choices=["json", "markdown"], default="markdown")
    search.add_argument("--max-rows", type=int, default=12)
    search.set_defaults(func=cmd_search)

    detail = sub.add_parser("detail", help="读取邮件全文")
    detail.add_argument("--item-id", required=True, help="邮件 UID")
    detail.add_argument("--folder", default="inbox")
    detail.add_argument("--format", choices=["json", "markdown"], default="markdown")
    detail.set_defaults(func=cmd_detail)

    check = sub.add_parser("attachment-check", help="检查邮件附件清单")
    check.add_argument("--item-id", required=True)
    check.add_argument("--folder", default="inbox")
    check.add_argument("--format", choices=["json", "markdown"], default="markdown")
    check.set_defaults(func=cmd_attachment_check)

    download = sub.add_parser("download-attachment", help="下载邮件附件")
    download.add_argument("--item-id", required=True)
    download.add_argument("--attachment-index", required=True, help="附件序号（从 1 开始）或 attachment_id")
    download.add_argument("--folder", default="inbox")
    download.add_argument("--out-dir", default="", help="保存目录，默认包内 downloads/")
    download.add_argument("--format", choices=["json", "markdown"], default="markdown")
    download.set_defaults(func=cmd_download_attachment)

    send = sub.add_parser("send", help="发送新邮件")
    send.add_argument("--to", required=True, dest="to_recipients", help="收件人，逗号分隔")
    send.add_argument("--cc", dest="cc_recipients", default="")
    send.add_argument("--bcc", dest="bcc_recipients", default="")
    send.add_argument("--subject", required=True)
    send.add_argument("--body", required=True, help="正文；@路径 读文件，- 从 stdin 读")
    send.add_argument("--body-type", choices=["H", "T"], default="T")
    send.add_argument("--importance", choices=["High", "Normal", "Low"], default="Normal")
    send.add_argument("--attachments", default="", help="附件路径，逗号分隔")
    send.add_argument("--format", choices=["json", "markdown"], default="markdown")
    send.set_defaults(func=cmd_send)

    reply = sub.add_parser("reply", help="回复邮件")
    reply.add_argument("--item-id", required=True)
    reply.add_argument("--folder", default="inbox")
    reply.add_argument("--body", required=True, help="回复正文；@路径 读文件，- 从 stdin 读")
    reply.add_argument("--body-type", choices=["H", "T"], default="T")
    reply.add_argument("--reply-all", action="store_true", help="回复全部")
    reply.add_argument("--include-original", action="store_true", default=True, help="附带原文引用（默认开启）")
    reply.add_argument("--no-quote", dest="include_original", action="store_false", help="不附带原文")
    reply.add_argument("--cc", default="")
    reply.add_argument("--bcc", default="")
    reply.add_argument("--importance", choices=["High", "Normal", "Low"], default="Normal")
    reply.add_argument("--attachments", default="")
    reply.add_argument("--format", choices=["json", "markdown"], default="markdown")
    reply.set_defaults(func=cmd_reply)

    forward = sub.add_parser("forward", help="转发邮件")
    forward.add_argument("--item-id", required=True)
    forward.add_argument("--folder", default="inbox")
    forward.add_argument("--to", required=True, dest="to_recipients")
    forward.add_argument("--cc", dest="cc_recipients", default="")
    forward.add_argument("--bcc", dest="bcc_recipients", default="")
    forward.add_argument("--body", default="", help="转发附言；@路径 读文件，- 从 stdin 读")
    forward.add_argument("--body-type", choices=["H", "T"], default="T")
    forward.add_argument("--attachments", default="")
    forward.add_argument("--format", choices=["json", "markdown"], default="markdown")
    forward.set_defaults(func=cmd_forward)

    daily = sub.add_parser("daily-stats", help="按天统计")
    daily.add_argument("--folder", default="inbox")
    daily.add_argument("--after", default="")
    daily.add_argument("--before", default="")
    daily.add_argument("--days", type=int, default=7)
    daily.add_argument("--format", choices=["json", "markdown"], default="markdown")
    daily.set_defaults(func=cmd_daily_stats)

    pending = sub.add_parser("pending-important", help="近期重要且未回复邮件")
    pending.add_argument("--folder", default="inbox")
    pending.add_argument("--days", type=int, default=1)
    pending.add_argument("--limit", type=int, default=100)
    pending.add_argument("--max-rows", type=int, default=12)
    pending.add_argument("--format", choices=["json", "markdown"], default="markdown")
    pending.set_defaults(func=cmd_pending_important)

    unhandled = sub.add_parser("person-unhandled", help="指定发件人未读且未回复")
    unhandled.add_argument("--sender", required=True)
    unhandled.add_argument("--folder", default="inbox")
    unhandled.add_argument("--days", type=int, default=1)
    unhandled.add_argument("--limit", type=int, default=100)
    unhandled.add_argument("--max-rows", type=int, default=12)
    unhandled.add_argument("--format", choices=["json", "markdown"], default="markdown")
    unhandled.set_defaults(func=cmd_person_unhandled)

    lookup = sub.add_parser("lookup-recipient", help="从往来邮件查询联系人")
    lookup.add_argument("--condition", default="")
    lookup.add_argument("--name", default="")
    lookup.add_argument("--page-size", type=int, default=10)
    lookup.add_argument("--max-rows", type=int, default=10)
    lookup.add_argument("--format", choices=["json", "markdown"], default="markdown")
    lookup.set_defaults(func=cmd_lookup_recipient)

    mark_read = sub.add_parser("batch-mark-read", help="批量标记已读")
    mark_read.add_argument("--item-ids", required=True, help="UID，逗号分隔")
    mark_read.add_argument("--folder", default="inbox")
    mark_read.add_argument("--format", choices=["json", "markdown"], default="markdown")
    mark_read.set_defaults(func=cmd_mark_read)

    mark_unread = sub.add_parser("batch-mark-unread", help="批量标记未读")
    mark_unread.add_argument("--item-ids", required=True, help="UID，逗号分隔")
    mark_unread.add_argument("--folder", default="inbox")
    mark_unread.add_argument("--format", choices=["json", "markdown"], default="markdown")
    mark_unread.set_defaults(func=cmd_mark_unread)

    category = sub.add_parser("batch-add-category", help="批量打标签")
    category.add_argument("--item-ids", required=True)
    category.add_argument("--category", required=True)
    category.add_argument("--folder", default="inbox")
    category.add_argument("--format", choices=["json", "markdown"], default="markdown")
    category.set_defaults(func=cmd_add_category)

    flag = sub.add_parser("flag", help="星标单封邮件")
    flag.add_argument("--item-id", required=True)
    flag.add_argument("--folder", default="inbox")
    flag.add_argument("--format", choices=["json", "markdown"], default="markdown")
    flag.set_defaults(func=cmd_flag)

    unflag = sub.add_parser("unflag", help="取消星标单封")
    unflag.add_argument("--item-id", required=True)
    unflag.add_argument("--folder", default="inbox")
    unflag.add_argument("--format", choices=["json", "markdown"], default="markdown")
    unflag.set_defaults(func=cmd_unflag)

    batch_flag = sub.add_parser("batch-flag", help="批量星标")
    batch_flag.add_argument("--item-ids", required=True)
    batch_flag.add_argument("--folder", default="inbox")
    batch_flag.add_argument("--format", choices=["json", "markdown"], default="markdown")
    batch_flag.set_defaults(func=cmd_batch_flag)

    batch_unflag = sub.add_parser("batch-unflag", help="批量取消星标")
    batch_unflag.add_argument("--item-ids", required=True)
    batch_unflag.add_argument("--folder", default="inbox")
    batch_unflag.add_argument("--format", choices=["json", "markdown"], default="markdown")
    batch_unflag.set_defaults(func=cmd_batch_unflag)

    move = sub.add_parser("batch-move", help="批量移动到目标文件夹")
    move.add_argument("--item-ids", required=True)
    move.add_argument("--target-folder", required=True, help="目标逻辑文件夹名或自定义文件夹名")
    move.add_argument("--folder", default="inbox", help="源文件夹")
    move.add_argument("--format", choices=["json", "markdown"], default="markdown")
    move.set_defaults(func=cmd_move)

    delete = sub.add_parser("batch-delete", help="批量删除（默认移入已删除）")
    delete.add_argument("--item-ids", required=True)
    delete.add_argument("--folder", default="inbox")
    delete.add_argument("--delete-type", default="MoveToDeletedItems",
                        help="MoveToDeletedItems 或 HardDelete")
    delete.add_argument("--format", choices=["json", "markdown"], default="markdown")
    delete.set_defaults(func=cmd_delete)

    selfcheck = sub.add_parser("self-check", help="IMAP/SMTP 连接自检")
    selfcheck.add_argument("--format", choices=["json", "markdown"], default="markdown")
    selfcheck.set_defaults(func=cmd_self_check)

    summarize = sub.add_parser("summarize", help="从 stdin 读 JSON 渲染总结")
    summarize.add_argument("--format", choices=["markdown", "json"], default="markdown")
    summarize.add_argument("--max-rows", type=int, default=12)
    summarize.set_defaults(func=cmd_summarize)

    # ---- 日程（CalDAV） ----
    def cal_format(p):
        p.add_argument("--format", choices=["json", "markdown"], default="markdown")

    cal = sub.add_parser("calendars", help="列出日历")
    cal_format(cal)
    cal.set_defaults(func=cmd_calendars)

    le = sub.add_parser("list-events", help="查看日程（默认近 7 天）")
    le.add_argument("--calendar", default="", help="日历显示名/序号，默认主日历")
    le.add_argument("--start", default="", help="起始 YYYY-MM-DD")
    le.add_argument("--end", default="", help="结束 YYYY-MM-DD")
    le.add_argument("--days", type=int, default=7)
    le.add_argument("--max-rows", type=int, default=20)
    cal_format(le)
    le.set_defaults(func=cmd_list_events)

    ed = sub.add_parser("event-detail", help="日程详情")
    ed.add_argument("--uid", required=True)
    ed.add_argument("--calendar", default="")
    cal_format(ed)
    ed.set_defaults(func=cmd_event_detail)

    ce = sub.add_parser("create-event", help="创建日程")
    ce.add_argument("--title", required=True)
    ce.add_argument("--start", required=True, help="YYYY-MM-DD（全天）或 'YYYY-MM-DD HH:MM'")
    ce.add_argument("--end", default="", help="缺省：定时+1小时，全天+1天")
    ce.add_argument("--all-day", action="store_true")
    ce.add_argument("--location", default="")
    ce.add_argument("--description", default="", help="描述；@文件 或 -")
    ce.add_argument("--attendees", default="", help="参与人邮箱，逗号分隔")
    ce.add_argument("--remind", default="", help="提前提醒分钟，逗号分隔，如 15,60")
    ce.add_argument("--calendar", default="")
    ce.add_argument("--uid", default="")
    cal_format(ce)
    ce.set_defaults(func=cmd_create_event)

    ue = sub.add_parser("update-event", help="更新日程（部分字段）")
    ue.add_argument("--uid", required=True)
    ue.add_argument("--calendar", default="")
    ue.add_argument("--title", default="")
    ue.add_argument("--start", default="")
    ue.add_argument("--end", default="")
    ue.add_argument("--all-day", action="store_true")
    ue.add_argument("--location", default="")
    ue.add_argument("--description", default="")
    ue.add_argument("--attendees", default="")
    ue.add_argument("--remind", default="")
    cal_format(ue)
    ue.set_defaults(func=cmd_update_event)

    de = sub.add_parser("delete-event", help="删除日程")
    de.add_argument("--uid", required=True)
    de.add_argument("--calendar", default="")
    cal_format(de)
    de.set_defaults(func=cmd_delete_event)

    efm = sub.add_parser("event-from-mail", help="邮件转日程")
    efm.add_argument("--item-id", required=True)
    efm.add_argument("--folder", default="inbox")
    efm.add_argument("--calendar", default="")
    efm.add_argument("--title", default="", help="缺省用邮件主题")
    efm.add_argument("--start", default="", help="缺省明天 9:00")
    efm.add_argument("--end", default="")
    efm.add_argument("--all-day", action="store_true")
    efm.add_argument("--location", default="")
    efm.add_argument("--description", default="")
    efm.add_argument("--attendees", default="")
    efm.add_argument("--remind", default="")
    cal_format(efm)
    efm.set_defaults(func=cmd_event_from_mail)

    # ---- 待办清单（C 阶段） ----
    ts = sub.add_parser("todo-scan", help="扫描邮件+日历，生成待反馈/会议待办清单")
    ts.add_argument("--days", type=int, default=7, help="回溯天数（默认 7）")
    ts.add_argument("--folder", default="inbox", help="扫描的邮件文件夹（默认 inbox）")
    ts.add_argument("--no-sent", action="store_true", help="不扫描已发送（默认扫描，用来识别“我发起的会议”）")
    ts.add_argument("--no-calendar", action="store_true", help="不扫描日历")
    ts.add_argument("--calendar", default="", help="日历显示名/序号，默认主日历")
    ts.add_argument("--calendar-days", type=int, default=14, help="向未来扫描的日历天数（默认 14）")
    ts.add_argument("--max-mails", type=int, default=40, help="最多读取全文的邮件数（控制耗时/限流）")
    ts.add_argument("--limit", type=int, default=300, help="单文件夹最多取多少封元数据")
    ts.add_argument("--no-save", action="store_true", help="只预览，不写入清单")
    ts.add_argument("--state", default="", help="清单文件路径，默认包内 todo.json")
    ts.add_argument("--format", choices=["json", "markdown"], default="markdown")
    ts.set_defaults(func=cmd_todo_scan)

    tl = sub.add_parser("todo-list", help="查看待办清单")
    tl.add_argument("--status", choices=["active", "pending", "accepted", "done", "all"],
                    default="active")
    tl.add_argument("--tag", choices=["一般待办", "待反馈", "会议"], default="", help="只看某一类")
    tl.add_argument("--include-past", action="store_true", help="包含已结束的历史会议")
    tl.add_argument("--state", default="")
    tl.add_argument("--format", choices=["json", "markdown"], default="markdown")
    tl.set_defaults(func=cmd_todo_list)

    for name, fn, help_text in (
        ("todo-accept", cmd_todo_accept, "确认参加某场会议"),
        ("todo-decline", cmd_todo_decline, "不参加并从清单移除"),
        ("todo-done", cmd_todo_done, "标记某条已完成"),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--id", required=True, help="清单编号（5 位）或完整 key")
        p.add_argument("--state", default="")
        p.add_argument("--format", choices=["json", "markdown"], default="markdown")
        p.set_defaults(func=fn)

    ta = sub.add_parser("todo-add", help="手动加一条待办")
    ta.add_argument("--tag", required=True, choices=["一般待办", "待反馈", "会议"])
    ta.add_argument("--title", required=True)
    ta.add_argument("--deadline", default="", help="截止日期 YYYY-MM-DD")
    ta.add_argument("--feedback-to", default="", help="反馈对象邮箱，逗号分隔")
    ta.add_argument("--meeting-start", default="", help="会议开始 YYYY-MM-DDTHH:MM")
    ta.add_argument("--location", default="")
    ta.add_argument("--note", default="")
    ta.add_argument("--state", default="")
    ta.add_argument("--format", choices=["json", "markdown"], default="markdown")
    ta.set_defaults(func=cmd_todo_add)

    tp = sub.add_parser("todo-parse", help="把自然语言解析成待办/会议字段")
    tp.add_argument("--text", required=True, help="自然语言；@路径 读文件，- 从 stdin 读")
    tp.add_argument("--format", choices=["json", "markdown"], default="json")
    tp.set_defaults(func=cmd_todo_parse)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except common.QQMailError as exc:
        output_json({"success": False, "error": str(exc)})
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        output_json({"success": False, "error": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
