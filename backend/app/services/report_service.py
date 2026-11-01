"""周报服务（架构 5.2）：数据事实与模型生成严格分离。

- 完成 / 进行中 / 逾期 / 会议四个区块全部由 SQLite 查询确定性组装；
- 模型只参与概览摘要，输入限定为已落库事实，提示词禁止编造；
- 空数据直接生成占位草稿，不调用模型；
- 覆盖保护：本周草稿已有编辑内容时，重新生成需 force（前端二次确认）。
"""
import logging
from datetime import date, datetime

from .. import db, llm, timex

logger = logging.getLogger("workbench.report")

PLACEHOLDER = "## 本周暂无记录\n\n本周没有会议、待办完成或进行中的记录。"


def _fmt_date(d: date) -> str:
    return d.strftime("%m.%d")


def _week_label(week_start: date, week_end: date) -> str:
    return f"{_fmt_date(week_start)}–{_fmt_date(week_end)}"


def _collect_facts(week_start: date, week_end: date) -> dict:
    """确定性查询本周数据事实（A1：周一 00:00 至周日 24:00，本地时区）。"""
    start_local, end_local = timex.week_range(week_start)
    start_utc = timex.to_utc(start_local).strftime("%Y-%m-%dT%H:%M:%SZ")
    end_utc = timex.to_utc(end_local).strftime("%Y-%m-%dT%H:%M:%SZ")
    today = timex.now_local().date()

    with db.get_conn() as conn:
        completed = conn.execute(
            "SELECT t.content, t.completed_at, t.due_date, p.name AS project_name "
            "FROM todos t LEFT JOIN projects p ON p.id = t.project_id "
            "WHERE t.status = 'done' AND t.completed_at >= ? AND t.completed_at < ? "
            "ORDER BY p.name, t.completed_at",
            (start_utc, end_utc),
        ).fetchall()
        open_todos = conn.execute(
            "SELECT t.content, t.due_date, t.created_at, p.name AS project_name "
            "FROM todos t LEFT JOIN projects p ON p.id = t.project_id "
            "WHERE t.status = 'open' ORDER BY t.due_date IS NULL, t.due_date",
        ).fetchall()
        meetings = conn.execute(
            "SELECT title, start_at, participants, status, created_at FROM meetings "
            "WHERE (start_at >= ? AND start_at < ?) "
            "   OR (start_at IS NULL AND status = 'pending_completion' "
            "       AND created_at >= ? AND created_at < ?) "
            "ORDER BY start_at IS NULL, start_at",
            (start_utc, end_utc, start_utc, end_utc),
        ).fetchall()
    return {
        "completed": [dict(r) for r in completed],
        "open_todos": [dict(r) for r in open_todos],
        "meetings": [dict(r) for r in meetings],
        "today": today,
    }


def _assemble_facts_markdown(facts: dict) -> str:
    """把数据事实渲染为事实清单（同时作为摘要模型的输入与周报正文区块）。"""
    lines: list[str] = []

    if facts["completed"]:
        lines.append("### 本周完成")
        by_project: dict[str, list] = {}
        for t in facts["completed"]:
            by_project.setdefault(t["project_name"] or "未归属项目", []).append(t)
        for pname, items in by_project.items():
            lines.append(f"- [{pname}] " + "；".join(
                f"{i['content']}（完成于 {timex.utc_to_local_str(i['completed_at'], '%m.%d')}）"
                for i in items
            ))
    if facts["open_todos"]:
        lines.append("### 进行中")
        for t in facts["open_todos"]:
            due = timex.local_date(t["due_date"])
            overdue = due and due < facts["today"]
            suffix = ""
            if due:
                suffix = f"（截止 {due.strftime('%m.%d')}，已逾期）" if overdue else f"（截止 {due.strftime('%m.%d')}）"
            lines.append(f"- [{t['project_name'] or '未归属项目'}] {t['content']}{suffix}")
    if facts["meetings"]:
        lines.append("### 本周会议")
        for m in facts["meetings"]:
            if m["start_at"]:
                when = timex.utc_to_local_str(m["start_at"], "%m.%d %H:%M")
                lines.append(f"- {when} {m['title']}（{m['status']}）"
                             + (f"（参与方：{m['participants']}）" if m["participants"] else ""))
            else:
                lines.append(f"- 时间待补全 · {m['title']}（待补全）")
    return "\n".join(lines)


def generate(week_start_str: str | None, force: bool) -> dict:
    """POST /api/reports/generate。返回 (report_dict, error_dict)。"""
    tz_today = timex.now_local().date()
    if week_start_str:
        ws = timex.local_date(week_start_str)
        if not ws:
            return {"error": {"code": "bad_request", "message": "week_start 日期格式应为 YYYY-MM-DD"}}
        ws = timex.week_start_of(ws)  # 校正到周一
    else:
        ws = timex.last_monday(tz_today)
    we = ws.fromordinal(ws.toordinal() + 6)

    with db.get_conn() as conn:
        existing = conn.execute(
            "SELECT * FROM weekly_reports WHERE week_start = ?", (ws.isoformat(),)
        ).fetchone()

    if existing and existing["status"] == "finalized":
        return {"error": {
            "code": "finalized",
            "message": "本周周报已定稿。定稿后如需修改，请在周报列表中打开编辑（记为修订），不会覆盖定稿。",
        }}
    if (existing and existing["status"] == "draft"
            and existing["edited_since_generation"] and not force):
        return {"error": {
            "code": "overwrite_confirm",
            "message": "本周草稿已有编辑内容，重新生成将覆盖当前草稿，请确认。",
        }}

    facts = _collect_facts(ws, we)
    has_data = bool(facts["completed"] or facts["open_todos"] or facts["meetings"])
    label = _week_label(ws, we)

    if not has_data:
        # 空数据：占位草稿，不调用模型，不编造（F3 边界）
        markdown = f"# 周报（{label}）\n\n{PLACEHOLDER}\n"
        summary_note = "未调用模型：本周无数据"
    else:
        body = _assemble_facts_markdown(facts)
        try:
            summary = llm.summarize_week(body, label)
            summary_note = None
        except llm.LLMError as e:
            summary = f"（摘要生成失败：{e.message}。可重新生成，或直接手动撰写本段。）"
            summary_note = e.category
        markdown = f"# 周报（{label}）\n\n## 概览\n\n{summary}\n\n{body}\n"

    now = db.utcnow_iso()
    with db.get_conn() as conn:
        if existing:
            conn.execute(
                "UPDATE weekly_reports SET content_markdown = ?, status = 'draft', "
                "edited_since_generation = 0, updated_at = ? WHERE id = ?",
                (markdown, now, existing["id"]),
            )
            report_id = existing["id"]
        else:
            cur = conn.execute(
                "INSERT INTO weekly_reports(week_start, week_end, content_markdown, status, "
                "edited_since_generation, created_at, updated_at) "
                "VALUES(?,?,?,'draft',0,?,?)",
                (ws.isoformat(), we.isoformat(), markdown, now, now),
            )
            report_id = cur.lastrowid
    logger.info("report generated week=%s has_data=%s summary_note=%s",
                ws.isoformat(), has_data, summary_note)
    return _report_row(report_id) | {"has_data": has_data, "summary_note": summary_note}


def _report_row(report_id: int) -> dict:
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM weekly_reports WHERE id = ?", (report_id,)).fetchone()
    if not row:
        return {}
    r = dict(row)
    r.pop("edited_since_generation", None)
    return r


def list_reports() -> list[dict]:
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT id, week_start, week_end, status, updated_at, "
            "substr(content_markdown, 1, 80) AS preview FROM weekly_reports "
            "ORDER BY week_start DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def get_report(report_id: int) -> dict | None:
    return _report_row(report_id) or None


def update_report(report_id: int, content_markdown: str | None, status: str | None) -> dict:
    now = db.utcnow_iso()
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM weekly_reports WHERE id = ?", (report_id,)).fetchone()
        if not row:
            return {"error": {"code": "not_found", "message": "周报不存在"}}
        if content_markdown is not None and content_markdown != row["content_markdown"]:
            conn.execute(
                "UPDATE weekly_reports SET content_markdown = ?, "
                "edited_since_generation = 1, updated_at = ? WHERE id = ?",
                (content_markdown, now, report_id),
            )
        if status is not None:
            conn.execute(
                "UPDATE weekly_reports SET status = ?, updated_at = ? WHERE id = ?",
                (status, now, report_id),
            )
    return _report_row(report_id)
