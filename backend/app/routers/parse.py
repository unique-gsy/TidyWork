"""路由：解析确认流程（F1/F2 共用，架构 6.2）。"""
from fastapi import APIRouter, HTTPException

from ..services import parse_service
from ..schemas import ConfirmRequest, ParseRequest, ParseUpdateRequest

router = APIRouter(prefix="/api/parse", tags=["parse"])


@router.post("")
def submit(req: ParseRequest):
    return parse_service.submit_text(req.text)


@router.put("/{record_id}")
def update(record_id: int, req: ParseUpdateRequest):
    result = parse_service.update_record(
        record_id, req.destination, req.parse, req.recognized_text)
    if result.get("error"):
        code = result["error"]
        raise HTTPException(
            status_code=404 if code == "not_found_or_not_pending" else 400,
            detail={"code": code, "message": code.replace("_", " ")},
        )
    return result


@router.post("/{record_id}/confirm")
def confirm(record_id: int, req: ConfirmRequest):
    result = parse_service.confirm(record_id, req)
    if "error" in result:
        err = result["error"]
        status = 404 if err == "not_found_or_not_pending" else 400
        if isinstance(err, dict):
            status = 409 if err["code"] in ("project_archived", "overwrite_confirm") else 400
            raise HTTPException(status_code=status, detail=err)
        raise HTTPException(status_code=status, detail={"code": err, "message": err})
    return result


@router.delete("/{record_id}")
def discard(record_id: int):
    result = parse_service.discard(record_id)
    if result.get("error"):
        raise HTTPException(status_code=404, detail=result)
    return result
