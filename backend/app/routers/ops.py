"""路由：备份 + 健康检查。"""
from fastapi import APIRouter

from .. import config, db
from ..services import backup_service

router = APIRouter(prefix="/api", tags=["ops"])


@router.post("/backup")
def backup():
    return backup_service.create_backup()


@router.get("/health")
def health():
    db_ok = db.integrity_check()
    return {
        "status": "ok" if db_ok else "degraded",
        "db": "ok" if db_ok else "integrity_check_failed",
        "version": config.APP_VERSION,
        "timezone": db.get_setting("app.timezone", "Asia/Shanghai"),
    }
