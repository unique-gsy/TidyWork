#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - 基础公共模块。

对标京东 soap_mail.py 中的常量、异常、MailSearchFilters、时间/字符串工具与
SSO 配置：京东的 SSO/JWT 配置在 QQ 版本中替换为「本地 config.ini + 授权码」配置。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

try:  # Python 3.11+ configparser 为标准库
    import configparser
except ImportError:  # pragma: no cover
    configparser = None  # type: ignore


# ---------------------------------------------------------------------------
# 常量（QQ 邮箱 IMAP/SMTP；对标京东 DEFAULT_ENDPOINT / DISTINGUISHED_FOLDERS）
# ---------------------------------------------------------------------------

DEFAULT_IMAP_HOST = "imap.qq.com"
DEFAULT_IMAP_PORT = 993
DEFAULT_SMTP_HOST = "smtp.qq.com"
DEFAULT_SMTP_PORT = 465
DEFAULT_CALDAV_URL = "https://dav.qq.com/"
DEFAULT_CARDDAV_URL = "https://dav.qq.com/"

DEFAULT_TIMEOUT = 30
DEFAULT_LOGIN_RETRY_TIMES = 3
DEFAULT_FALLBACK_TZ_NAME = "Asia/Shanghai"

# 查询默认时间窗口（与京东保持一致）
DEFAULT_SEARCH_LOOKBACK_DAYS = 1
DEFAULT_DAILY_STATS_DAYS = 7
DEFAULT_RECENT_CONTACT_DAYS = 30

# 逻辑文件夹 -> （QQ IMAP 默认名, RFC6154 特殊用途标记）。
# 实际使用时优先通过 LIST 特殊标记动态识别，识别不到再用默认名兜底。
LOGICAL_FOLDERS = {
    "inbox": ("INBOX", ("\\Inbox",)),
    "sent": ("Sent Messages", ("\\Sent",)),
    "sentitems": ("Sent Messages", ("\\Sent",)),
    "draft": ("Drafts", ("\\Drafts",)),
    "drafts": ("Drafts", ("\\Drafts",)),
    "deleted": ("Deleted Messages", ("\\Trash", "\\Deleted")),
    "deleteditems": ("Deleted Messages", ("\\Trash", "\\Deleted")),
    "junk": ("Junk", ("\\Junk",)),
    "junkemail": ("Junk", ("\\Junk",)),
}

# 京东使用的逻辑文件夹名（SKILL.md 里 --folder inbox/sentitems/drafts...）
def normalize_logical_folder(name: str) -> str:
    key = (name or "").strip().lower()
    return {
        "sent": "sentitems",
        "draft": "drafts",
        "deleted": "deleteditems",
        "junk": "junkemail",
        "root": "msgfolderroot",
        "msgfolderroot": "msgfolderroot",
    }.get(key, key)


# ---------------------------------------------------------------------------
# 异常 / 过滤条件（与京东同名，保持业务逻辑一致）
# ---------------------------------------------------------------------------

class QQMailError(Exception):
    """对标京东 SoapMailError。"""


@dataclass
class MailSearchFilters:
    """对标京东 MailSearchFilters，字段一一对应。"""

    sender: str = ""
    recipient: str = ""
    subject: str = ""
    body_keyword: str = ""
    after: str = ""
    before: str = ""
    unread_only: bool = False
    read_only: bool = False
    has_attachments: bool = False
    category: str = ""
    importance: str = ""


# ---------------------------------------------------------------------------
# 配置（QQ 授权码；替代京东 SSO token）
# ---------------------------------------------------------------------------

@dataclass
class Config:
    email: str = ""
    auth_code: str = ""
    display_name: str = ""
    imap_host: str = DEFAULT_IMAP_HOST
    imap_port: int = DEFAULT_IMAP_PORT
    imap_ssl: bool = True
    smtp_host: str = DEFAULT_SMTP_HOST
    smtp_port: int = DEFAULT_SMTP_PORT
    smtp_ssl: bool = True
    caldav_enabled: bool = False
    caldav_url: str = DEFAULT_CALDAV_URL
    carddav_enabled: bool = False
    carddav_url: str = DEFAULT_CARDDAV_URL
    download_dir: str = ""
    contact_cache: str = ""
    config_path: str = ""


def package_root() -> Path:
    """技能包根目录（scripts/ 的上一级）。"""
    return Path(__file__).resolve().parent.parent


def default_config_path() -> Path:
    return package_root() / "config.ini"


def _as_bool(value: str, default: bool = True) -> bool:
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on", "y")


def _as_int(value: str, default: int) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


def load_config(path: Optional[str] = None) -> Config:
    """读取 config.ini（并允许环境变量覆盖）。

    配置优先级：环境变量 > config.ini > 内置默认值。
    """
    cfg = Config()
    ini_path = Path(path) if path else Path(os.environ.get("QQMAIL_CONFIG", "") or default_config_path())
    parser = None
    if ini_path.exists():
        parser = configparser.ConfigParser()
        parser.read(ini_path, encoding="utf-8")
        cfg.config_path = str(ini_path)

    def get(section: str, key: str, fallback: str = "") -> str:
        if parser is not None and parser.has_option(section, key):
            return parser.get(section, key)
        return fallback

    cfg.email = get("account", "email").strip()
    cfg.auth_code = get("account", "auth_code").strip()
    cfg.display_name = get("account", "display_name").strip()
    cfg.imap_host = get("imap", "host", DEFAULT_IMAP_HOST).strip() or DEFAULT_IMAP_HOST
    cfg.imap_port = _as_int(get("imap", "port", str(DEFAULT_IMAP_PORT)), DEFAULT_IMAP_PORT)
    cfg.imap_ssl = _as_bool(get("imap", "ssl", "true"), True)
    cfg.smtp_host = get("smtp", "host", DEFAULT_SMTP_HOST).strip() or DEFAULT_SMTP_HOST
    cfg.smtp_port = _as_int(get("smtp", "port", str(DEFAULT_SMTP_PORT)), DEFAULT_SMTP_PORT)
    cfg.smtp_ssl = _as_bool(get("smtp", "ssl", "true"), True)
    cfg.caldav_enabled = _as_bool(get("caldav", "enabled", "false"), False)
    cfg.caldav_url = get("caldav", "url", DEFAULT_CALDAV_URL).strip() or DEFAULT_CALDAV_URL
    cfg.carddav_enabled = _as_bool(get("carddav", "enabled", "false"), False)
    cfg.carddav_url = get("carddav", "url", DEFAULT_CARDDAV_URL).strip() or DEFAULT_CARDDAV_URL
    cfg.download_dir = get("storage", "download_dir").strip()
    cfg.contact_cache = get("storage", "contact_cache").strip()

    # 环境变量覆盖
    cfg.email = os.environ.get("QQMAIL_EMAIL", cfg.email).strip()
    cfg.auth_code = os.environ.get("QQMAIL_AUTH_CODE", cfg.auth_code).strip()
    cfg.display_name = os.environ.get("QQMAIL_DISPLAY_NAME", cfg.display_name).strip()
    if os.environ.get("QQMAIL_IMAP_HOST"):
        cfg.imap_host = os.environ["QQMAIL_IMAP_HOST"].strip()
    if os.environ.get("QQMAIL_IMAP_PORT"):
        cfg.imap_port = _as_int(os.environ["QQMAIL_IMAP_PORT"], cfg.imap_port)
    if os.environ.get("QQMAIL_SMTP_HOST"):
        cfg.smtp_host = os.environ["QQMAIL_SMTP_HOST"].strip()
    if os.environ.get("QQMAIL_SMTP_PORT"):
        cfg.smtp_port = _as_int(os.environ["QQMAIL_SMTP_PORT"], cfg.smtp_port)

    return cfg


def assert_config_ready(cfg: Config) -> None:
    """缺少邮箱/授权码或格式不对时给出明确、可操作的指引。"""
    missing = []
    if not cfg.email or "@" not in cfg.email:
        missing.append("邮箱地址 email")
    if not cfg.auth_code:
        missing.append("16 位授权码 auth_code")
    if missing:
        raise QQMailError(
            "尚未配置" + "、".join(missing) + "。请复制 config.example.ini 为 config.ini 并填写，"
            "或设置环境变量 QQMAIL_EMAIL / QQMAIL_AUTH_CODE。授权码获取方式：QQ邮箱网页版 -> "
            "设置 -> 账户 -> 开启 IMAP/SMTP 服务 -> 生成授权码。"
        )
    # QQ 授权码为 16 位字母；最常见错误是把 QQ 登录密码填进来。
    code = cfg.auth_code.replace(" ", "")
    if len(code) != 16 or not code.isascii() or not code.isalpha():
        raise QQMailError(
            "授权码格式不正确：应为 16 位字母（当前 %d 位）。它不是 QQ 登录密码，"
            "请在 QQ 邮箱网页版 -> 设置 -> 账户 -> 开启 IMAP/SMTP/CalDAV 服务后生成授权码。"
            % len(code)
        )


# ---------------------------------------------------------------------------
# 时区 / 时间工具（对标京东 _effective_local_tz / local_now / _parse_date_boundary）
# ---------------------------------------------------------------------------

def _fallback_tz():
    try:
        return ZoneInfo(DEFAULT_FALLBACK_TZ_NAME)
    except Exception:
        return timezone(timedelta(hours=8))


def effective_local_tz():
    local_tz = datetime.now().astimezone().tzinfo
    if local_tz is not None and local_tz.utcoffset(datetime.now()) is not None:
        return local_tz
    return _fallback_tz()


def local_now() -> datetime:
    return datetime.now(effective_local_tz())


def to_local(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=effective_local_tz())
    return dt.astimezone(effective_local_tz())


def has_explicit_time(value: str) -> bool:
    return ":" in (value or "").strip()


def parse_date_boundary(value: str, end_of_day: bool = False) -> Optional[datetime]:
    """解析 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS；before 日期补到当天 23:59:59。"""
    raw = (value or "").strip()
    if not raw:
        return None
    dt: Optional[datetime] = None
    try:
        normalized = raw.replace(" ", "T")
        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        dt = None
    if dt is None:
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S"):
            try:
                dt = datetime.strptime(raw, fmt)
                break
            except ValueError:
                dt = None
    if dt is None:
        return None
    dt = to_local(dt)
    if end_of_day and not has_explicit_time(raw):
        dt = dt + timedelta(days=1) - timedelta(microseconds=1)
    return dt


def local_iso(dt: Optional[datetime]) -> str:
    if dt is None:
        return ""
    return to_local(dt).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# 字符串工具（对标京东 _safe_text / _contains / _dedupe_preserve_order）
# ---------------------------------------------------------------------------

def safe_text(value: Optional[str]) -> str:
    return (value or "").strip()


def contains(haystack: str, needle: str) -> bool:
    return (needle or "").lower() in (haystack or "").lower()


def dedupe_preserve_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = (value or "").strip()
        if not normalized:
            continue
        key = normalized.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
    return result


def split_addresses(raw: str) -> list[str]:
    """逗号/分号分隔的邮箱地址，去空格去空值。"""
    text = (raw or "").replace(";", ",")
    return [item.strip() for item in text.split(",") if item.strip()]


def split_item_ids(raw: str) -> list[str]:
    """对标京东 _split_item_ids（逗号分隔）。"""
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def short_text(value: str, limit: int = 36) -> str:
    text = " ".join((value or "").split())
    if len(text) <= limit:
        return text
    return text[: max(limit - 1, 0)] + "…"
