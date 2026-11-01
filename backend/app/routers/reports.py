"""路由：周报（F3，架构 6.2）。"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from ..services import report_service
from ..schemas import ReportGenerateRequest, ReportUpdate

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.post("/generate")
def generate(req: ReportGenerateRequest):
    result = report_service.generate(req.week_start, req.force)
    if "error" in result:
        err = result["error"]
        status = 409 if err["code"] in ("overwrite_confirm", "finalized") else 400
        raise HTTPException(status_code=status, detail=err)
    return result


@router.get("")
def list_reports():
    return report_service.list_reports()


@router.get("/{rid}")
def get_report(rid: int):
    r = report_service.get_report(rid)
    if not r:
        raise HTTPException(404, {"code": "not_found", "message": "周报不存在"})
    return r


@router.patch("/{rid}")
def update_report(rid: int, req: ReportUpdate):
    result = report_service.update_report(rid, req.content_markdown, req.status)
    if "error" in result:
        raise HTTPException(404, result["error"])
    return result


@router.get("/{rid}/export")
def export_report(rid: int):
    r = report_service.get_report(rid)
    if not r:
        raise HTTPException(404, {"code": "not_found", "message": "周报不存在"})
    filename = f"weekly-report-{r['week_start']}.md"
    return PlainTextResponse(
        content=r["content_markdown"],
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
