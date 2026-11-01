#!/usr/bin/env python3
"""更新某年工作日历（节假日 + 调休补班）。

自动模式：从中国政府网检索《关于{year}年部分节假日安排的通知》并解析。
手动模式：直接指定 holidays / workdays 写入。

用法：
  python3 update_calendar.py --year 2027
  python3 update_calendar.py --year 2027 --holidays 2027-01-01,2027-01-02 --workdays 2027-01-04

退出码：0=已更新或本就最新；1=抓取/解析失败且未改动现有文件。
"""
import argparse
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CAL_DIR = ROOT / "data" / "calendars"

HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) WorkBoardCalendar/1.0"}


def http_get(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
    # gov.cn 页面多为 utf-8
    return raw.decode("utf-8", errors="ignore")


def daterange(a: datetime.date, b: datetime.date):
    days = (b - a).days + 1
    for i in range(days):
        yield a + datetime.timedelta(days=i)


def parse_year(year: int, text: str):
    """从通知正文解析节假日区间与补班日。返回 (holidays, workdays)。"""
    holidays, workdays = set(), set()

    # 补班："X月Y日（周X）上班" 或 "X月Y日（周X）上班、X月Y日...上班"
    for m in re.finditer(r"(\d{1,2})月(\d{1,2})日[^。；，,]*?上班", text):
        mo, da = int(m.group(1)), int(m.group(2))
        try:
            workdays.add(datetime.date(year, mo, da).isoformat())
        except ValueError:
            pass

    # 放假区间："X月Y日（...）至X月Y日（...）放假"
    for m in re.finditer(r"(\d{1,2})月(\d{1,2})日[^至。]*?至(\d{1,2})月(\d{1,2})日[^。]*?放假", text):
        m1, d1, m2, d2 = (int(m.group(i)) for i in range(1, 5))
        try:
            a, b = datetime.date(year, m1, d1), datetime.date(year, m2, d2)
            if a <= b:
                for d in daterange(a, b):
                    holidays.add(d.isoformat())
        except ValueError:
            pass

    # 单日/三日放假："X月Y日（周X）至X月Y日（周X）放假，共N天" 已由上面覆盖
    return sorted(holidays), sorted(workdays)


def fetch_notice_text(year: int) -> str:
    """从 gov.cn 站内搜索该年通知，取第一条正文。"""
    kw = f"{year}年部分节假日安排的通知"
    search_url = "https://sousuo.www.gov.cn/sousuo/search.shtml?" + urllib.parse.urlencode({
        "code": "17da70961a7", "searchWord": kw, "dataTypeId": "107"
    })
    page = http_get(search_url)
    # 提取内容链接
    links = re.findall(r'https?://www\.gov\.cn/[^"\']*?content_\d+\.htm', page)
    for link in links[:5]:
        if str(year) in link or "zhengceku" in link:
            body = http_get(link)
            if f"{year}年" in body and "放假" in body:
                return body
    raise RuntimeError("未在 gov.cn 检索到该年通知")


def write_year(year: int, holidays: list, workdays: list, source: str = "auto"):
    CAL_DIR.mkdir(parents=True, exist_ok=True)
    out = {
        "year": year,
        "source": source,
        "holidays": holidays,
        "workdays": workdays,
        "updated_at": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    path = CAL_DIR / f"{year}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写入 {path}：节假日 {len(holidays)} 天，补班 {len(workdays)} 天")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=datetime.date.today().year + 1)
    ap.add_argument("--holidays", default="")
    ap.add_argument("--workdays", default="")
    args = ap.parse_args()

    year = args.year
    if args.holidays or args.workdays:
        h = [x.strip() for x in args.holidays.split(",") if x.strip()]
        w = [x.strip() for x in args.workdays.split(",") if x.strip()]
        write_year(year, h, w, source="manual")
        return

    try:
        text = fetch_notice_text(year)
        h, w = parse_year(year, text)
        if not h:
            raise RuntimeError("解析到 0 个节假日，疑似正文未匹配")
        write_year(year, h, w, source="gov.cn auto")
    except Exception as e:
        print(f"[失败] {e}", file=sys.stderr)
        print("未改动现有日历文件。可手动执行：", file=sys.stderr)
        print(f"  python3 {Path(__file__).name} --year {year} --holidays ... --workdays ...", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
