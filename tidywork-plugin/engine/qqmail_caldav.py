#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - CalDAV 客户端（QQ 邮箱日历）。

仅依赖 Python 标准库（http.client + xml.etree）。能力：
- 服务发现（/.well-known/caldav 自动找到日历根路径）；
- PROPFIND 列出日历；
- REPORT calendar-query 按时间范围查询 VEVENT；
- GET 单个事件；PUT 创建/更新；DELETE 删除；
- HTTP Basic 认证（用户名=邮箱，密码=授权码）。
"""

from __future__ import annotations

import base64
import http.client
import ssl
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from qqmail_common import QQMailError, Config
import icalendar as ical

NS_DAV = "DAV:"
NS_CAL = "urn:ietf:params:xml:ns:caldav"


def _lname(tag: str) -> str:
    return tag.split("}", 1)[-1]


@dataclass
class CalendarInfo:
    href: str
    display_name: str
    components: list = field(default_factory=list)
    writable: bool = True
    is_schedule: bool = False  # schedule-inbox/outbox 等特殊日历


class CalDAVClient:
    def __init__(self, config: Config):
        parts = urlsplit(config.caldav_url or "https://dav.qq.com/")
        self.scheme = parts.scheme or "https"
        self.host = parts.hostname
        self.port = parts.port or (443 if self.scheme == "https" else 80)
        self.base_path = parts.path.rstrip("/") or ""
        self.user = config.email
        self.token = config.auth_code
        self._auth = "Basic " + base64.b64encode(
            f"{self.user}:{self.token}".encode()).decode()
        self._root: str | None = None

    # ------------------------------------------------------------------
    # 底层 HTTP
    # ------------------------------------------------------------------
    def _conn(self):
        if self.scheme == "https":
            ctx = ssl.create_default_context()
            return http.client.HTTPSConnection(self.host, self.port, context=ctx, timeout=20)
        return http.client.HTTPSConnection  # noqa - 非https极少用

    # 只读、幂等的方法；这些遇到限流/瞬时错误可安全重试。
    _READ_METHODS = {"GET", "PROPFIND", "REPORT", "OPTIONS", "HEAD"}
    _RETRYABLE_STATUS = {429, 500, 502, 503, 504}

    @staticmethod
    def _backoff(attempt: int) -> float:
        return 0.8 * (2 ** attempt)  # 0.8s, 1.6s

    def request(self, method, path, body=None, depth=None, content_type=None,
                follow_redirects=True):
        """发起请求；只读方法遇到限流/瞬时错误自动重试（写方法不重试，避免重复）。"""
        is_read = method.upper() in self._READ_METHODS
        attempts = 3 if is_read else 1
        last_exc = None
        for attempt in range(attempts):
            try:
                status, hdrs, text = self._request_once(
                    method, path, body=body, depth=depth,
                    content_type=content_type, follow_redirects=follow_redirects)
            except (http.client.HTTPException, OSError) as exc:
                last_exc = exc
                if attempt < attempts - 1:
                    time.sleep(self._backoff(attempt))
                    continue
                raise QQMailError(f"网络连接失败（{self.host}）：{exc}") from exc
            if is_read and status in self._RETRYABLE_STATUS and attempt < attempts - 1:
                time.sleep(self._backoff(attempt))
                continue
            return status, hdrs, text
        raise QQMailError(f"请求多次失败：{last_exc or ''}")

    def _request_once(self, method, path, body=None, depth=None, content_type=None,
                      follow_redirects=True):
        """发起一次请求，返回 (status, headers_dict, text)。可跟随重定向。"""
        if not path.startswith("http") and not path.startswith("/"):
            path = "/" + path
        headers = {
            "Authorization": self._auth,
            "User-Agent": "TidyWorky/1.0",
        }
        if body is not None:
            headers["Content-Type"] = content_type or "application/xml; charset=utf-8"
        if depth is not None:
            headers["Depth"] = depth
        if body is not None and isinstance(body, str):
            body = body.encode("utf-8")
        for _ in range(5):
            conn = self._conn()
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            data = resp.read()
            if follow_redirects and resp.status in (301, 302, 303, 307, 308):
                loc = resp.getheader("Location")
                if loc:
                    if loc.startswith("/"):
                        path = loc
                    else:
                        p = urlsplit(loc)
                        path = p.path
                    continue
            hdrs = {k.lower(): v for k, v in resp.getheaders()}
            text = data.decode("utf-8", "replace")
            return resp.status, hdrs, text
        raise QQMailError("重定向次数过多")

    def _check(self, status, text, ok_status):
        if status not in ok_status:
            if status in (401, 403):
                raise QQMailError(
                    f"CalDAV 认证失败/无权限（HTTP {status}）。请确认已在 QQ 邮箱网页版"
                    "开启 CalDAV 服务，且使用的是 16 位授权码（非登录密码）。")
            raise QQMailError(f"CalDAV 请求失败（HTTP {status}）：{text[:300]}")

    # ------------------------------------------------------------------
    # 服务发现
    # ------------------------------------------------------------------
    def discover(self) -> str:
        """返回日历根路径（如 /calendar/），并缓存。"""
        if self._root:
            return self._root
        well_known = self.base_path + "/.well-known/caldav"
        status, hdrs, text = self.request("PROPFIND", well_known,
                                          body=self._discover_body(), depth="0")
        # 正常应 301/302 到根；若直接 207 则解析
        root_path = None
        if status in (301, 302, 303, 307, 308):
            loc = hdrs.get("location", "")
            root_path = urlsplit(loc).path if loc.startswith("http") else loc
        elif status == 207:
            root_path = self._first_href(text)
        if not root_path:
            # 兜底：常见路径
            root_path = self.base_path + "/calendar/"
        if not root_path.endswith("/"):
            root_path += "/"
        self._root = root_path
        return root_path

    @staticmethod
    def _discover_body():
        return ('<?xml version="1.0" encoding="utf-8"?>'
                '<D:propfind xmlns:D="DAV:"><D:prop>'
                '<D:current-user-principal/></D:prop></D:propfind>')

    @staticmethod
    def _first_href(xml_text):
        root = ET.fromstring(xml_text)
        for el in root.iter():
            if _lname(el.tag) == "href" and el.text:
                return el.text
        return None

    # ------------------------------------------------------------------
    # 列日历
    # ------------------------------------------------------------------
    def list_calendars(self) -> list[CalendarInfo]:
        root = self.discover()
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            '<D:prop><D:resourcetype/><D:displayname/>'
            '<C:supported-calendar-component-set/></D:prop></D:propfind>')
        status, hdrs, text = self.request("PROPFIND", root, body=body, depth="1")
        self._check(status, text, (207,))
        return self._parse_calendars(text)

    @staticmethod
    def _parse_calendars(xml_text) -> list[CalendarInfo]:
        root = ET.fromstring(xml_text)
        result: list[CalendarInfo] = []
        for resp in root.iter():
            if _lname(resp.tag) != "response":
                continue
            href = ""
            is_calendar = False
            is_schedule = False
            display = ""
            components: list[str] = []
            for el in resp.iter():
                ln = _lname(el.tag)
                if ln == "href" and el.text and not href:
                    href = el.text
                elif ln == "calendar":
                    is_calendar = True
                elif ln in ("schedule-inbox", "schedule-outbox"):
                    is_schedule = True
                elif ln == "displayname":
                    display = el.text or ""
                elif ln == "comp":
                    name = el.attrib.get("name")
                    if name:
                        components.append(name)
            if is_calendar and href and not is_schedule and components:
                result.append(CalendarInfo(
                    href=href, display_name=display or href,
                    components=components, is_schedule=False))
        return result

    def resolve_calendar(self, name: str) -> str:
        """按显示名/路径/序号定位日历 href；默认主日历。"""
        cals = self.list_calendars()
        key = (name or "").strip()
        if not key:
            # 优先 displayname 为「日历」，否则第一个
            for c in cals:
                if c.display_name == "日历":
                    return c.href
            return cals[0].href if cals else "/"
        if key.isdigit():
            idx = int(key) - 1
            if 0 <= idx < len(cals):
                return cals[idx].href
        for c in cals:
            if c.display_name == key or c.href.rstrip("/").endswith(key.rstrip("/")):
                return c.href
        raise QQMailError(f"未找到日历：{key}（可用：{', '.join(c.display_name for c in cals)}）")

    # ------------------------------------------------------------------
    # 查询事件
    # ------------------------------------------------------------------
    def query_events(self, calendar_href, start: datetime, end: datetime):
        start_s = ical.format_datetime_utc(start)
        end_s = ical.format_datetime_utc(end)
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
            '<C:filter><C:comp-filter name="VCALENDAR">'
            '<C:comp-filter name="VEVENT">'
            f'<C:time-range start="{start_s}" end="{end_s}"/>'
            '</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>')
        status, hdrs, text = self.request("REPORT", calendar_href, body=body, depth="1")
        self._check(status, text, (207,))
        return self._parse_events(text)

    @staticmethod
    def _parse_events(xml_text):
        root = ET.fromstring(xml_text)
        events = []
        for resp in root.iter():
            if _lname(resp.tag) != "response":
                continue
            href = ""
            data = ""
            for el in resp.iter():
                ln = _lname(el.tag)
                if ln == "href" and el.text and not href:
                    href = el.text
                elif ln == "calendar-data":
                    data = el.text or ""
            if not data:
                continue
            parsed = ical.parse_icalendar(data)
            for cal in parsed.subcomponents("VCALENDAR"):
                for ve in cal.subcomponents("VEVENT"):
                    events.append(ical.component_to_event(ve, href=href))
        return events

    # ------------------------------------------------------------------
    # 增 / 改 / 删
    # ------------------------------------------------------------------
    def multiget_events(self, calendar_href: str, hrefs: list[str]):
        """calendar-multiget：按 href 批量读取事件（QQ 不支持 GET 单资源）。"""
        if not hrefs:
            return []
        hrefs_xml = "".join(f"<D:href>{h}</D:href>" for h in hrefs)
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">'
            '<D:prop><D:getetag/><C:calendar-data/></D:prop>'
            f'{hrefs_xml}</C:calendar-multiget>')
        status, hdrs, text = self.request("REPORT", calendar_href,
                                          body=body, depth="1")
        self._check(status, text, (207,))
        return self._parse_events(text)

    def get_event(self, href):
        """读取单个事件（走 multiget；calendar 路径从 href 推导）。"""
        cal_href = href.rpartition("/")[0] + "/"
        events = self.multiget_events(cal_href, [href])
        if not events:
            raise QQMailError(f"未读取到事件：{href}（可能已被删除）")
        return events[0]

    def put_event(self, calendar_href: str, event: ical.EventData) -> str:
        """创建或更新事件，返回资源 href。"""
        filename = self._safe_filename(event.uid)
        href = calendar_href.rstrip("/") + "/" + filename
        ics = ical.build_vcalendar(ical.build_vevent(event))
        status, hdrs, text = self.request("PUT", href, body=ics,
                                          content_type="text/calendar; charset=utf-8")
        self._check(status, text, (201, 202, 204))
        return href

    def delete_event(self, href: str):
        status, hdrs, text = self.request("DELETE", href)
        self._check(status, text, (204, 200, 404))

    @staticmethod
    def _normalize_uid(uid: str) -> str:
        """模拟 QQ 对 UID 的规范化（非字母数字及 ._- 的字符转 _）。"""
        return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in uid)

    def find_event_href(self, calendar_href: str, uid: str) -> str:
        """按 uid 定位事件 href：先按命名规则构造并 multiget 校验，失败再 REPORT 查找。"""
        candidate = calendar_href.rstrip("/") + "/" + self._safe_filename(uid)
        if self.multiget_events(calendar_href, [candidate]):
            return candidate
        # 宽时间窗 REPORT 查找（前后约 10 年）
        from datetime import timedelta
        now = datetime.now(timezone.utc)
        events = self.query_events(calendar_href,
                                   now - timedelta(days=365 * 10),
                                   now + timedelta(days=365 * 10))
        norm = self._normalize_uid(uid)
        for ev in events:
            if ev.uid == uid or ev.uid == norm:
                return ev.href
        raise QQMailError(
            f"在日历中未找到 UID 为 {uid} 的日程；可先用 list-events 查看，"
            "或用 --href 直接指定资源路径。")

    @staticmethod
    def _safe_filename(uid: str) -> str:
        keep = []
        for ch in uid:
            if ch.isalnum() or ch in "._-":
                keep.append(ch)
            else:
                keep.append("_")
        name = "".join(keep)
        if not name.endswith(".ics"):
            name += ".ics"
        return name
