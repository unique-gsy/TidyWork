"""路由：设置（模型分槽 / 备份 / 健康检查）。

v2 调整：DeepSeek API Key 只配置在 DSH 容器侧（docker-compose 的 dsh 服务
environment，值来自宿主机 docker/.env），TidyWork 不再读写 Key 槽：
- GET /api/settings 不再返回任何密钥相关字段；
- PUT /api/settings 不再接受 api_key（历史表数据保留，但无人读写）。
"""
from fastapi import APIRouter, HTTPException
from zoneinfo import ZoneInfo

from .. import db
from ..schemas import SettingsUpdate

router = APIRouter(prefix="/api", tags=["settings"])


def _slot_view(slot: str) -> dict:
    return {
        "base_url": db.get_setting(f"{slot}.base_url"),
        "model": db.get_setting(f"{slot}.model"),
        "timeout": float(db.get_setting(f"{slot}.timeout", "60")),
    }


@router.get("/settings")
def get_settings():
    return {
        "text": _slot_view("text"),
        "vision": _slot_view("vision"),
        "image_max_size_mb": float(db.get_setting("image.max_size_mb", "10")),
        "timezone": db.get_setting("app.timezone", "Asia/Shanghai"),
    }


def _apply_slot(slot: str, s) -> list[str]:
    applied = []
    if s is None:
        return applied
    if s.base_url is not None:
        url = s.base_url.strip()
        if url and not (url.startswith("http://") or url.startswith("https://")):
            raise HTTPException(400, {
                "code": "bad_url",
                "message": f"{slot} 槽位 base_url 必须以 http:// 或 https:// 开头"})
        db.set_setting(f"{slot}.base_url", url)
        applied.append(f"{slot}.base_url")
    if s.model is not None:
        db.set_setting(f"{slot}.model", s.model.strip())
        applied.append(f"{slot}.model")
    if s.timeout is not None:
        db.set_setting(f"{slot}.timeout", str(s.timeout))
        applied.append(f"{slot}.timeout")
    return applied


@router.put("/settings")
def update_settings(req: SettingsUpdate):
    applied = _apply_slot("text", req.text) + _apply_slot("vision", req.vision)
    if req.image_max_size_mb is not None:
        db.set_setting("image.max_size_mb", str(req.image_max_size_mb))
        applied.append("image.max_size_mb")
    if req.timezone is not None:
        try:
            ZoneInfo(req.timezone)
        except Exception:
            raise HTTPException(400, {
                "code": "bad_timezone",
                "message": "时区标识无效（示例：Asia/Shanghai）"})
        db.set_setting("app.timezone", req.timezone)
        applied.append("app.timezone")
    return {"applied": applied, "settings": get_settings()}
