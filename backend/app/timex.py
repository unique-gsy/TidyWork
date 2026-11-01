"""时间处理：存储统一 UTC（ISO 8601），周报区间与展示按应用时区（架构 4.2）。

API 对外可见的日期时间一律为应用时区的本地时间（无时区后缀，格式
YYYY-MM-DDTHH:MM:SS）；due_date / week_start / week_end 为本地日期。
"""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from . import db


def app_tz() -> ZoneInfo:
    name = db.get_setting("app.timezone", "Asia/Shanghai")
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo("Asia/Shanghai")


def now_local() -> datetime:
    return datetime.now(app_tz())


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def local_to_utc_iso(value: str) -> str | None:
    """本地时间字符串（YYYY-MM-DDTHH:MM[:SS]）→ UTC ISO 存储。"""
    if not value:
        return None
    v = value.strip().replace("Z", "")
    try:
        naive = datetime.fromisoformat(v)
    except ValueError:
        return None
    local = naive.replace(tzinfo=app_tz())
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def utc_to_local_str(value: str | None, fmt: str = "%Y-%m-%dT%H:%M:%S") -> str | None:
    """UTC ISO 存储 → 本地时间字符串展示。"""
    if not value:
        return None
    try:
        utc = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return value
    return utc.astimezone(app_tz()).strftime(fmt)


def local_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def last_monday(d: date) -> date:
    """A1：一周 = 周一 00:00 至周日 24:00。返回给定日期所在周的周一。"""
    return d - timedelta(days=d.weekday())


def week_range(week_start: date) -> tuple[datetime, datetime]:
    """(周一 00:00, 次周一 00:00) 的本地时间区间，即周日 24:00。"""
    start = datetime.combine(week_start, time(0, 0), tzinfo=app_tz())
    return start, start + timedelta(days=7)


def to_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc)


def week_start_of(week_start: date) -> date:
    """校正为所在周周一。"""
    return last_monday(week_start)
