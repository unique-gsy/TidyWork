"""路由：设置（模型分槽配置 / 密钥脱敏 / 测试连接）+ 备份 + 健康检查。

三条硬规则（架构 3.2）：
1. GET /api/settings 永不返回明文密钥，只返回 ****+末4位；
2. PUT /api/settings 的 api_key 留空 = 保持不变；
3. 日志与错误信息不落 api_key（logging 脱敏过滤器见 main.py）。
"""
from fastapi import APIRouter, HTTPException
from zoneinfo import ZoneInfo

from .. import db, llm
from ..logging_setup import scrubber
from ..schemas import SettingsTestRequest, SettingsUpdate

router = APIRouter(prefix="/api", tags=["settings"])


def _slot_view(slot: str) -> dict:
    base = db.get_setting(f"{slot}.base_url")
    key = db.get_setting(f"{slot}.api_key")
    return {
        "base_url": base,
        "api_key_masked": llm.mask_key(key),
        "api_key_set": bool(key),
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
    # 硬规则 2：api_key 留空/None = 保持不变；只有非空才更新
    if s.api_key:
        db.set_setting(f"{slot}.api_key", s.api_key)
        applied.append(f"{slot}.api_key")
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
    # 密钥可能已更新：刷新日志脱敏清单（硬规则 3）
    scrubber.refresh()
    # 更新后回读脱敏视图（硬规则 1：任何回显不含明文）
    return {"applied": applied, "settings": get_settings()}


@router.post("/settings/test")
def test_settings(req: SettingsTestRequest):
    return [llm.test_slot(s) for s in req.slots]
