"""对话查询：根据用户问题从库中检索待办与会议，由文本模型回答；未配置模型时关键词兜底。"""
import json
import logging
import os
import re
import urllib.parse
import urllib.request
from datetime import timedelta

from .. import config, db, llm, timex

logger = logging.getLogger("workbench.query")

WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 2026 年法定节假日（国务院办公厅 国办发明电〔2025〕7 号）
HOLIDAYS_2026 = {
    "2026-01-01", "2026-01-02", "2026-01-03",
    "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
    "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
    "2026-04-04", "2026-04-05", "2026-04-06",
    "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
    "2026-06-19", "2026-06-20", "2026-06-21",
    "2026-09-25", "2026-09-26", "2026-09-27",
    "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
    "2026-10-05", "2026-10-06", "2026-10-07",
}

# 2026 年调休补班（周末上班）
WORKDAYS_2026 = {
    "2026-01-04", "2026-02-14", "2026-02-28",
    "2026-05-09", "2026-09-20", "2026-10-10",
}


def _cal_path(year: int) -> str:
    return os.path.join(config.get_data_dir(), "calendars", f"{year}.json")


def _load_year(year: int) -> tuple[set, set]:
    """读某一年日历：data/calendars/{year}.json 优先；否则兜底内置 2026。"""
    path = _cal_path(year)
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fp:
                d = json.load(fp)
            return set(d.get("holidays", [])), set(d.get("workdays", []))
        except Exception:
            logger.exception("读取日历文件失败: %s", path)
    if year == 2026:
        return set(HOLIDAYS_2026), set(WORKDAYS_2026)
    return set(), set()


def workcalendar() -> dict:
    """返回当前年与下一年工作日历（跨年翻页也能显示）。"""
    year = timex.now_local().year
    years = []
    for y in (year, year + 1):
        h, w = _load_year(y)
        years.append({"year": y, "holidays": sorted(h), "workdays": sorted(w)})
    return {"years": years}


def _http_get(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) WorkBoard/1.0"
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="ignore")


def _parse_notice(year: int, text: str) -> tuple[list, list]:
    """从通知正文提取节假日区间与补班日。"""
    holidays, workdays = set(), set()
    for m in re.finditer(r"(\d{1,2})月(\d{1,2})日[^。；，,]*?上班", text):
        mo, da = int(m.group(1)), int(m.group(2))
        try:
            from datetime import date
            workdays.add(date(year, mo, da).isoformat())
        except ValueError:
            pass
    for m in re.finditer(r"(\d{1,2})月(\d{1,2})日[^至。]*?至(\d{1,2})月(\d{1,2})日[^。]*?放假", text):
        from datetime import date, timedelta as _td
        m1, d1, m2, d2 = (int(m.group(i)) for i in range(1, 5))
        try:
            a, b = date(year, m1, d1), date(year, m2, d2)
            if a <= b:
                cur = a
                while cur <= b:
                    holidays.add(cur.isoformat())
                    cur += _td(days=1)
        except ValueError:
            pass
    return sorted(holidays), sorted(workdays)


def refresh_calendar(year: int | None = None) -> dict:
    """手动触发：从中国政府网抓取某年节假日通知并写入 data/calendars/{year}.json。"""
    if year is None:
        year = timex.now_local().year + 1
    kw = f"{year}年部分节假日安排的通知"
    search_url = "https://sousuo.www.gov.cn/sousuo/search.shtml?" + urllib.parse.urlencode({
        "code": "17da70961a7", "searchWord": kw, "dataTypeId": "107"
    })
    page = _http_get(search_url)
    links = re.findall(r'https?://www\.gov\.cn/[^"\']*?content_\d+\.htm', page)
    text = ""
    for link in links[:5]:
        body = _http_get(link)
        if f"{year}年" in body and "放假" in body:
            text = body
            break
    if not text:
        return {"ok": False, "year": year, "message": "未检索到该年通知（可能尚未公布），未改动现有日历"}
    h, w = _parse_notice(year, text)
    if not h:
        return {"ok": False, "year": year, "message": "解析到 0 个节假日，正文未匹配，未改动现有日历"}
    os.makedirs(os.path.dirname(_cal_path(year)), exist_ok=True)
    out = {
        "year": year,
        "source": "gov.cn 手动触发",
        "holidays": h,
        "workdays": w,
        "updated_at": timex.now_local().isoformat(timespec="seconds"),
    }
    with open(_cal_path(year), "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, indent=2)
    return {"ok": True, "year": year, "holidays": len(h), "workdays": len(w),
            "message": f"已更新 {year} 年：{len(h)} 天放假、{len(w)} 天补班"}


def _load_records() -> tuple[list[dict], list[dict]]:
    with db.get_conn() as conn:
        todos = []
        for r in conn.execute(
            "SELECT t.id, t.content, t.due_date, t.status, p.name AS project_name "
            "FROM todos t LEFT JOIN projects p ON p.id = t.project_id "
            "ORDER BY t.status, t.due_date IS NULL, t.due_date, t.id DESC"
        ).fetchall():
            todos.append(dict(r))
        meetings = []
        for r in conn.execute(
            "SELECT id, title, start_at, participants, location, status "
            "FROM meetings ORDER BY start_at IS NULL, start_at, id DESC"
        ).fetchall():
            d = dict(r)
            d["start_at_local"] = timex.utc_to_local_str(d["start_at"]) if d["start_at"] else ""
            meetings.append(d)
    return todos, meetings


def _fmt_todo(t: dict) -> str:
    due = t.get("due_date") or "无截止"
    proj = t.get("project_name") or "未归属"
    return f"[id={t['id']}][{t['status']}] 截止{due} | {proj} | {t['content']}"


def _fmt_meeting(m: dict) -> str:
    return f"[id={m['id']}][{m['status']}] {m['start_at_local'] or '时间待补'} | {m['title']}"


def _fallback_ask(q: str, todos: list[dict], meetings: list[dict]) -> dict:
    """未配置模型：按关键词与时间词粗筛。"""
    keyword = q.strip()
    todo_ids, meeting_ids = [], []
    for t in todos:
        if t["status"] == "done":
            continue
        if not keyword or keyword in t["content"] or (t.get("project_name") and keyword in t["project_name"]):
            todo_ids.append(t["id"])
    for m in meetings:
        if keyword and keyword in m["title"]:
            meeting_ids.append(m["id"])
    if not todo_ids and not meeting_ids:
        todo_ids = [t["id"] for t in todos if t["status"] == "open"]
        meeting_ids = [m["id"] for m in meetings if m["start_at_local"]]
    answer = f"为你找到 {len(todo_ids)} 条待办、{len(meeting_ids)} 条会议安排（未配置模型，按关键词检索）"
    return {"action": "query", "answer": answer, "todo_ids": todo_ids, "meeting_ids": meeting_ids}


def ask(q: str) -> dict:
    todos, meetings = _load_records()
    now = timex.now_local()
    today_str = now.strftime("%Y-%m-%d")
    weekday = WEEKDAYS[now.weekday()]
    todos_txt = "\n".join(_fmt_todo(t) for t in todos) or "（无）"
    meetings_txt = "\n".join(_fmt_meeting(m) for m in meetings) or "（无）"

    system = (
        "你是个人工作助手「日知」。根据用户问题，从下面提供的待办和会议数据中回答。\n"
        "规则：\n"
        "1. 用户在「查询/了解已有事项」时（如：我有哪些待办、明天有什么会、这周安排、还有什么没做、待办列表），"
        "返回 action=query，用简洁中文列出相关事项，并在 todo_ids / meeting_ids 给出对应 id。\n"
        "2. 用户在「要新增一条记录」时（如：明天下午3点开评审会、帮我记一下买咖啡），"
        "返回 action=parse，answer 留空。\n"
        "3. 只基于提供的数据，不要编造；数据里没有就如实说没有。\n"
        '严格返回 JSON：{"action":"query"|"parse","answer":"...","todo_ids":[...],"meeting_ids":[...]}'
    )
    user = (
        f"今天是 {today_str} {weekday}。\n\n"
        f"待办列表：\n{todos_txt}\n\n"
        f"会议列表：\n{meetings_txt}\n\n"
        f"用户问题：{q}"
    )

    try:
        raw = llm._chat("text", [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ])
        data = llm._extract_json(raw)
        action = data.get("action")
        if action not in ("query", "parse"):
            action = "query"
        result = {
            "action": action,
            "answer": data.get("answer", "") or "",
            "todo_ids": data.get("todo_ids", []) or [],
            "meeting_ids": data.get("meeting_ids", []) or [],
            "model_used": True,
            "error": None,
        }
    except llm.LLMError as e:
        result = _fallback_ask(q, todos, meetings)
        result["model_used"] = False
        result["error"] = llm.error_payload(e)

    id2todo = {t["id"]: t for t in todos}
    id2meeting = {m["id"]: m for m in meetings}
    result["todos"] = [id2todo[i] for i in result["todo_ids"] if i in id2todo]
    result["meetings"] = [id2meeting[i] for i in result["meeting_ids"] if i in id2meeting]
    return result
