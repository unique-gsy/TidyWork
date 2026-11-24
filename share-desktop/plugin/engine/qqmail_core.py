#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - QQ 邮箱核心库（对标京东 soap_mail.py）。

京东后端为 Exchange EWS/SOAP，本模块换芯为 QQ 邮箱：
  * 收信/文件夹/整理：IMAP（imaplib）
  * 发信/回复/转发：SMTP（smtplib）
  * 统一字段（folder/item/attachment）与业务规则（默认时间窗、客户端精筛、
    线程判断、统计口径、联系人）与京东保持一致，CLI/SKILL 可直接复用。

B 阶段的 CalDAV 日程不在本文件。
"""

from __future__ import annotations

import contextlib
import imaplib
import re
import smtplib
import time
from datetime import datetime, timedelta
from email.message import Message
from pathlib import Path
from typing import Any, Optional
from zoneinfo import ZoneInfo

import qqmail_common as common
import qqmail_mime as mime

# imaplib 命令回显较多，A 阶段保持可读输出
imaplib.Commands  # noqa: B018  确保模块加载


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------

_IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def imap_date(dt: datetime) -> str:
    """IMAP SEARCH 日期（英文月份，避免中文 locale 影响）。"""
    return f"{dt.day:02d}-{_IMAP_MONTHS[dt.month - 1]}-{dt.year}"


def quote_mailbox(name: str) -> str:
    """把文件夹名转为可用于 IMAP 命令的形式。

    - 中文等非 ASCII 名先编码为 modified UTF-7（如 ``测试`` -> ``&bUuWl,T-``）；
    - 含空格/特殊字符的名字加 IMAP 双引号（如 "Sent Messages"）。
    """
    if not name:
        return "INBOX"
    if name.upper() == "INBOX":
        return "INBOX"
    if any(ord(ch) > 0x7E for ch in name):
        name = mime.imap_utf7_encode(name)
    if name.startswith('"'):
        return name
    if re.search(r'[\s()\"%*\[\]]', name):
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return name


def _ascii(value: str) -> str:
    return value


# ---------------------------------------------------------------------------
# 连接
# ---------------------------------------------------------------------------

def connect_imap(cfg: common.Config) -> imaplib.IMAP4:
    last_error: Optional[Exception] = None
    for attempt in range(common.DEFAULT_LOGIN_RETRY_TIMES):
        try:
            if cfg.imap_ssl:
                conn = imaplib.IMAP4_SSL(cfg.imap_host, cfg.imap_port, timeout=common.DEFAULT_TIMEOUT)
            else:
                conn = imaplib.IMAP4(cfg.imap_host, cfg.imap_port, timeout=common.DEFAULT_TIMEOUT)
            conn.debug = 0
            conn.login(cfg.email, cfg.auth_code)
            return conn
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if attempt < common.DEFAULT_LOGIN_RETRY_TIMES - 1:
                time.sleep(1 + attempt)
    raise common.QQMailError(f"IMAP 登录失败（{cfg.imap_host}）：{last_error}")


# ---------------------------------------------------------------------------
# 核心客户端
# ---------------------------------------------------------------------------

class QQMailClient:
    """聚合邮件读写能力；对标京东 soap_mail 的模块级函数。"""

    def __init__(self, cfg: common.Config):
        self.cfg = cfg
        self._folder_rows: list[dict[str, Any]] = []
        self._special: dict[str, str] = {}

    # ------------------------------------------------------------------
    # 连接上下文
    # ------------------------------------------------------------------

    @contextlib.contextmanager
    def imap(self):
        common.assert_config_ready(self.cfg)
        conn = connect_imap(self.cfg)
        try:
            yield conn
        finally:
            with contextlib.suppress(Exception):
                conn.close()
            with contextlib.suppress(Exception):
                conn.logout()

    @contextlib.contextmanager
    def _selected(self, conn: imaplib.IMAP4, folder: str, readonly: bool = True):
        mailbox = quote_mailbox(self.resolve_folder(folder))
        typ, data = conn.select(mailbox, readonly=readonly)
        if typ != "OK":
            raise common.QQMailError(f"无法打开文件夹 {folder}：{data}")
        try:
            yield conn
        finally:
            with contextlib.suppress(Exception):
                conn.close()

    # ------------------------------------------------------------------
    # 文件夹（对标 list_folders / create_folder / resolve_folder_by_name）
    # ------------------------------------------------------------------

    # 系统文件夹的 SPECIAL-USE 标记 -> 逻辑名
    _MARK_TO_LOGICAL = {
        "\\Inbox": "inbox",
        "\\Sent": "sentitems",
        "\\Drafts": "drafts",
        "\\Trash": "deleteditems",
        "\\Deleted": "deleteditems",
        "\\Junk": "junkemail",
    }
    # 系统文件夹的英文/中文候选名（QQ 通常不返回 SPECIAL-USE 标记，需按名兜底）
    _LOGICAL_BY_NAME = {
        "inbox": {"INBOX", "收件箱"},
        "sentitems": {"Sent Messages", "Sent", "Sent Items", "已发送", "已发送邮件", "发件箱"},
        "drafts": {"Drafts", "Draft", "草稿箱", "草稿"},
        "deleteditems": {"Deleted Messages", "Trash", "Deleted Items", "Deleted",
                         "已删除", "已删除邮件", "回收站"},
        "junkemail": {"Junk", "Junk E-mail", "Junk Email", "垃圾邮件", "垃圾箱"},
    }
    _CN_LOGICAL = {
        "收件箱": "inbox",
        "已发送": "sentitems", "已发送邮件": "sentitems", "发件箱": "sentitems",
        "草稿箱": "drafts", "草稿": "drafts",
        "已删除": "deleteditems", "已删除邮件": "deleteditems", "回收站": "deleteditems",
        "垃圾邮件": "junkemail", "垃圾箱": "junkemail",
    }

    @staticmethod
    def _parse_list_line(line: str) -> Optional[dict[str, Any]]:
        """解析 LIST 行，兼容 '* LIST (...)'、'LIST (...)' 与 imaplib 裸行 '(...)'。"""
        line = line.strip()
        if line.startswith("* LIST"):
            line = line[6:].strip()
        elif line.startswith("LIST"):
            line = line[4:].strip()
        match = re.match(r'^\((?P<attrs>.*?)\)\s+(?P<delim>"[^"]*"|\S+)\s+(?P<name>.*)$', line)
        if not match:
            return None
        attrs = match.group("attrs")
        name_raw = match.group("name").strip()
        if name_raw.startswith('"') and name_raw.endswith('"'):
            name = name_raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
        else:
            name = name_raw
        attr_set = {a.strip() for a in attrs.split() if a.strip()}
        return {"name": name, "display": mime.imap_utf7_decode(name), "attrs": attr_set}

    def _load_folders(self, conn: imaplib.IMAP4) -> list[dict[str, Any]]:
        if self._folder_rows:
            return self._folder_rows
        typ, data = conn.list()
        if typ != "OK":
            raise common.QQMailError(f"获取文件夹列表失败：{data}")
        rows: list[dict[str, Any]] = []
        for raw in data or []:
            if not raw:
                continue
            line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            parsed = self._parse_list_line(line)
            if parsed:
                rows.append(parsed)
        special: dict[str, str] = {}
        # 1) RFC6154 SPECIAL-USE 标记
        for row in rows:
            for mark, logical in self._MARK_TO_LOGICAL.items():
                if mark in row["attrs"] and logical not in special:
                    special[logical] = row["name"]
        # 2) 标记缺失时按固定英文名 / 中文名兜底（要求该文件夹真实存在）
        for logical, candidates in self._LOGICAL_BY_NAME.items():
            if logical in special:
                continue
            for row in rows:
                if row["name"] in candidates or row["display"] in candidates:
                    special[logical] = row["name"]
                    break
        # 固定默认值（即使 LIST 未返回，QQ 通常也支持这些邮箱）
        special["inbox"] = "INBOX"
        special.setdefault("sentitems", "Sent Messages")
        special.setdefault("drafts", "Drafts")
        special.setdefault("deleteditems", "Deleted Messages")
        special.setdefault("junkemail", "Junk")
        self._folder_rows = rows
        self._special = special
        return rows

    def _status_counts(self, conn: imaplib.IMAP4, mailbox: str) -> tuple[int, int]:
        try:
            typ, data = conn.status(quote_mailbox(mailbox), "(MESSAGES UNSEEN)")
            if typ == "OK" and data:
                text = data[0].decode("utf-8", errors="replace") if isinstance(data[0], bytes) else str(data[0])
                messages = re.search(r"MESSAGES\s+(\d+)", text)
                unseen = re.search(r"UNSEEN\s+(\d+)", text)
                return (int(messages.group(1)) if messages else 0,
                        int(unseen.group(1)) if unseen else 0)
        except Exception:
            pass
        return 0, 0

    def list_folders(self) -> list[dict[str, Any]]:
        """返回与京东一致的 folder 结构。"""
        with self.imap() as conn:
            rows = self._load_folders(conn)
            folders: list[dict[str, Any]] = []
            for row in rows:
                lname = row["name"]
                display = row["display"]
                attrs = row["attrs"]
                logical = self._logical_for(lname, attrs, display)
                total, unread = self._status_counts(conn, lname)
                has_children = "\\HasChildren" in attrs
                no_children = "\\HasNoChildren" in attrs
                folders.append({
                    "id": lname,
                    "change_key": "",
                    "parent_id": "",
                    "display_name": display,
                    "folder_class": logical,
                    "total_count": total,
                    "unread_count": unread,
                    "child_folder_count": 0 if no_children or not has_children else 1,
                })
            return folders

    def _logical_for(self, lname: str, attrs: set[str], display: str = "") -> str:
        for mark, logical in self._MARK_TO_LOGICAL.items():
            if mark in attrs:
                return logical
        for logical, candidates in self._LOGICAL_BY_NAME.items():
            if lname in candidates or display in candidates:
                return logical
        return "usercreated"

    def create_folder(self, display_name: str) -> dict[str, Any]:
        """对标 create_folder；QQ 为 IMAP CREATE（中文自动转 modified UTF-7）。"""
        name = common.safe_text(display_name)
        if not name:
            raise common.QQMailError("missing folder display_name")
        encoded = mime.imap_utf7_encode(name) if any(ord(c) > 127 for c in name) else name
        with self.imap() as conn:
            self._load_folders(conn)
            if any(r["name"] == encoded or r["display"] == name for r in self._folder_rows):
                raise common.QQMailError(f"文件夹已存在：{name}")
            typ, data = conn.create(quote_mailbox(name))
            if typ != "OK":
                raise common.QQMailError(f"创建文件夹失败：{data}")
            self._folder_rows = []
            self._special = {}
        return {"display_name": name, "id": encoded}

    def resolve_folder(self, folder: str) -> str:
        """逻辑名（inbox/sentitems/...）、中文系统名或自定义文件夹名 -> 实际 IMAP 名。"""
        raw = common.safe_text(folder) or "inbox"
        if raw.upper() == "INBOX" or raw in ("收件箱",):
            return "INBOX"
        # 中文系统文件夹名 -> 逻辑名
        canon = self._CN_LOGICAL.get(raw) or common.normalize_logical_folder(raw.lower())
        if canon in self._special:
            return self._special[canon]
        if not self._folder_rows:
            with self.imap() as conn:
                self._load_folders(conn)
        if canon in self._special:
            return self._special[canon]
        # 自定义文件夹：中文显示名 / 原始 IMAP 名 / 中文输入需编码
        encoded = mime.imap_utf7_encode(raw) if any(ord(c) > 127 for c in raw) else raw
        for row in self._folder_rows:
            if row["display"] == raw or row["name"] == raw or row["name"] == encoded:
                return row["name"]
        # 交给 select 兜底（可能是新建尚未缓存的文件夹）
        return encoded

    # ------------------------------------------------------------------
    # 搜索（对标 fetch_items_pages + apply_filters）
    # ------------------------------------------------------------------

    @staticmethod
    def _resolved_search_window(filters: common.MailSearchFilters) -> tuple[datetime, datetime]:
        """默认近 1 天；对标京东 _resolved_search_window。"""
        after = common.parse_date_boundary(filters.after)
        before = common.parse_date_boundary(filters.before, end_of_day=True)
        now = common.local_now()
        if before is None:
            before = now
        if after is None:
            after = now - timedelta(days=common.DEFAULT_SEARCH_LOOKBACK_DAYS)
        if after > before:
            after = before
        return after, before

    def _server_search_uids(self, conn: imaplib.IMAP4, mailbox: str,
                            filters: common.MailSearchFilters,
                            after: datetime, before: datetime) -> list[str]:
        """服务端粗筛：时间 + 已读/未读（ASCII 稳定，避免中文 SEARCH 编码问题）。"""
        criteria = ["SINCE", imap_date(after), "BEFORE", imap_date(before + timedelta(days=1))]
        if filters.unread_only:
            criteria.append("UNSEEN")
        if filters.read_only:
            criteria.append("SEEN")
        typ, data = conn.uid("SEARCH", *criteria)
        if typ != "OK":
            raise common.QQMailError(f"搜索失败：{data}")
        tokens = (data[0] or b"").split() if data and data[0] else []
        uids = [t.decode("ascii") for t in tokens]
        uids.reverse()  # 新 -> 旧
        return uids

    @staticmethod
    def _extract_meta(prefix: bytes) -> dict[str, Any]:
        uid = re.search(rb"UID\s+(\d+)", prefix)
        flags = re.search(rb"FLAGS\s+\(([^)]*)\)", prefix)
        internaldate = re.search(rb'INTERNALDATE\s+"([^"]+)"', prefix)
        struct_start = prefix.find(b"BODYSTRUCTURE")
        struct_end = prefix.find(b"BODY[HEADER]")
        struct = prefix[struct_start:struct_end] if struct_start >= 0 and struct_end >= 0 else b""
        return {
            "uid": uid.group(1).decode("ascii") if uid else "",
            "flags": flags.group(1).decode("utf-8", errors="replace").split() if flags else [],
            "internaldate": internaldate.group(1).decode("ascii") if internaldate else "",
            "has_attachment_hint": b"attachment" in struct.lower(),
        }

    def _fetch_meta_batch(self, conn: imaplib.IMAP4, uids: list[str], folder: str) -> list[dict[str, Any]]:
        if not uids:
            return []
        uidset = ",".join(uids)
        items_spec = "(UID FLAGS INTERNALDATE BODYSTRUCTURE BODY.PEEK[HEADER])"
        typ, data = conn.uid("FETCH", uidset, items_spec)
        if typ != "OK":
            raise common.QQMailError(f"拉取邮件失败：{data}")
        items: list[dict[str, Any]] = []
        for chunk in data or []:
            if not isinstance(chunk, tuple):
                continue
            prefix, header_bytes = chunk[0], chunk[1]
            meta = self._extract_meta(prefix)
            if not meta["uid"]:
                continue
            flag_info = mime.parse_imap_flags(meta["flags"])
            internaldate = mime.parse_imap_internaldate(meta["internaldate"])
            item = mime.item_from_header_bytes(
                header_bytes, meta["uid"], folder,
                flag_info=flag_info, internaldate=internaldate,
                has_attachments_hint=meta["has_attachment_hint"],
            )
            items.append(item)
        return items

    def apply_filters(self, item: dict[str, Any], filters: common.MailSearchFilters,
                      after: datetime, before: datetime) -> bool:
        """客户端精筛（对标京东 apply_filters，口径一致）。"""
        if filters.sender:
            haystack = " ".join([
                (item.get("from") or {}).get("name", ""),
                (item.get("from") or {}).get("email", ""),
                (item.get("sender") or {}).get("name", ""),
                (item.get("sender") or {}).get("email", ""),
            ])
            if not common.contains(haystack, filters.sender):
                return False
        if filters.recipient:
            haystack = " ".join(
                [box.get("name", "") + " " + box.get("email", "")
                 for box in item.get("to_recipients", []) + item.get("cc_recipients", [])]
                + [(item.get("from") or {}).get("email", "")]
            )
            if not common.contains(haystack, filters.recipient):
                return False
        if filters.subject and not common.contains(item.get("subject", ""), filters.subject):
            return False
        if filters.body_keyword:
            haystack = item.get("subject", "") + " " + item.get("preview", "")
            if not common.contains(haystack, filters.body_keyword):
                return False
        if filters.unread_only and item.get("is_read"):
            return False
        if filters.read_only and not item.get("is_read"):
            return False
        if filters.has_attachments and not item.get("has_attachments"):
            return False
        if filters.importance and item.get("importance", "").lower() != filters.importance.lower():
            return False
        if filters.category:
            categories = " ".join(item.get("categories", []))
            if not common.contains(categories, filters.category):
                return False
        received = common.parse_date_boundary(item.get("date_time_received", ""))
        if received is None:
            received = common.parse_date_boundary(item.get("date_time_sent", ""))
        if received is not None:
            if after and received < after:
                return False
            if before and received > before:
                return False
        return True

    @staticmethod
    def _item_sort_key(item: dict[str, Any]) -> tuple[datetime, int]:
        """排序键：收件时间（缺失回退发件时间），再按 UID。"""
        dt = (common.parse_date_boundary(item.get("date_time_received", ""))
              or common.parse_date_boundary(item.get("date_time_sent", "")))
        if dt is None:
            dt = datetime.min.replace(tzinfo=common.effective_local_tz())
        try:
            uid = int(item.get("uid") or 0)
        except (TypeError, ValueError):
            uid = 0
        return (dt, uid)

    def search_items(self, folder: str = "inbox", filters: Optional[common.MailSearchFilters] = None,
                     limit: int = 50, page_size: int = 100, max_pages: int = 10) -> list[dict[str, Any]]:
        filters = filters or common.MailSearchFilters()
        after, before = self._resolved_search_window(filters)
        target = self.resolve_folder(folder)
        results: list[dict[str, Any]] = []
        with self.imap() as conn:
            with self._selected(conn, target, readonly=True):
                uids = self._server_search_uids(conn, target, filters, after, before)
                pages = 0
                for start in range(0, len(uids), page_size):
                    if pages >= max_pages:
                        break
                    batch = uids[start:start + page_size]
                    for item in self._fetch_meta_batch(conn, batch, folder):
                        if self.apply_filters(item, filters, after, before):
                            results.append(item)
                    pages += 1
        # QQ 的 UID 与收件时间可能不完全一致（历史导入），统一按时间倒序保证“最近优先”
        results.sort(key=self._item_sort_key, reverse=True)
        return results[:limit]

    # ------------------------------------------------------------------
    # 详情 / 附件（对标 get_item_detail / get_attachment_detail）
    # ------------------------------------------------------------------

    def _fetch_full(self, conn: imaplib.IMAP4, uid: str, folder: str) -> dict[str, Any]:
        typ, data = conn.uid("FETCH", uid, "(UID FLAGS INTERNALDATE BODY.PEEK[])")
        if typ != "OK" or not data:
            raise common.QQMailError(f"未找到邮件 {uid}")
        raw: Optional[bytes] = None
        flags: list[str] = []
        internaldate = ""
        for chunk in data:
            if isinstance(chunk, tuple):
                prefix = chunk[0]
                fm = re.search(rb"FLAGS\s+\(([^)]*)\)", prefix)
                idm = re.search(rb'INTERNALDATE\s+"([^"]+)"', prefix)
                if fm:
                    flags = fm.group(1).decode("utf-8", errors="replace").split()
                if idm:
                    internaldate = idm.group(1).decode("ascii")
                raw = chunk[1]
                break
        if raw is None:
            raise common.QQMailError(f"未找到邮件 {uid}")
        flag_info = mime.parse_imap_flags(flags)
        idt = mime.parse_imap_internaldate(internaldate)
        return mime.item_from_full_bytes(raw, uid, folder, flag_info=flag_info,
                                         internaldate=idt, include_payload=True)

    def get_item_detail(self, item_id: str, folder: str = "inbox") -> dict[str, Any]:
        uid = common.safe_text(item_id)
        if not uid:
            raise common.QQMailError("missing item_id")
        target = self.resolve_folder(folder)
        with self.imap() as conn:
            with self._selected(conn, target, readonly=True):
                item = self._fetch_full(conn, uid, folder)
        # 下载载荷不放进 JSON
        for att in item.get("attachments", []):
            att.pop("_payload", None)
        return item

    def attachment_check(self, item_id: str, folder: str = "inbox") -> dict[str, Any]:
        """对标 check_attachment_reachability：列出附件基本信息。"""
        uid = common.safe_text(item_id)
        target = self.resolve_folder(folder)
        with self.imap() as conn:
            with self._selected(conn, target, readonly=True):
                item = self._fetch_full(conn, uid, folder)
        attachments = []
        for att in item.get("attachments", []):
            attachments.append({
                "attachment_id": att.get("attachment_id"),
                "name": att.get("name"),
                "content_type": att.get("content_type"),
                "size": att.get("size"),
                "is_inline": att.get("is_inline"),
            })
        return {"item_id": uid, "subject": item.get("subject"), "attachments": attachments}

    def download_attachment(self, item_id: str, attachment_index: str, folder: str = "inbox",
                            out_dir: str = "") -> dict[str, Any]:
        """对标 download_attachment；attachment_index 为「uid:序号」中的序号或 attachment_id。"""
        uid = common.safe_text(item_id)
        target = self.resolve_folder(folder)
        # attachment_index 可能是完整 "uid:idx" 或纯 idx
        idx_text = common.safe_text(attachment_index)
        if ":" in idx_text:
            idx_text = idx_text.split(":", 1)[1]
        idx = int(idx_text) if idx_text.isdigit() else 1
        with self.imap() as conn:
            with self._selected(conn, target, readonly=True):
                item = self._fetch_full(conn, uid, folder)
        attachments = item.get("attachments", [])
        if not attachments:
            raise common.QQMailError("该邮件没有附件")
        if idx < 1 or idx > len(attachments):
            raise common.QQMailError(f"附件序号超出范围：{idx}（共 {len(attachments)} 个）")
        att = attachments[idx - 1]
        payload = att.get("_payload", b"")
        save_dir = Path(out_dir).expanduser() if out_dir else Path(
            self.cfg.download_dir or (common.package_root() / "downloads"))
        save_dir.mkdir(parents=True, exist_ok=True)
        filename = att.get("name") or f"attachment_{idx}"
        out_path = save_dir / filename
        # 同名文件避让
        counter = 1
        stem, suffix = out_path.stem, out_path.suffix
        while out_path.exists():
            out_path = save_dir / f"{stem}_{counter}{suffix}"
            counter += 1
        out_path.write_bytes(payload)
        return {
            "attachment_id": att.get("attachment_id"),
            "name": filename,
            "size": len(payload),
            "saved_path": str(out_path),
        }

    # ------------------------------------------------------------------
    # 发信 / 回复 / 转发（对标 send_new_mail / send_reply_mail / forward_mail）
    # ------------------------------------------------------------------

    def _sender_name(self) -> str:
        return self.cfg.display_name or self.cfg.email.split("@")[0]

    @staticmethod
    def _norm_addresses(raw: Any) -> list[str]:
        if isinstance(raw, (list, tuple)):
            items = []
            for item in raw:
                items.extend(common.split_addresses(item))
            return common.dedupe_preserve_order(items)
        return common.dedupe_preserve_order(common.split_addresses(str(raw or "")))

    def _check_local_attachments(self, attachments: list[str]) -> list[str]:
        paths = []
        for raw in attachments or []:
            p = Path(raw).expanduser()
            if not p.exists() or not p.is_file():
                raise common.QQMailError(f"附件不存在：{raw}")
            paths.append(str(p))
        return paths

    def _smtp_send(self, message: Message, envelope_to: list[str]) -> None:
        cfg = self.cfg
        last_error: Optional[Exception] = None
        for attempt in range(common.DEFAULT_LOGIN_RETRY_TIMES):
            try:
                if cfg.smtp_ssl:
                    server = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=common.DEFAULT_TIMEOUT)
                else:
                    server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=common.DEFAULT_TIMEOUT)
                    server.starttls()
                try:
                    server.login(cfg.email, cfg.auth_code)
                    server.send_message(message, from_addr=cfg.email, to_addrs=envelope_to)
                finally:
                    with contextlib.suppress(Exception):
                        server.quit()
                return
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt < common.DEFAULT_LOGIN_RETRY_TIMES - 1:
                    time.sleep(1 + attempt)
        raise common.QQMailError(f"SMTP 发送失败（{cfg.smtp_host}）：{last_error}")

    def _append_to_sent(self, message: Message) -> bool:
        """SMTP 不自动保存已发送，发送成功后用 IMAP APPEND 存到已发送（对齐 EWS 行为）。

        成功返回 True；失败不致命（邮件已投递，仅缺已发送副本），返回 False。
        """
        try:
            sent = self.resolve_folder("sentitems")
            msg_bytes = message.as_bytes()
            internaldate = imaplib.Time2Internaldate(time.time())
            with self.imap() as conn:
                typ, _data = conn.append(quote_mailbox(sent), r"\Seen", internaldate, msg_bytes)
            return typ == "OK"
        except Exception:
            return False

    def _smtp_send_and_archive(self, message: Message, envelope_to: list[str]) -> bool:
        """发信并把副本存到已发送；返回是否成功保存副本。"""
        self._smtp_send(message, envelope_to)
        return self._append_to_sent(message)

    def send_mail(self, to_raw: Any, subject: str, body: str,
                  cc_raw: Any = "", bcc_raw: Any = "", body_type: str = "T",
                  attachments: Optional[list[str]] = None, importance: str = "Normal") -> dict[str, Any]:
        common.assert_config_ready(self.cfg)
        to_list = self._norm_addresses(to_raw)
        cc_list = self._norm_addresses(cc_raw)
        bcc_list = self._norm_addresses(bcc_raw)
        if not to_list:
            raise common.QQMailError("missing recipient: to")
        subject = common.safe_text(subject)
        if not subject:
            raise common.QQMailError("missing subject")
        attachment_paths = self._check_local_attachments(attachments or [])
        message = mime.build_mime_message(
            from_email=self.cfg.email, from_name=self._sender_name(),
            to_list=to_list, cc_list=cc_list, subject=subject,
            body=body or "", body_type=body_type, attachments=attachment_paths,
            importance=importance,
        )
        envelope = common.dedupe_preserve_order(to_list + cc_list + bcc_list)
        archived = self._smtp_send_and_archive(message, envelope)
        return {
            "message_id": message.get("Message-ID", "").strip(),
            "to": to_list,
            "cc": cc_list,
            "bcc_count": len(bcc_list),
            "subject": subject,
            "status": "sent",
            "saved_to_sent": archived,
        }

    def _build_reply_headers(self, source: dict[str, Any]) -> tuple[str, str]:
        """返回 (In-Reply-To, References)。"""
        message_id = common.safe_text(source.get("message_id"))
        refs = common.safe_text(source.get("references"))
        if message_id:
            refs = (refs + " " + message_id).strip()
        refs = " ".join(refs.split())
        return message_id, refs

    def _reply_recipients(self, source: dict[str, Any], reply_all: bool,
                          extra_cc: list[str], extra_bcc: list[str]) -> tuple[list[str], list[str], list[str]]:
        """对标京东 _reply_all_recipients（含普通回复分支）。

        普通回复：回原发件人；若原发件人是自己（在已发送箱回复 / 自发自收），
        回退给原邮件首个非自己收件人，全是自己时回给自己。
        """
        current = self.cfg.email.lower()
        sender = common.safe_text((source.get("from") or source.get("sender") or {}).get("email"))
        if not sender:
            raise common.QQMailError("无法识别原邮件发件人，不能回复")
        extra_cc = [a for a in extra_cc if a.lower() != current]
        extra_bcc = [a for a in extra_bcc if a.lower() != current]
        if not reply_all:
            if sender.lower() != current:
                to_list = [sender]
            else:
                to_boxes = [box.get("email", "") for box in source.get("to_recipients", [])]
                fallback = next((a for a in to_boxes if a and a.lower() != current), "")
                to_list = [fallback] if fallback else [sender]
            return (to_list, common.dedupe_preserve_order(extra_cc),
                    common.dedupe_preserve_order(extra_bcc))
        raw_cc = [box.get("email", "") for box in
                  source.get("to_recipients", []) + source.get("cc_recipients", [])] + extra_cc
        raw_to = [sender]
        to_list = common.dedupe_preserve_order(
            [a for a in raw_to if a and a.lower() != current])
        cc_list = common.dedupe_preserve_order(
            [a for a in raw_cc if a and a.lower() != current and a.lower() != sender.lower()])
        bcc_list = common.dedupe_preserve_order(extra_bcc)
        if to_list:
            final_to = [to_list[0]]
            final_cc = common.dedupe_preserve_order(cc_list + to_list[1:])
        else:
            # 全员都是自己（自发自收）：回给自己
            final_to = [sender]
            final_cc = []
        return final_to, final_cc, bcc_list

    def reply_mail(self, item_id: str, body: str, folder: str = "inbox",
                   reply_all: bool = False, cc_raw: Any = "", bcc_raw: Any = "",
                   body_type: str = "T", with_quote: bool = True,
                   attachments: Optional[list[str]] = None, importance: str = "Normal") -> dict[str, Any]:
        common.assert_config_ready(self.cfg)
        uid = common.safe_text(item_id)
        if not uid:
            raise common.QQMailError("missing item_id")
        target = self.resolve_folder(folder)
        extra_cc = self._norm_addresses(cc_raw)
        extra_bcc = self._norm_addresses(bcc_raw)
        with self.imap() as conn:
            with self._selected(conn, target, readonly=True):
                source = self._fetch_full(conn, uid, folder)
        to_list, cc_list, bcc_list = self._reply_recipients(source, reply_all, extra_cc, extra_bcc)
        if not to_list:
            raise common.QQMailError("无法确定回复收件人（可能原邮件发件人就是自己）")
        subject = mime.normalize_reply_subject(source.get("subject", ""))
        final_body = body or ""
        if with_quote:
            final_body = (final_body.rstrip() + mime.quote_original(source))
        in_reply_to, references = self._build_reply_headers(source)
        attachment_paths = self._check_local_attachments(attachments or [])
        message = mime.build_mime_message(
            from_email=self.cfg.email, from_name=self._sender_name(),
            to_list=to_list, cc_list=cc_list, subject=subject,
            body=final_body, body_type=body_type, attachments=attachment_paths,
            importance=importance, in_reply_to=in_reply_to, references=references,
        )
        envelope = common.dedupe_preserve_order(to_list + cc_list + bcc_list)
        archived = self._smtp_send_and_archive(message, envelope)
        return {
            "message_id": message.get("Message-ID", "").strip(),
            "to": to_list,
            "cc": cc_list,
            "bcc_count": len(bcc_list),
            "subject": subject,
            "reply_all": bool(reply_all),
            "status": "sent",
            "saved_to_sent": archived,
        }

    def forward_mail(self, item_id: str, to_raw: Any, body: str, folder: str = "inbox",
                     cc_raw: Any = "", bcc_raw: Any = "", body_type: str = "T",
                     attachments: Optional[list[str]] = None) -> dict[str, Any]:
        common.assert_config_ready(self.cfg)
        uid = common.safe_text(item_id)
        if not uid:
            raise common.QQMailError("missing item_id")
        target = self.resolve_folder(folder)
        to_list = self._norm_addresses(to_raw)
        cc_list = self._norm_addresses(cc_raw)
        bcc_list = self._norm_addresses(bcc_raw)
        if not to_list:
            raise common.QQMailError("missing recipient: to")
        with self.imap() as conn:
            with self._selected(conn, target, readonly=True):
                source = self._fetch_full(conn, uid, folder)
        subject = mime.normalize_forward_subject(source.get("subject", ""))
        final_body = (body or "").rstrip() + mime.quote_original(source)
        in_reply_to, references = self._build_reply_headers(source)
        attachment_paths = self._check_local_attachments(attachments or [])
        # 转发时自动携带原邮件的非内嵌附件
        forwarded_atts = [
            a for a in source.get("attachments", [])
            if not a.get("is_inline") and a.get("_payload") is not None
        ]
        message = mime.build_mime_message(
            from_email=self.cfg.email, from_name=self._sender_name(),
            to_list=to_list, cc_list=cc_list, subject=subject,
            body=final_body, body_type=body_type, attachments=attachment_paths,
            memory_attachments=forwarded_atts,
            importance=source.get("importance", "Normal"),
            in_reply_to=in_reply_to, references=references,
        )
        envelope = common.dedupe_preserve_order(to_list + cc_list + bcc_list)
        archived = self._smtp_send_and_archive(message, envelope)
        return {
            "message_id": message.get("Message-ID", "").strip(),
            "to": to_list,
            "cc": cc_list,
            "bcc_count": len(bcc_list),
            "subject": subject,
            "status": "forwarded",
            "saved_to_sent": archived,
        }

    # ------------------------------------------------------------------
    # 整理操作（对标 batch-mark / flag / category / move / delete）
    # ------------------------------------------------------------------

    @staticmethod
    def _uidset(item_ids: Any) -> tuple[str, list[str]]:
        if isinstance(item_ids, str):
            ids = common.split_item_ids(item_ids)
        else:
            ids = [str(i).strip() for i in item_ids if str(i).strip()]
        if not ids:
            raise common.QQMailError("missing item_ids")
        return ",".join(ids), ids

    def _store_flags(self, conn: imaplib.IMAP4, uidset: str, flag_expr: str, add: bool) -> None:
        op = "+FLAGS" if add else "-FLAGS"
        typ, data = conn.uid("STORE", uidset, op, flag_expr)
        if typ != "OK":
            raise common.QQMailError(f"更新标记失败 {flag_expr}：{data}")

    def _batch_flag_op(self, item_ids: Any, folder: str, system_flag: str, add: bool) -> dict[str, Any]:
        uidset, ids = self._uidset(item_ids)
        target = self.resolve_folder(folder)
        with self.imap() as conn:
            with self._selected(conn, target, readonly=False):
                self._store_flags(conn, uidset, f"({system_flag})", add)
        return {"updated": len(ids), "item_ids": ids}

    def mark_read(self, item_ids: Any, folder: str = "inbox") -> dict[str, Any]:
        return self._batch_flag_op(item_ids, folder, r"\Seen", True)

    def mark_unread(self, item_ids: Any, folder: str = "inbox") -> dict[str, Any]:
        return self._batch_flag_op(item_ids, folder, r"\Seen", False)

    def flag_items(self, item_ids: Any, folder: str = "inbox") -> dict[str, Any]:
        result = self._batch_flag_op(item_ids, folder, r"\Flagged", True)
        single = len(result["item_ids"]) == 1
        if single:
            return {"item_id": result["item_ids"][0], "flagged": True}
        return {"updated": result["updated"], "item_ids": result["item_ids"]}

    def unflag_items(self, item_ids: Any, folder: str = "inbox") -> dict[str, Any]:
        result = self._batch_flag_op(item_ids, folder, r"\Flagged", False)
        single = len(result["item_ids"]) == 1
        if single:
            return {"item_id": result["item_ids"][0], "flagged": False}
        return {"updated": result["updated"], "item_ids": result["item_ids"]}

    def add_category(self, item_ids: Any, category: str, folder: str = "inbox") -> dict[str, Any]:
        """自定义分类 = IMAP 自定义 keyword。

        IMAP keyword 必须是 ASCII atom（不支持中文/空格）；部分服务商（如 QQ 邮箱）
        即使返回 OK 也会静默丢弃自定义 keyword。这里 STORE 后回读 FLAGS 验证，
        未真正保存时如实报错，避免“假装成功”。
        """
        label = common.safe_text(category)
        if not label:
            raise common.QQMailError("missing category")
        # IMAP keyword 仅允许字母/数字/下划线/点/连字符；中文等非 ASCII 无法作为 keyword
        if re.search(r"[^A-Za-z0-9_.-]", label):
            raise common.QQMailError(
                "自定义分类标签仅支持英文/数字/下划线/点/连字符（IMAP keyword 不支持中文或空格）。"
                "若要归类中文主题，建议改用「移动到同名文件夹」或「加星标」。"
            )
        keyword = label
        uidset, ids = self._uidset(item_ids)
        target = self.resolve_folder(folder)
        with self.imap() as conn:
            with self._selected(conn, target, readonly=False):
                self._store_flags(conn, uidset, f"({keyword})", True)
                # 回读第一个 UID，确认服务器是否真的保存了该 keyword
                probe = ids[0]
                typ, data = conn.uid("FETCH", probe, "(FLAGS)")
                saved = False
                for chunk in data or []:
                    if isinstance(chunk, bytes):
                        m = re.search(rb"FLAGS \(([^)]*)\)", chunk)
                        if m and keyword.encode("ascii") in m.group(1).split():
                            saved = True
        if not saved:
            raise common.QQMailError(
                "当前邮箱（QQ 邮箱）不保存自定义分类标签：IMAP 命令虽返回成功，但服务器未保留该标签。"
                "建议改用「移动到同名文件夹」或「加星标」实现归类。"
            )
        return {"updated": len(ids), "category": label, "item_ids": ids}

    def _move_uids(self, conn: imaplib.IMAP4, uidset: str, dest_mailbox: str) -> str:
        """优先 UID MOVE；不支持则 COPY + 标记删除 + EXPUNGE。"""
        move_supported = "MOVE" in getattr(conn, "capabilities", ()) or True
        if move_supported:
            try:
                typ, data = conn.uid("MOVE", uidset, quote_mailbox(dest_mailbox))
                if typ == "OK":
                    return "MOVE"
            except imaplib.IMAP4.error:
                pass
        typ, data = conn.uid("COPY", uidset, quote_mailbox(dest_mailbox))
        if typ != "OK":
            raise common.QQMailError(f"复制到目标文件夹失败：{data}")
        self._store_flags(conn, uidset, r"(\Deleted)", True)
        conn.expunge()
        return "COPY+EXPUNGE"

    def move_items(self, item_ids: Any, target_folder: str, source_folder: str = "inbox") -> dict[str, Any]:
        uidset, ids = self._uidset(item_ids)
        dest = self.resolve_folder(target_folder)
        source = self.resolve_folder(source_folder)
        if dest == source:
            raise common.QQMailError("目标文件夹与当前文件夹相同")
        results: list[dict[str, Any]] = []
        with self.imap() as conn:
            with self._selected(conn, source, readonly=False):
                mode = self._move_uids(conn, uidset, dest)
                for uid in ids:
                    results.append({"item_id": uid, "status": "moved",
                                    "destination_folder_id": dest, "destination_folder_name": dest})
        return {"moved": len(ids), "mode": mode, "target_folder": target_folder,
                "target_folder_id": dest, "results": results}

    def delete_items(self, item_ids: Any, folder: str = "inbox", delete_type: str = "move_to_deleted_items") -> dict[str, Any]:
        """默认移动到「已删除」（对标 move_to_deleted_items）；hard_delete 永久删除。"""
        uidset, ids = self._uidset(item_ids)
        source = self.resolve_folder(folder)
        results: list[dict[str, Any]] = []
        with self.imap() as conn:
            with self._selected(conn, source, readonly=False):
                if delete_type == "hard_delete":
                    self._store_flags(conn, uidset, r"(\Deleted)", True)
                    conn.expunge()
                    action = "hard_deleted"
                else:
                    trash = self.resolve_folder("deleteditems")
                    if trash == source:
                        # 已在已删除文件夹 -> 直接永久删除
                        self._store_flags(conn, uidset, r"(\Deleted)", True)
                        conn.expunge()
                        action = "hard_deleted"
                    else:
                        self._move_uids(conn, uidset, trash)
                        action = "moved_to_deleted"
        for uid in ids:
            results.append({"item_id": uid, "status": action})
        return {"deleted": len(ids), "delete_type": action, "results": results}

    # ------------------------------------------------------------------
    # 统计 / 待办 / 联系人（对标 daily-stats / pending-important / person-unhandled / lookup）
    # ------------------------------------------------------------------

    _WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    _IMPORTANT_CATEGORIES = {"important", "重要", "urgent", "待办"}

    def _recent_items(self, folder: str, days: int, limit: int = 2000) -> list[dict[str, Any]]:
        start = (common.local_now() - timedelta(days=max(days - 1, 0))).date()
        filters = common.MailSearchFilters(after=start.strftime("%Y-%m-%d"))
        return self.search_items(folder, filters=filters, limit=limit)

    @staticmethod
    def _item_dt(item: dict[str, Any]) -> Optional[datetime]:
        return common.parse_date_boundary(item.get("date_time_received") or item.get("date_time_sent"))

    def _has_reply_after(self, inbound: dict[str, Any], sent_items: list[dict[str, Any]]) -> bool:
        """QQ 无 ConversationId：先按 Message-ID/References 强匹配，再按主题归一化弱匹配。"""
        in_dt = self._item_dt(inbound)
        message_id = common.safe_text(inbound.get("message_id"))
        inbound_from = common.safe_text((inbound.get("from") or {}).get("email")).lower()
        thread_subject = mime.normalize_subject_thread(inbound.get("subject", ""))

        for sent in sent_items:
            sent_dt = self._item_dt(sent)
            if in_dt and sent_dt and sent_dt < in_dt:
                continue
            if message_id:
                in_reply_to = common.safe_text(sent.get("in_reply_to"))
                references = common.safe_text(sent.get("references")).split()
                if in_reply_to == message_id or message_id in references:
                    return True
        # 弱匹配：主题归一化相同 + 收件人含原邮件发件人。
        # 原发件人若是自己（自发自收），已发送里的"发件原件"会与自己自匹配，
        # 不能据此判定为已回复，故仅在原发件人为他人时启用弱匹配。
        current = self.cfg.email.lower()
        if thread_subject and inbound_from and inbound_from != current:
            for sent in sent_items:
                sent_dt = self._item_dt(sent)
                if in_dt and sent_dt and sent_dt < in_dt:
                    continue
                if mime.normalize_subject_thread(sent.get("subject", "")) != thread_subject:
                    continue
                recipients = " ".join(
                    box.get("email", "") for box in
                    sent.get("to_recipients", []) + sent.get("cc_recipients", [])
                ).lower()
                if inbound_from in recipients:
                    return True
        return False

    def _is_important(self, item: dict[str, Any]) -> tuple[bool, list[str]]:
        reasons: list[str] = []
        if item.get("importance", "Normal") == "High":
            reasons.append("高优先级")
        categories = item.get("categories", [])
        for cat in categories:
            if cat.lower() in self._IMPORTANT_CATEGORIES or cat in self._IMPORTANT_CATEGORIES:
                reasons.append(f"重要分类:{cat}")
        return bool(reasons), reasons

    def daily_stats(self, folder: str = "inbox", days: int = common.DEFAULT_DAILY_STATS_DAYS,
                    after: str = "", before: str = "") -> dict[str, Any]:
        """对标 build_daily_mail_stats：按天聚合 total/unread/read，补全区间，给日均。"""
        days = max(1, min(int(days or common.DEFAULT_DAILY_STATS_DAYS), 90))
        now = common.local_now()
        before_dt = common.parse_date_boundary(before, end_of_day=True) or now
        after_dt = common.parse_date_boundary(after)
        if after_dt is None:
            after_dt = now - timedelta(days=days - 1)
        after_dt = after_dt.replace(hour=0, minute=0, second=0, microsecond=0)
        if after_dt > before_dt:
            after_dt = before_dt
        filters = common.MailSearchFilters(
            after=after_dt.strftime("%Y-%m-%d"),
            before=before_dt.strftime("%Y-%m-%d"),
        )
        items = self.search_items(folder, filters=filters, limit=2000)
        buckets: dict[str, dict[str, int]] = {}
        for item in items:
            dt = self._item_dt(item)
            if not dt or dt < after_dt or dt > before_dt:
                continue
            key = dt.strftime("%Y-%m-%d")
            bucket = buckets.setdefault(key, {"total": 0, "unread": 0, "read": 0})
            bucket["total"] += 1
            if item.get("is_read"):
                bucket["read"] += 1
            else:
                bucket["unread"] += 1
        day_rows: list[dict[str, Any]] = []
        cur = after_dt
        total = unread = read = 0
        while cur <= before_dt:
            key = cur.strftime("%Y-%m-%d")
            bucket = buckets.get(key, {"total": 0, "unread": 0, "read": 0})
            day_rows.append({
                "date": key,
                "weekday": self._WEEKDAYS[cur.weekday()],
                "date_label": f"{cur.month}月{cur.day}日",
                "total": bucket["total"],
                "unread": bucket["unread"],
                "read": bucket["read"],
            })
            total += bucket["total"]
            unread += bucket["unread"]
            read += bucket["read"]
            cur = cur + timedelta(days=1)
        day_rows.reverse()
        totals = {
            "total": total,
            "unread": unread,
            "read": read,
            "avg_per_day": round(total / max(len(day_rows), 1), 1),
        }
        return {"folder": folder, "days": day_rows, "totals": totals,
                "range": {"after": common.local_iso(after_dt), "before": common.local_iso(before_dt),
                          "days": len(day_rows)}}

    def pending_important(self, folder: str = "inbox", days: int = common.DEFAULT_DAILY_STATS_DAYS) -> dict[str, Any]:
        """对标 find_recent_unreplied_important：高优先级/重要分类，且之后无已发送回复。"""
        inbox = self._recent_items(folder, days)
        sent = self._recent_items("sentitems", days)
        rows: list[dict[str, Any]] = []
        for item in inbox:
            important, reasons = self._is_important(item)
            if not important:
                # 仅保留高优先级/重要分类邮件；是否已读不作为排除条件（重要未读也要列出）
                continue
            if self._has_reply_after(item, sent):
                continue
            rows.append({
                "item_id": item.get("item_id"),
                "subject": item.get("subject"),
                "from": item.get("from"),
                "date_time_received": item.get("date_time_received"),
                "importance": item.get("importance"),
                "categories": item.get("categories", []),
                "is_read": item.get("is_read"),
                "reasons": reasons,
                "folder": item.get("folder"),
            })
        rows.sort(key=lambda r: r.get("date_time_received", ""), reverse=True)
        return {"folder": folder, "days": days, "count": len(rows), "items": rows}

    def person_unhandled(self, person: str, folder: str = "inbox",
                         days: int = common.DEFAULT_DAILY_STATS_DAYS) -> dict[str, Any]:
        """对标 find_person_unhandled：指定发件人、未读、之后无已发送回复。"""
        keyword = common.safe_text(person)
        if not keyword:
            raise common.QQMailError("missing person")
        inbox = self._recent_items(folder, days)
        sent = self._recent_items("sentitems", days)
        rows: list[dict[str, Any]] = []
        for item in inbox:
            if item.get("is_read"):
                continue
            sender = item.get("from") or {}
            haystack = f"{sender.get('name', '')} {sender.get('email', '')}"
            if not common.contains(haystack, keyword):
                continue
            if self._has_reply_after(item, sent):
                continue
            rows.append({
                "item_id": item.get("item_id"),
                "subject": item.get("subject"),
                "from": sender,
                "date_time_received": item.get("date_time_received"),
                "folder": item.get("folder"),
            })
        rows.sort(key=lambda r: r.get("date_time_received", ""), reverse=True)
        return {"person": keyword, "folder": folder, "days": days,
                "count": len(rows), "items": rows}

    def lookup_recipient(self, condition: str, limit: int = 10) -> dict[str, Any]:
        """对标 lookup-recipient：从近 30 天收件箱/已发送邮件提取联系人；QQ 无 HR 接口。

        收件箱取发件人、已发送取收件人/抄送人（均排除自己），按最近联系排序。
        """
        keyword = common.safe_text(condition)
        if not keyword:
            raise common.QQMailError("missing condition")
        inbox = self._recent_items("inbox", common.DEFAULT_RECENT_CONTACT_DAYS, limit=1000)
        sent = self._recent_items("sentitems", common.DEFAULT_RECENT_CONTACT_DAYS, limit=1000)
        combined = inbox + sent
        combined.sort(key=lambda i: i.get("date_time_sent") or i.get("date_time_received") or "",
                      reverse=True)
        contacts: list[dict[str, Any]] = []
        seen: set[str] = set()
        current = self.cfg.email.lower()
        for item in combined:
            boxes: list[dict[str, str]] = []
            if item.get("folder") == "sentitems":
                boxes = item.get("to_recipients", []) + item.get("cc_recipients", [])
            else:
                sender = item.get("from") or item.get("sender")
                if sender and sender.get("email"):
                    boxes = [sender]
            for box in boxes:
                email = common.safe_text(box.get("email"))
                name = common.safe_text(box.get("name"))
                if not email or email.lower() == current:
                    continue
                key = email.lower()
                if key in seen:
                    continue
                if not (common.contains(name, keyword) or common.contains(email, keyword)):
                    continue
                seen.add(key)
                contacts.append({
                    "display_name": name or email,
                    "email": email,
                    "source": "recent_mail",
                })
                if len(contacts) >= limit:
                    break
            if len(contacts) >= limit:
                break
        return {"condition": keyword, "count": len(contacts), "contacts": contacts}

    # ------------------------------------------------------------------
    # 连通自检
    # ------------------------------------------------------------------

    def self_check(self) -> dict[str, Any]:
        """连接 + 文件夹 + 收发地址核验，供启动器/自检脚本使用。"""
        common.assert_config_ready(self.cfg)
        with self.imap() as conn:
            typ, data = conn.noop()
            noop_ok = typ == "OK"
            rows = self._load_folders(conn)
            special = dict(self._special)
        # SMTP 不实际发信，只做连通与登录
        smtp_ok = False
        cfg = self.cfg
        if cfg.smtp_ssl:
            server = smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=common.DEFAULT_TIMEOUT)
        else:
            server = smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=common.DEFAULT_TIMEOUT)
            server.starttls()
        try:
            server.login(cfg.email, cfg.auth_code)
            smtp_ok = True
        finally:
            with contextlib.suppress(Exception):
                server.quit()
        return {
            "email": cfg.email,
            "imap": {"host": cfg.imap_host, "port": cfg.imap_port, "ok": bool(noop_ok)},
            "smtp": {"host": cfg.smtp_host, "port": cfg.smtp_port, "ok": smtp_ok},
            "folder_count": len(rows),
            "special_folders": special,
        }
