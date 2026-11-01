"""路由：图片上传与识别（F4，架构 6.2）。"""
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..services import image_service

router = APIRouter(prefix="/api/images", tags=["images"])


@router.post("")
async def upload(file: UploadFile = File(...), note: str = Form("")):
    content = await file.read()
    result = image_service.upload(content, file.filename or "", file.content_type or "", note)
    if "error" in result:
        err = result["error"]
        status = 400 if err["code"] in ("unsupported_type", "too_large") else 500
        raise HTTPException(status_code=status, detail=err)
    return result


@router.get("")
def list_images():
    return image_service.list_images()


@router.get("/{image_id}")
def image_detail(image_id: int):
    d = image_service.get_image_detail(image_id)
    if not d:
        raise HTTPException(404, {"code": "not_found", "message": "图片不存在"})
    return d


@router.get("/{image_id}/file")
def image_file(image_id: int):
    p = image_service.get_image_file(image_id)
    if not p:
        raise HTTPException(404, {"code": "not_found", "message": "图片文件不存在"})
    with open(p, "rb") as f:
        head = f.read(16)
    mime = "image/png" if head.startswith(b"\x89PNG") else (
        "image/jpeg" if head.startswith(b"\xff\xd8\xff") else "image/webp")
    return FileResponse(p, media_type=mime)


@router.post("/{image_id}/recognize")
def recognize(image_id: int, note: str = ""):
    result = image_service.recognize(image_id, note)
    if "error" in result:
        err = result["error"]
        # 分类映射：未配置 400；不支持图片输入 422（指引设置页）；其余上游失败 502
        status = {"not_configured": 400, "vision_unsupported": 422}.get(err.get("category"), 502)
        raise HTTPException(status_code=status, detail=err)
    return result


# 图片识别结果的确认复用 /api/parse/{id} 的 PUT / confirm / DELETE（架构 5.3 要点 4）
