"""解析服务（架构 5.1）：先落库再解析，确认卡片是唯一结构化落库通道。"""
import json
import logging

from .. import db, llm, timex
from ..schemas import ConfirmRequest, ParseOutput

logger = logging.getLogger("workbench.parse")


def _fallback_parse(raw: str) -> ParseOutput:
    """解析失败兜底：原文完整保留，字段留空待补（F1/F2 兜底规则）。"""
    return ParseOutput(
        intent="todo",
        suggested_destination="todo",
        meeting={"title": raw, "missing": ["start_at", "participants"]},
        todo={"content": raw, "missing": ["due_date", "project_name"]},
    )


def _parse_to_payload(p: ParseOutput) -> dict:
    return {
        "intent": p.intent,
        "suggested_destination": p.suggested_destination,
        "multiple_items": p.multiple_items,
        "split_hint": p.split_hint,
        "meeting": p.meeting.model_dump(),
        "todo": p.todo.model_dump(),
    }


def submit_text(raw: str) -> dict:
    """POST /api/parse：source_record 先落一条 pending，再解析；失败不丢原文。"""
    now = db.utcnow_iso()
    with db.get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO source_records(input_type, raw_text, status, created_at) "
            "VALUES('text', ?, 'pending', ?)",
            (raw, now),
        )
        record_id = cur.lastrowid
    try:
        parsed = llm.parse_text(raw)
        payload = _parse_to_payload(parsed)
        fallback = False
        error = None
        result_json = json.dumps(payload, ensure_ascii=False)
    except llm.LLMError as e:
        parsed = _fallback_parse(raw)
        payload = _parse_to_payload(parsed)
        fallback = True
        error = llm.error_payload(e)
        result_json = json.dumps(payload, ensure_ascii=False)
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE source_records SET parse_result_json = ? WHERE id = ?",
            (result_json, record_id),
        )
    return {
        "source_record_id": record_id,
        "input_type": "text",
        "raw_text": raw,
        "fallback": fallback,
        "error": error,
        "parse": payload,
        "now_local": timex.now_local().strftime("%Y-%m-%d %H:%M:%S"),
    }


def get_record(record_id: int) -> dict | None:
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM source_records WHERE id = ?", (record_id,)).fetchone()
    if not row:
        return None
    rec = dict(row)
    rec["parse"] = json.loads(rec["parse_result_json"]) if rec["parse_result_json"] else None
    return rec


def update_record(record_id: int, destination: str | None, parse: ParseOutput | None,
                  recognized_text: str | None) -> dict:
    """PUT /api/parse/{id}：确认前保存用户修改（含会议/待办切换、图片识别候选字段）。"""
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM source_records WHERE id = ? AND status = 'pending'",
            (record_id,),
        ).fetchone()
        if not row:
            return {"error": "not_found_or_not_pending"}
        updates, params = [], []
        if parse is not None:
            payload = _parse_to_payload(parse)
            if recognized_text is not None:
                payload = {"recognized_text": recognized_text, "suggested": payload}
            updates.append("parse_result_json = ?")
            params.append(json.dumps(payload, ensure_ascii=False))
        if destination is not None:
            updates.append("destination = ?")
            params.append(destination)
        if updates:
            params.append(record_id)
            conn.execute(f"UPDATE source_records SET {', '.join(updates)} WHERE id = ?", params)
    return get_record(record_id) or {}


def _resolve_project(conn, project_id: int | None, new_project_name: str | None) -> tuple[int | None, dict | None]:
    """项目归属判定（架构 5.1 要点 5）。返回 (project_id, error)。"""
    if new_project_name:
        name = new_project_name.strip()
        if not name:
            return None, {"code": "bad_request", "message": "新项目名不能为空"}
        exists = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
        if exists:
            return _resolve_project(exists["id"], None)
        cur = conn.execute(
            "INSERT INTO projects(name, description, status, created_at) VALUES(?, '', 'active', ?)",
            (name, db.utcnow_iso()),
        )
        return cur.lastrowid, None
    if project_id is None:
        return None, None
    row = conn.execute("SELECT id, name, status FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        return None, {"code": "project_not_found", "message": "所选项目不存在"}
    if row["status"] != "active":
        return None, {
            "code": "project_archived",
            "message": f"项目「{row['name']}」已归档，请先在项目管理中恢复，或改选其他项目",
        }
    return row["id"], None


def confirm(record_id: int, req: ConfirmRequest) -> dict:
    """POST /api/parse/{id}/confirm：按 destination 写入会议或待办。"""
    now = db.utcnow_iso()
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM source_records WHERE id = ? AND status = 'pending'",
            (record_id,),
        ).fetchone()
        if not row:
            return {"error": "not_found_or_not_pending"}

        created = None
        if req.destination == "meeting":
            if not req.meeting:
                return {"error": "bad_request", "message": "缺少会议字段"}
            m = req.meeting
            start_utc = timex.local_to_utc_iso(m.start_at) if m.start_at else None
            status = "planned" if start_utc else "pending_completion"
            cur = conn.execute(
                "INSERT INTO meetings(title, start_at, participants, location, note, status, "
                "project_id, source_record_id, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,NULL,?,?,?)",
                (m.title.strip(), start_utc, m.participants, m.location, m.note,
                 status, record_id, now, now),
            )
            created = {"type": "meeting", "id": cur.lastrowid,
                       "status": status, "start_at": m.start_at}
        elif req.destination == "todo":
            if not req.todo:
                return {"error": "bad_request", "message": "缺少待办字段"}
            t = req.todo
            project_id, perr = _resolve_project(conn, t.project_id, t.new_project_name)
            if perr:
                return {"error": perr}
            cur = conn.execute(
                "INSERT INTO todos(content, due_date, project_id, status, source_record_id, created_at) "
                "VALUES(?,?,?,'open',?,?)",
                (t.content.strip(), t.due_date, project_id, record_id, now),
            )
            created = {"type": "todo", "id": cur.lastrowid, "project_id": project_id}
        else:  # note：仅存档，原图与识别文本已在 source_records/images 中可回看（A14）
            created = {"type": "note"}

        conn.execute(
            "UPDATE source_records SET status = 'confirmed', destination = ?, resolved_at = ? "
            "WHERE id = ?",
            (req.destination, now, record_id),
        )
    created["source_record_id"] = record_id
    return created


def discard(record_id: int) -> dict:
    """DELETE /api/parse/{id}：放弃本次解析，原文保留为 discarded。"""
    with db.get_conn() as conn:
        cur = conn.execute(
            "UPDATE source_records SET status = 'discarded', resolved_at = ? "
            "WHERE id = ? AND status = 'pending'",
            (db.utcnow_iso(), record_id),
        )
        if cur.rowcount == 0:
            return {"error": "not_found_or_not_pending"}
    return {"discarded": record_id}
