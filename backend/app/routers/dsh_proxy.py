"""路由：/dsh/* 反向代理到 DSH Web（3080）。

- HTTP：入口 HTML 注入「切回方寸」脚本；raw_query 原样透传（含 `??` 特殊字符）。
- WebSocket：DSH 前端经 `/api/remote.mux` 与 Host 保持实时通道（会话/流式响应），
  必须双向转发；握手时带 dsh-auth cookie，并把 Host/Origin 改写为 loopback，
  通过 DSH 的浏览器请求信任校验（Host/Origin 非 loopback 会被 403）。
"""
import asyncio
import logging
import os

import websockets
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from ..services import dsh_web

logger = logging.getLogger("workbench.dshproxy")
router = APIRouter(prefix="/dsh", tags=["dsh-web"])

_PASS_HEADERS = ("content-type", "accept", "accept-language", "origin", "referer", "user-agent")
# 容器化部署时经环境变量指向 DSH 服务名（DSH_WEB_BASE=http://dsh:3080 的 ws 变体）；
# 默认值保持本地 TidyWork（127.0.0.1:3080）行为不变
_WS_UPSTREAM = os.environ.get("DSH_WS_BASE", "ws://127.0.0.1:3080")
_WS_EXTRA_HEADERS = {
    "Host": os.environ.get("DSH_WS_HOST", "127.0.0.1:3080"),
    "Origin": os.environ.get("DSH_ORIGIN", "http://127.0.0.1:3080/"),
}


@router.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def dsh_proxy(request: Request, path: str):
    raw_query = request.url.query  # 原始 query 字符串（含 ?? 等特殊字符，不可 dict 重编码）
    body = await request.body() if request.method not in ("GET", "OPTIONS") else None
    headers = {k: v for k, v in request.headers.items() if k.lower() in _PASS_HEADERS}
    # 覆盖浏览器 Origin，通过 DSH 信任栅栏（外域 Origin 一律 403）；容器内为 http://dsh:3080/
    headers["Origin"] = os.environ.get("DSH_ORIGIN", "http://127.0.0.1:3080/")
    status, hdrs, out = await dsh_web.proxy(path, request.method, raw_query, body, headers)
    return Response(content=out, status_code=status, headers=hdrs)


@router.websocket("/{path:path}")
async def dsh_ws(websocket: WebSocket, path: str):
    await websocket.accept()
    try:
        await dsh_web.ensure_auth()
    except Exception as exc:  # noqa: BLE001
        logger.warning("dsh ws auth failed path=%s err=%s", path, exc)
        await websocket.close(code=1011)
        return
    qs = websocket.url.query  # FastAPI WebSocket 无 query_string 属性，用 url.query
    url = f"{_WS_UPSTREAM}/{path}" + (f"?{qs}" if qs else "")
    try:
        headers = dict(_WS_EXTRA_HEADERS)
        headers["Cookie"] = dsh_web.auth_cookie_header()
        async with websockets.connect(url, additional_headers=headers, open_timeout=10) as up:

            async def pump() -> None:
                try:
                    while True:
                        msg = await websocket.receive()
                        t = msg.get("type")
                        if t == "websocket.receive":
                            if msg.get("text") is not None:
                                await up.send(msg["text"])
                            elif msg.get("bytes") is not None:
                                await up.send(msg["bytes"])
                        elif t == "websocket.disconnect":
                            break
                except Exception:  # noqa: BLE001
                    pass
                finally:
                    try:
                        await up.close()
                    except Exception:  # noqa: BLE001
                        pass

            task = asyncio.create_task(pump())
            try:
                async for msg in up:
                    if isinstance(msg, str):
                        await websocket.send_text(msg)
                    else:
                        await websocket.send_bytes(msg)
            except WebSocketDisconnect:
                pass
            finally:
                task.cancel()
                try:
                    await task
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("dsh ws proxy failed path=%s err=%s", path, exc)
        try:
            await websocket.close(code=1011)
        except Exception:  # noqa: BLE001
            pass
