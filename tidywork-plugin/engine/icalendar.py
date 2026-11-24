#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - iCalendar（RFC 5545）构造与解析。

仅依赖 Python 标准库。支持：
- 行折叠/展开（RFC 5545 §3.3.11，按 UTF-8 octets 折叠）；
- 组件树（VCALENDAR / VEVENT / VALARM ...）解析；
- 属性行（含参数、quoted-string）解析；
- TEXT 类型转义/反转义；
- 时间值（UTC / TZID / 全天 DATE）；
- 由 EventData 构造 VEVENT（含 VALARM 提醒）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, date, timezone
from typing import Optional
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# 行展开 / 折叠
# ---------------------------------------------------------------------------

def unfold_lines(text: str) -> list[str]:
    """把 iCalendar 文本按物理行展开为逻辑行（去掉续行的前导空白）。"""
    # 统一换行
    norm = text.replace("\r\n", "\n").replace("\r", "\n")
    physical = norm.split("\n")
    logical: list[str] = []
    for line in physical:
        if line[:1] in (" ", "\t"):
            if logical:
                logical[-1] += line[1:]
            else:
                logical.append(line[1:])
        else:
            logical.append(line)
    return logical


def _fold_text(text: str) -> list[str]:
    """按字符边界折叠（首行内容 75 octets，续行内容 74 octets 另加 1 前导空格）。

    保证不切断 UTF-8 多字节字符。
    """
    parts: list[str] = []
    limit = 75
    cur = ""
    cur_len = 0
    for ch in text:
        n = len(ch.encode("utf-8"))
        if cur and cur_len + n > limit:
            parts.append(cur)
            cur = ch
            cur_len = n
            limit = 74
        else:
            cur += ch
            cur_len += n
    parts.append(cur)
    return [parts[0]] + [" " + p for p in parts[1:]]


def _fold_octets(octets: bytes) -> list[str]:
    """按 RFC 5545 把一行的 UTF-8 字节折叠（保留，按字符边界）。"""
    return _fold_text(octets.decode("utf-8"))


def fold_content_line(name: str, value: str, params: Optional[dict] = None) -> str:
    """构造并折叠一条内容行。"""
    segs = [name]
    for k, v in (params or {}).items():
        # 参数值若含特殊字符需引号
        if any(ch in v for ch in ':,;'):
            segs.append(f'{k}="{v}"')
        else:
            segs.append(f"{k}={v}")
    line = ";".join(segs) + ":" + value
    return "\r\n".join(_fold_octets(line.encode("utf-8")))


# ---------------------------------------------------------------------------
# TEXT 转义 / 反转义
# ---------------------------------------------------------------------------

def escape_text(text: str) -> str:
    """TEXT 类型转义：\\ ; , 换行。先把 CRLF/CR 统一为 LF。"""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for ch in text:
        if ch == "\\":
            out.append("\\\\")
        elif ch == ";":
            out.append("\\;")
        elif ch == ",":
            out.append("\\,")
        elif ch == "\n":
            out.append("\\n")
        else:
            out.append(ch)
    return "".join(out)


def unescape_text(text: str) -> str:
    """TEXT 类型反转义（逐字符，安全处理 \\\\）。"""
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            nxt = text[i + 1]
            mapping = {"n": "\n", "N": "\n", ";": ";", ",": ",", "\\": "\\"}
            out.append(mapping.get(nxt, nxt))
            i += 2
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# ---------------------------------------------------------------------------
# 解析模型
# ---------------------------------------------------------------------------

@dataclass
class ICalProperty:
    name: str
    value: str
    params: dict = field(default_factory=dict)

    def param(self, key: str, default: str = "") -> str:
        return self.params.get(key.upper(), default)


@dataclass
class ICalComponent:
    name: str
    props: dict = field(default_factory=dict)        # upper name -> list[ICalProperty]
    components: list = field(default_factory=list)  # list[ICalComponent]

    def get(self, name: str) -> Optional[ICalProperty]:
        vals = self.props.get(name.upper())
        return vals[0] if vals else None

    def get_all(self, name: str) -> list[ICalProperty]:
        return self.props.get(name.upper(), [])

    def get_value(self, name: str, default: str = "") -> str:
        prop = self.get(name)
        return prop.value if prop else default

    def subcomponents(self, name: str) -> list:
        return [c for c in self.components if c.name.upper() == name.upper()]


def _parse_property_line(line: str) -> ICalProperty:
    """解析 'NAME;PARAM=VALUE:...'，正确处理 quoted 参数与冒号。"""
    # 找到值分隔冒号（不在引号内）
    in_quote = False
    split_at = -1
    for i, ch in enumerate(line):
        if ch == '"':
            in_quote = not in_quote
        elif ch == ":" and not in_quote:
            split_at = i
            break
    head = line[:split_at]
    value = line[split_at + 1:]
    tokens = head.split(";")
    name = tokens[0]
    params: dict = {}
    for tok in tokens[1:]:
        if "=" in tok:
            k, v = tok.split("=", 1)
            if v[:1] == '"' and v[-1:] == '"':
                v = v[1:-1]
            params[k.upper()] = v
    return ICalProperty(name=name, value=value, params=params)


def parse_icalendar(text: str) -> ICalComponent:
    """解析 iCalendar 文本，返回根组件（通常为 VCALENDAR）。"""
    lines = unfold_lines(text)
    root = ICalComponent(name="ROOT")
    stack = [root]
    for raw in lines:
        if not raw.strip():
            continue
        prop = _parse_property_line(raw)
        upper = prop.name.upper()
        if upper == "BEGIN":
            comp = ICalComponent(name=prop.value)
            stack[-1].components.append(comp)
            stack.append(comp)
        elif upper == "END":
            if len(stack) > 1:
                stack.pop()
        else:
            stack[-1].props.setdefault(upper, []).append(prop)
    return root


# ---------------------------------------------------------------------------
# 时间值
# ---------------------------------------------------------------------------

def format_datetime_utc(dt: datetime) -> str:
    """datetime -> UTC iCalendar 时间（Z）。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def format_date(d: date) -> str:
    """date -> 全天 DATE 值。"""
    return d.strftime("%Y%m%d")


def parse_date_time(prop: ICalProperty):
    """把 DTSTART/DTEND 属性解析为 datetime（带时区）或 date（全天）。"""
    value = prop.value
    value_type = prop.param("VALUE", "").upper()
    tzid = prop.param("TZID")
    if value_type == "DATE" or (len(value) == 8 and "T" not in value):
        return datetime.strptime(value, "%Y%m%d").date()
    fmt = "%Y%m%dT%H%M%S"
    if value.endswith("Z"):
        return datetime.strptime(value[:-1], fmt).replace(tzinfo=timezone.utc)
    dt = datetime.strptime(value, fmt)
    if tzid:
        try:
            dt = dt.replace(tzinfo=ZoneInfo(tzid))
        except Exception:
            dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---------------------------------------------------------------------------
# 事件数据模型与构造
# ---------------------------------------------------------------------------

@dataclass
class EventData:
    uid: str = ""
    summary: str = ""
    start: object = None          # datetime 或 date
    end: object = None            # datetime 或 date
    all_day: bool = False
    description: str = ""
    location: str = ""
    status: str = "CONFIRMED"
    organizer: str = ""
    attendees: list = field(default_factory=list)
    alarms_minutes: list = field(default_factory=list)  # 提前分钟数，如 [15, 60]

    @property
    def is_all_day(self) -> bool:
        return self.all_day or isinstance(self.start, date) and not isinstance(self.start, datetime)


def build_alarm(trigger_minutes: int) -> str:
    """构造一个显示型提醒 VALARM。"""
    minutes = int(trigger_minutes)
    if minutes < 0:
        minutes = 0
    trigger = f"-PT{minutes}M"
    lines = [
        "BEGIN:VALARM",
        fold_content_line("ACTION", "DISPLAY"),
        fold_content_line("DESCRIPTION", "Reminder"),
        fold_content_line("TRIGGER", trigger),
        "END:VALARM",
    ]
    return "\r\n".join(lines)


def build_vevent(event: EventData, dtstamp: Optional[datetime] = None) -> str:
    """由 EventData 构造 VEVENT 文本。"""
    stamp = format_datetime_utc(dtstamp or datetime.now(timezone.utc))
    lines: list[str] = ["BEGIN:VEVENT"]
    lines.append(fold_content_line("UID", event.uid))
    lines.append(fold_content_line("DTSTAMP", stamp))

    if event.is_all_day:
        sd = event.start if isinstance(event.start, date) else date.today()
        # 全天：结束日期为排他语义，若给的是同一天则顺延一天
        ed = event.end if isinstance(event.end, date) else sd
        if ed <= sd:
            from datetime import timedelta
            ed = sd + timedelta(days=1)
        lines.append(fold_content_line("DTSTART", format_date(sd), {"VALUE": "DATE"}))
        lines.append(fold_content_line("DTEND", format_date(ed), {"VALUE": "DATE"}))
    else:
        lines.append(fold_content_line("DTSTART", format_datetime_utc(event.start)))
        if event.end:
            lines.append(fold_content_line("DTEND", format_datetime_utc(event.end)))

    if event.summary:
        lines.append(fold_content_line("SUMMARY", escape_text(event.summary)))
    if event.location:
        lines.append(fold_content_line("LOCATION", escape_text(event.location)))
    if event.description:
        lines.append(fold_content_line("DESCRIPTION", escape_text(event.description)))
    if event.status:
        lines.append(fold_content_line("STATUS", event.status))
    if event.organizer:
        lines.append(fold_content_line("ORGANIZER", f"mailto:{event.organizer}"))
    for att in event.attendees:
        lines.append(fold_content_line("ATTENDEE", f"mailto:{att}",
                                       {"RSVP": "TRUE", "PARTSTAT": "NEEDS-ACTION",
                                        "ROLE": "REQ-PARTICIPANT"}))
    for minutes in event.alarms_minutes:
        lines.append(build_alarm(minutes))
    lines.append("END:VEVENT")
    return "\r\n".join(lines)


def build_vcalendar(inner: str) -> str:
    """包裹 VCALENDAR 外壳。"""
    head = "\r\n".join([
        "BEGIN:VCALENDAR",
        fold_content_line("VERSION", "2.0"),
        fold_content_line("PRODID", "-//TidyWorky//Mail Module//EN"),
        fold_content_line("CALSCALE", "GREGORIAN"),
        fold_content_line("METHOD", "PUBLISH"),
    ])
    return head + "\r\n" + inner + "\r\n" + "END:VCALENDAR" + "\r\n"


# ---------------------------------------------------------------------------
# 从解析组件提取事件（供 list-events 读取）
# ---------------------------------------------------------------------------

@dataclass
class ParsedEvent:
    uid: str
    summary: str
    start: object
    end: object
    all_day: bool
    description: str
    location: str
    status: str
    organizer: str
    attendees: list
    alarms_minutes: list
    href: str = ""


def _parse_trigger(prop: ICalProperty) -> int:
    """TRIGGER 值（如 -PT15M / -PT1H）转为提前分钟数。"""
    val = prop.value
    sign = -1 if val.startswith("-") else 1
    val = val.lstrip("+-")
    minutes = 0
    import re
    m = re.match(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", val)
    if m:
        days, hours, mins, secs = (int(x) if x else 0 for x in m.groups())
        minutes = days * 24 * 60 + hours * 60 + mins + (1 if secs >= 30 else 0)
    return sign * minutes


def component_to_event(comp: ICalComponent, href: str = "") -> ParsedEvent:
    """把 VEVENT 组件转成 ParsedEvent。"""
    start_prop = comp.get("DTSTART")
    end_prop = comp.get("DTEND")
    start = parse_date_time(start_prop) if start_prop else None
    end = parse_date_time(end_prop) if end_prop else None
    all_day = isinstance(start, date) and not isinstance(start, datetime)

    organizer = ""
    org = comp.get("ORGANIZER")
    if org and org.value.startswith("mailto:"):
        organizer = org.value[7:]

    attendees = []
    for att in comp.get_all("ATTENDEE"):
        attendees.append(att.value.replace("mailto:", ""))

    alarms = []
    for valarm in comp.subcomponents("VALARM"):
        trig = valarm.get("TRIGGER")
        if trig:
            alarms.append(abs(_parse_trigger(trig)))

    return ParsedEvent(
        uid=comp.get_value("UID"),
        summary=unescape_text(comp.get_value("SUMMARY")),
        start=start,
        end=end,
        all_day=all_day,
        description=unescape_text(comp.get_value("DESCRIPTION")),
        location=unescape_text(comp.get_value("LOCATION")),
        status=comp.get_value("STATUS", "CONFIRMED"),
        organizer=organizer,
        attendees=attendees,
        alarms_minutes=alarms,
        href=href,
    )
