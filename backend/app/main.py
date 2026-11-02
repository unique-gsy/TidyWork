"""应用入口：日志（脱敏）→ 数据库初始化与完整性自检 → 路由 → 静态托管。"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import config, db
from .logging_setup import scrubber, setup_logging
from .routers import agent, dsh_proxy, ops, settings

APP_TITLE = "个人工作台"


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    db.init_db()
    scrubber.refresh()
    ok = db.integrity_check()
    logging.getLogger("workbench").info(
        "startup version=%s db_integrity=%s data_dir=%s",
        config.APP_VERSION, "ok" if ok else "FAILED", config.get_data_dir())
    if not ok:
        logging.getLogger("workbench").error(
            "数据库完整性自检失败：请从 data/backups/ 恢复备份（拷贝 zip 内 app.db 与 images/ 回 data/）")
    yield


def create_app() -> FastAPI:
    app = FastAPI(title=APP_TITLE, version=config.APP_VERSION, lifespan=lifespan)
    # 纯本地工具：方寸.html 以 file:// 或 localhost 静态页打开，允许任意源跨域调用本后端
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(settings.router)
    app.include_router(ops.router)
    app.include_router(agent.router)
    app.include_router(dsh_proxy.router)

    static_dir = config.get_static_dir()
    if static_dir is not None:
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
    return app


app = create_app()
