"""路由：项目 / 待办 / 会议管理（F1/F2，架构 6.2）。"""
from fastapi import APIRouter, HTTPException

from .. import db, timex
from ..schemas import (MeetingUpdate, ProjectCreate, ProjectUpdate,
                       TodoCreate, TodoUpdate)

router = APIRouter(prefix="/api", tags=["records"])


# ---------- 项目 ----------

@router.get("/projects")
def list_projects(status: str | None = None):
    with db.get_conn() as conn:
        if status in ("active", "archived"):
            rows = conn.execute(
                "SELECT * FROM projects WHERE status = ? ORDER BY name", (status,)).fetchall()
        else:
            rows = conn.execute("SELECT * FROM projects ORDER BY status, name").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d["archived_at"]:
            d["archived_at"] = timex.utc_to_local_str(d["archived_at"])
        d["created_at"] = timex.utc_to_local_str(d["created_at"])
        out.append(d)
    return out


@router.post("/projects")
def create_project(req: ProjectCreate):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, {"code": "bad_request", "message": "项目名不能为空"})
    with db.get_conn() as conn:
        dup = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
        if dup:
            raise HTTPException(409, {"code": "duplicate", "message": f"项目「{name}」已存在"})
        cur = conn.execute(
            "INSERT INTO projects(name, description, status, created_at) VALUES(?,?, 'active', ?)",
            (name, req.description, db.utcnow_iso()),
        )
        pid = cur.lastrowid
    return {"id": pid, "name": name, "description": req.description, "status": "active"}


@router.patch("/projects/{pid}")
def update_project(pid: int, req: ProjectUpdate):
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
        if not row:
            raise HTTPException(404, {"code": "not_found", "message": "项目不存在"})
        if req.name is not None:
            dup = conn.execute(
                "SELECT id FROM projects WHERE name = ? AND id != ?", (req.name, pid)).fetchone()
            if dup:
                raise HTTPException(409, {"code": "duplicate", "message": "项目名已存在"})
            conn.execute("UPDATE projects SET name = ? WHERE id = ?", (req.name, pid))
        if req.description is not None:
            conn.execute("UPDATE projects SET description = ? WHERE id = ?", (req.description, pid))
        if req.status is not None and req.status != row["status"]:
            if req.status == "archived":
                conn.execute(
                    "UPDATE projects SET status = 'archived', archived_at = ? WHERE id = ?",
                    (db.utcnow_iso(), pid))
            else:
                conn.execute(
                    "UPDATE projects SET status = 'active', archived_at = NULL WHERE id = ?", (pid,))
    with db.get_conn() as conn:
        return dict(conn.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone())


# ---------- 待办 ----------

def _todo_out(r) -> dict:
    d = dict(r)
    d["created_at"] = timex.utc_to_local_str(d["created_at"])
    d["completed_at"] = timex.utc_to_local_str(d["completed_at"])
    return d


@router.get("/todos")
def list_todos(project_id: int | None = None, status: str | None = None):
    sql = ("SELECT t.*, p.name AS project_name FROM todos t "
           "LEFT JOIN projects p ON p.id = t.project_id WHERE 1=1")
    params: list = []
    if project_id is not None:
        sql += " AND t.project_id = ?"
        params.append(project_id)
    if project_id == 0:  # 0 = 未归属（project_id IS NULL）
        sql = sql.replace("t.project_id = ?", "t.project_id IS NULL")
        params = params[:-1]
    if status in ("open", "done"):
        sql += " AND t.status = ?"
        params.append(status)
    sql += " ORDER BY t.status, t.due_date IS NULL, t.due_date, t.id DESC"
    with db.get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_todo_out(r) for r in rows]


@router.post("/todos")
def create_todo(req: TodoCreate):
    with db.get_conn() as conn:
        if req.project_id is not None:
            p = conn.execute("SELECT status FROM projects WHERE id = ?", (req.project_id,)).fetchone()
            if not p:
                raise HTTPException(400, {"code": "project_not_found", "message": "所选项目不存在"})
            if p["status"] != "active":
                raise HTTPException(409, {
                    "code": "project_archived",
                    "message": "项目已归档，无法新建待办；请先恢复项目或改选"})
        cur = conn.execute(
            "INSERT INTO todos(content, due_date, project_id, status, created_at) "
            "VALUES(?,?,?,'open',?)",
            (req.content.strip(), req.due_date, req.project_id, db.utcnow_iso()))
        tid = cur.lastrowid
        row = conn.execute(
            "SELECT t.*, p.name AS project_name FROM todos t "
            "LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?", (tid,)).fetchone()
    return _todo_out(row)


@router.patch("/todos/{tid}")
def update_todo(tid: int, req: TodoUpdate):
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM todos WHERE id = ?", (tid,)).fetchone()
        if not row:
            raise HTTPException(404, {"code": "not_found", "message": "待办不存在"})
        if req.content is not None:
            conn.execute("UPDATE todos SET content = ? WHERE id = ?", (req.content.strip(), tid))
        if req.due_date is not None:
            conn.execute("UPDATE todos SET due_date = ? WHERE id = ?", (req.due_date, tid))
        if req.project_id is not None:
            p = conn.execute("SELECT status FROM projects WHERE id = ?", (req.project_id,)).fetchone()
            if not p:
                raise HTTPException(400, {"code": "project_not_found", "message": "所选项目不存在"})
            if p["status"] != "active":
                raise HTTPException(409, {
                    "code": "project_archived",
                    "message": "项目已归档，请先恢复或改选"})
            conn.execute("UPDATE todos SET project_id = ? WHERE id = ?", (req.project_id, tid))
        if req.status is not None and req.status != row["status"]:
            if req.status == "done":
                conn.execute(
                    "UPDATE todos SET status = 'done', completed_at = ? WHERE id = ?",
                    (db.utcnow_iso(), tid))
            else:
                conn.execute(
                    "UPDATE todos SET status = 'open', completed_at = NULL WHERE id = ?", (tid,))
        out = conn.execute(
            "SELECT t.*, p.name AS project_name FROM todos t "
            "LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?", (tid,)).fetchone()
    return _todo_out(out)


# ---------- 会议 ----------

def _meeting_out(r) -> dict:
    d = dict(r)
    d["start_at"] = timex.utc_to_local_str(d["start_at"])
    d["created_at"] = timex.utc_to_local_str(d["created_at"])
    d["updated_at"] = timex.utc_to_local_str(d["updated_at"])
    return d


@router.get("/meetings")
def list_meetings(status: str | None = None):
    sql = "SELECT * FROM meetings WHERE 1=1"
    params: list = []
    if status:
        sql += " AND status = ?"
        params.append(status)
    # 按开始时间排序；时间待补全（start_at 为空）置底按创建时间倒序
    sql += " ORDER BY start_at IS NULL, start_at, created_at DESC"
    with db.get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_meeting_out(r) for r in rows]


@router.patch("/meetings/{mid}")
def update_meeting(mid: int, req: MeetingUpdate):
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
        if not row:
            raise HTTPException(404, {"code": "not_found", "message": "会议不存在"})
        if req.start_at is not None:
            start_utc = timex.local_to_utc_iso(req.start_at)
            conn.execute("UPDATE meetings SET start_at = ? WHERE id = ?", (start_utc, mid))
            # 补全时间后，待补全状态自动转为待开
            if row["status"] == "pending_completion" and start_utc:
                conn.execute("UPDATE meetings SET status = 'planned' WHERE id = ?", (mid,))
        if req.title is not None:
            conn.execute("UPDATE meetings SET title = ? WHERE id = ?", (req.title.strip(), mid))
        for field in ("participants", "location", "note"):
            v = getattr(req, field)
            if v is not None:
                conn.execute(f"UPDATE meetings SET {field} = ? WHERE id = ?", (v, mid))
        if req.status is not None:
            conn.execute("UPDATE meetings SET status = ? WHERE id = ?", (req.status, mid))
        conn.execute("UPDATE meetings SET updated_at = ? WHERE id = ?", (db.utcnow_iso(), mid))
        out = conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone()
    return _meeting_out(out)
