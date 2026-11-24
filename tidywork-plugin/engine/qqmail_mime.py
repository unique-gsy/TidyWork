#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - MIME 解析与构造。

对标京东 soap_mail.py 中的 EWS XML 解析（parse_items / parse_item_detail /
parse_attachment_detail）与 CreateItem 邮件构造；QQ 版本改为基于标准库 email
解析/构造 RFC822 MIME 邮件。输出的 folder/item/attachment 字段名与京东保持一致，
保证 CLI 与 SKILL.md 可直接复用。
"""

from __future__ import annotations

import base64
import mimetypes
import re
from datetime import datetime
from email.header import decode_header, make_header
from email.message import Message
from email.utils import formataddr, formatdate, getaddresses, make_msgid, parseaddr, parsedate_to_datetime
from typing import Any, Optional

import qqmail_common as common


# ---------------------------------------------------------------------------
# 头部解码 / 地址 / 日期
# ---------------------------------------------------------------------------

def decode_str(value: Optional[str]) -> str:
    """解码邮件头中的 encoded-word（=?gbk?B?...?=）。"""
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return str(value)


def imap_utf7_decode(value: Optional[str]) -> str:
    """解码 IMAP modified UTF-7 邮箱名（RFC 3501）。

    非 ASCII 邮箱名形如 ``&UXZO1mWHTvZZOQ-``（& 替代标准 base64 的 +，
    内容为 UTF-16BE）；``&-`` 表示字面量 &。QQ 自定义中文文件夹用此编码。
    """
    if not value:
        return ""
    out: list[str] = []
    i = 0
    while i < len(value):
        if value[i] != "&":
            out.append(value[i])
            i += 1
            continue
        j = value.find("-", i + 1)
        if j == -1:
            out.append(value[i:])
            break
        token = value[i + 1:j]
        if token == "":
            out.append("&")  # &- 表示字面量 &
        else:
            try:
                padded = token + "=" * (-len(token) % 4)
                out.append(base64.b64decode(padded).decode("utf-16-be"))
            except Exception:
                out.append(value[i:j + 1])
        i = j + 1
    return "".join(out)


def imap_utf7_encode(value: Optional[str]) -> str:
    """编码 IMAP modified UTF-7 邮箱名：可打印 ASCII 原样，非 ASCII 块转 UTF-16BE。"""
    if not value:
        return ""
    out: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        if not buffer:
            return
        raw = "".join(buffer).encode("utf-16-be")
        token = base64.b64encode(raw).decode("ascii").rstrip("=")
        out.append("&" + token.replace("+", ",") + "-")
        buffer.clear()

    for ch in value:
        if ch == "&":
            flush()
            out.append("&-")
        elif 0x20 <= ord(ch) <= 0x7E:
            flush()
            out.append(ch)
        else:
            buffer.append(ch)
    flush()
    return "".join(out)


def parse_single_address(value: Optional[str]) -> dict[str, str]:
    name, addr = parseaddr(value or "")
    return {"name": decode_str(name).strip(), "email": (addr or "").strip()}


def parse_address_list(value: Optional[str]) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for name, addr in getaddresses([value or ""]):
        box = {"name": decode_str(name).strip(), "email": (addr or "").strip()}
        if box["email"]:
            result.append(box)
    return result


def parse_date_header(value: Optional[str]) -> Optional[datetime]:
    """RFC2822 Date 头 -> 本地时区 datetime。"""
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
        return common.to_local(dt)
    except Exception:
        return None


def parse_imap_internaldate(value: Optional[str]) -> Optional[datetime]:
    """IMAP INTERNALDATE，如 27-Oct-2026 10:11:12 +0800。"""
    raw = (value or "").strip().strip('"')
    if not raw:
        return None
    for fmt in ("%d-%b-%Y %H:%M:%S %z", "%d-%b-%Y %H:%M:%S"):
        try:
            return common.to_local(datetime.strptime(raw, fmt))
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# 重要级别 / 标志 / 线程
# ---------------------------------------------------------------------------

def extract_importance(msg: Message) -> str:
    """把 Importance / X-Priority / Priority 归一为 High / Normal / Low。"""
    importance = decode_str(msg.get("Importance") or "").strip().lower()
    priority = decode_str(msg.get("X-Priority") or msg.get("Priority") or "").strip()
    msm = decode_str(msg.get("X-MSMail-Priority") or "").strip().lower()
    if importance in ("high", "urgent") or priority[:1] in ("1", "2") or msm == "high":
        return "High"
    if importance in ("low", "non-urgent") or priority[:1] in ("4", "5") or msm == "low":
        return "Low"
    return "Normal"


def importance_to_headers(importance: str) -> dict[str, str]:
    """发送时把 High/Normal/Low 写回标准头。"""
    level = (importance or "Normal").strip().capitalize()
    if level == "High":
        return {"Importance": "high", "X-Priority": "1", "X-MSMail-Priority": "High"}
    if level == "Low":
        return {"Importance": "low", "X-Priority": "5", "X-MSMail-Priority": "Low"}
    return {"Importance": "normal", "X-Priority": "3"}


def parse_imap_flags(flags: Optional[list[str]]) -> dict[str, Any]:
    """拆分 IMAP 系统标志与自定义 keyword。

    系统标志：\\Seen（已读）、\\Flagged（星标/旗标）、\\Answered、\\Draft、
    \\Deleted；其余不带反斜杠的视为自定义分类（对标京东 categories）。
    """
    flags = flags or []
    system = {f.lower() for f in flags if f.startswith("\\")}
    categories = [f for f in flags if f and not f.startswith("\\")]
    return {
        "is_read": "\\seen" in system,
        "is_flagged": "\\flagged" in system,
        "is_answered": "\\answered" in system,
        "is_draft": "\\draft" in system,
        "is_deleted": "\\deleted" in system,
        "categories": categories,
    }


def thread_info(msg: Message) -> dict[str, str]:
    """提取 Message-ID / In-Reply-To / References，并推导会话根（对标 conversation_id）。"""
    message_id = common.safe_text(msg.get("Message-ID"))
    in_reply_to = common.safe_text(msg.get("In-Reply-To"))
    references = common.safe_text(msg.get("References"))
    ref_list = [item.strip() for item in references.split() if item.strip()]
    if ref_list:
        conversation_id = ref_list[0]
    elif in_reply_to:
        conversation_id = in_reply_to
    else:
        conversation_id = message_id
    return {
        "message_id": message_id,
        "in_reply_to": in_reply_to,
        "references": references,
        "conversation_id": conversation_id,
    }


def normalize_subject_thread(subject: str) -> str:
    """去掉 Re:/Fw:/Fwd: 等前缀，用于线程主题归一化。"""
    text = common.safe_text(subject)
    return re.sub(r"^(\s*(re|fw|fwd|aw|wg|回复|转发)\s*(\[\d+\])?\s*:\s*)+", "", text, flags=re.IGNORECASE).strip()


# ---------------------------------------------------------------------------
# 正文 / 附件
# ---------------------------------------------------------------------------

def _decode_part(part: Message) -> str:
    try:
        payload = part.get_payload(decode=True)
    except Exception:
        payload = None
    if payload is None:
        return part.get_payload() or ""
    charset = part.get_content_charset()
    candidates = [charset, "utf-8", "gb18030", "gbk", "big5", "latin-1"]
    for enc in candidates:
        if not enc:
            continue
        try:
            return payload.decode(enc, errors="strict")
        except (LookupError, UnicodeDecodeError):
            continue
    return payload.decode("utf-8", errors="replace")


def html_to_text(html: str) -> str:
    """无第三方依赖的 HTML 转纯文本（兜底用）。"""
    if not html:
        return ""
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", "", html)
    text = re.sub(r"(?i)</\s*(p|div|br|tr|li|h[1-6])\s*>", "\n", text)
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    # 常见 HTML 实体
    for entity, char in (("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&quot;", '"'), ("&#39;", "'")):
        text = text.replace(entity, char)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _attachment_name(part: Message) -> str:
    name = part.get_filename()
    return decode_str(name).strip() if name else ""


def extract_body_and_attachments(msg: Message, include_payload: bool = True) -> tuple[str, str, list[dict[str, Any]]]:
    """递归提取 text/plain、text/html 与附件。"""
    body_text = ""
    body_html = ""
    attachments: list[dict[str, Any]] = []

    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disposition = (part.get("Content-Disposition") or "").lower()
        filename = _attachment_name(part)
        is_attachment = "attachment" in disposition or bool(filename)
        is_inline = "inline" in disposition

        if is_attachment:
            payload = b""
            if include_payload:
                try:
                    payload = part.get_payload(decode=True) or b""
                except Exception:
                    payload = b""
            attachment = {
                "attachment_id": "",  # IMAP 无独立附件 id，用「uid:序号」在 core 中补
                "name": filename or "attachment",
                "content_type": ctype,
                "size": len(payload) if include_payload else 0,
                "is_inline": is_inline,
            }
            if include_payload:
                attachment["_payload"] = payload
            cid = part.get("Content-ID")
            if cid:
                attachment["content_id"] = cid.strip().strip("<>")
            attachments.append(attachment)
        elif ctype == "text/plain" and not body_text:
            body_text = _decode_part(part)
        elif ctype == "text/html" and not body_html:
            body_html = _decode_part(part)

    if not body_text and body_html:
        body_text = html_to_text(body_html)
    return body_text, body_html, attachments


def _populate_headers(item: dict[str, Any], msg: Message) -> None:
    from_box = parse_single_address(msg.get("From"))
    sender_box = parse_single_address(msg.get("Sender")) or from_box
    to_boxes = parse_address_list(msg.get("To"))
    cc_boxes = parse_address_list(msg.get("Cc"))
    thread = thread_info(msg)

    item["subject"] = decode_str(msg.get("Subject"))
    item["from"] = from_box
    item["sender"] = sender_box
    item["to_recipients"] = to_boxes
    item["cc_recipients"] = cc_boxes
    item["display_to"] = "; ".join(box["name"] or box["email"] for box in to_boxes)
    item["display_cc"] = "; ".join(box["name"] or box["email"] for box in cc_boxes)
    item["importance"] = extract_importance(msg)
    item["message_id"] = thread["message_id"]
    item["in_reply_to"] = thread["in_reply_to"]
    item["references"] = thread["references"]
    item["conversation_id"] = thread["conversation_id"]
    date_sent = parse_date_header(msg.get("Date"))
    if date_sent:
        item["date_time_sent"] = common.local_iso(date_sent)


def _blank_item(uid: str, folder: str) -> dict[str, Any]:
    return {
        "item_id": str(uid),
        "change_key": "",  # IMAP 无 EWS ChangeKey
        "conversation_id": "",
        "subject": "",
        "date_time_received": "",
        "date_time_sent": "",
        "last_modified_time": "",
        "from": {"name": "", "email": ""},
        "sender": {"name": "", "email": ""},
        "to_recipients": [],
        "cc_recipients": [],
        "display_to": "",
        "display_cc": "",
        "is_read": False,
        "has_attachments": False,
        "importance": "Normal",
        "categories": [],
        "preview": "",
        "body_text": "",
        "body_html": "",
        "folder": folder,
        "uid": str(uid),
    }


def item_from_header_bytes(header_bytes: bytes, uid: str, folder: str,
                           flag_info: Optional[dict[str, Any]] = None,
                           internaldate: Optional[datetime] = None,
                           has_attachments_hint: bool = False) -> dict[str, Any]:
    """列表场景：仅根据邮件头构造轻量 item。"""
    import email
    msg = email.message_from_bytes(header_bytes or b"")
    item = _blank_item(uid, folder)
    _populate_headers(item, msg)
    flag_info = flag_info or {}
    item["is_read"] = flag_info.get("is_read", False)
    item["categories"] = flag_info.get("categories", [])
    item["has_attachments"] = has_attachments_hint
    if internaldate:
        item["date_time_received"] = common.local_iso(internaldate)
    if not item["date_time_received"]:
        item["date_time_received"] = item["date_time_sent"]
    return item


def item_from_full_bytes(raw_bytes: bytes, uid: str, folder: str,
                         flag_info: Optional[dict[str, Any]] = None,
                         internaldate: Optional[datetime] = None,
                         include_payload: bool = True) -> dict[str, Any]:
    """详情场景：完整解析正文与附件。"""
    import email
    msg = email.message_from_bytes(raw_bytes or b"")
    item = _blank_item(uid, folder)
    _populate_headers(item, msg)
    body_text, body_html, attachments = extract_body_and_attachments(msg, include_payload=include_payload)
    item["body_text"] = body_text
    item["body_html"] = body_html
    item["attachments"] = attachments
    item["has_attachments"] = bool(attachments)
    # 给附件补上「uid:序号」附件 id（对标 attachment_id）
    for idx, att in enumerate(attachments, start=1):
        att["attachment_id"] = f"{uid}:{idx}"
    flag_info = flag_info or parse_imap_flags(None)
    item["is_read"] = flag_info.get("is_read", False)
    item["categories"] = flag_info.get("categories", [])
    if internaldate:
        item["date_time_received"] = common.local_iso(internaldate)
    if not item["date_time_received"]:
        item["date_time_received"] = item["date_time_sent"]
    item["preview"] = common.short_text(" ".join(body_text.split()), 200)
    return item


# ---------------------------------------------------------------------------
# 发送构造（对标京东 CreateItem / ReplyToItem / ForwardItem）
# ---------------------------------------------------------------------------

def _display_address(addr: str) -> str:
    name, email_addr = parseaddr(addr)
    if email_addr:
        return formataddr((decode_str(name), email_addr)) if name else email_addr
    return addr.strip()


def build_mime_message(*, from_email: str, from_name: str,
                       to_list: list[str], cc_list: list[str],
                       subject: str, body: str, body_type: str = "T",
                       attachments: Optional[list[str]] = None,
                       memory_attachments: Optional[list[dict]] = None,
                       importance: str = "Normal",
                       in_reply_to: str = "", references: str = "",
                       domain: str = "") -> Message:
    """构造一封 MIME 邮件。Bcc 不写入头部、仅作为 SMTP 信封收件人（在 core 中处理）。"""
    msg = Message() if False else None
    from email.message import EmailMessage
    message = EmailMessage()

    message["From"] = formataddr((from_name or "", from_email)) if from_name else from_email
    message["To"] = ", ".join(_display_address(a) for a in to_list)
    if cc_list:
        message["Cc"] = ", ".join(_display_address(a) for a in cc_list)
    message["Subject"] = subject
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=domain or from_email.split("@")[-1] or "qq.com")
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
    if references:
        message["References"] = references
    for key, value in importance_to_headers(importance).items():
        message[key] = value

    if (body_type or "T").upper() == "H":
        plain = html_to_text(body)
        message.set_content(plain or body)
        message.add_alternative(body, subtype="html")
    else:
        message.set_content(body)

    for path in attachments or []:
        _attach_file(message, path)
    for att in memory_attachments or []:
        attach_bytes(message, att.get("name", "attachment"),
                     att.get("_payload", b""), att.get("content_type", ""))
    return message


def _attach_file(message: Message, path: str) -> None:
    from pathlib import Path
    p = Path(path).expanduser()
    if not p.exists() or not p.is_file():
        raise common.QQMailError(f"attachment file not found: {path}")
    data = p.read_bytes()
    ctype, encoding = mimetypes.guess_type(p.name)
    if ctype is None or encoding is not None:
        maintype, subtype = "application", "octet-stream"
    else:
        maintype, subtype = ctype.split("/", 1)
    message.add_attachment(data, maintype=maintype, subtype=subtype, filename=p.name)


def attach_bytes(message: Message, filename: str, data: bytes,
                 content_type: str = "") -> None:
    """把内存中的字节（如转发原邮件的附件）加为附件。"""
    ctype = content_type or (mimetypes.guess_type(filename)[0] or "")
    if "/" in ctype:
        maintype, subtype = ctype.split("/", 1)
    else:
        maintype, subtype = "application", "octet-stream"
    message.add_attachment(data or b"", maintype=maintype, subtype=subtype,
                           filename=filename or "attachment")


def normalize_reply_subject(subject: str) -> str:
    """对标京东 _normalize_reply_subject。"""
    raw = common.safe_text(subject)
    if not raw:
        return "Re:"
    if raw.lower().startswith("re:"):
        return raw
    return f"Re: {raw}"


def normalize_forward_subject(subject: str) -> str:
    """对标京东 forward_mail 的主题处理。"""
    raw = common.safe_text(subject)
    if not raw:
        return "Fw:"
    if raw.lower().startswith(("fw:", "fwd:")):
        return raw
    return f"Fw: {raw}"


def quote_original(item: dict[str, Any]) -> str:
    """对标京东 _quote_original，使用中文引用头格式。"""
    sender = item.get("from") or item.get("sender") or {}
    sender_label = common.safe_text(sender.get("name")) or common.safe_text(sender.get("email")) or "原发件人"
    sent_at = common.safe_text(item.get("date_time_sent") or item.get("date_time_received"))
    subject = common.safe_text(item.get("subject"))
    body = common.safe_text(item.get("body_text") or item.get("preview"))
    quoted_lines = [f"> {line}" if line else ">" for line in body.splitlines()] if body else [">"]
    header = [
        "",
        "",
        "----- 原邮件 -----",
        f"发件人: {sender_label}",
        f"时间: {sent_at}",
        f"主题: {subject}",
        "",
    ]
    return "\n".join(header + quoted_lines)
