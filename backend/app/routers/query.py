"""路由：对话查询（检索已有待办与会议）。"""
from fastapi import APIRouter
from pydantic import BaseModel

from ..services import query_service

router = APIRouter(prefix="/api/query", tags=["query"])


class AskRequest(BaseModel):
    text: str


@router.post("")
def ask(req: AskRequest):
    q = req.text.strip()
    if not q:
        return {"action": "query", "answer": "", "todos": [], "meetings": []}
    return query_service.ask(q)


@router.get("/workcalendar")
def workcalendar():
    """2026 年法定节假日与调休补班日历。"""
    return query_service.workcalendar()


@router.post("/refresh-calendar")
def refresh_calendar(year: int | None = None):
    """手动触发：抓取某年节假日通知并写入日历文件。"""
    return query_service.refresh_calendar(year)
