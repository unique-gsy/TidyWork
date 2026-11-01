"""pytest 配置：路径、mock OpenAI 服务、每测试独立数据目录的 TestClient。"""
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

WORKBENCH_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKBENCH_ROOT / "backend"))
sys.path.insert(0, str(WORKBENCH_ROOT))


@pytest.fixture(scope="session")
def mock_base_url():
    """在随机端口起 mock OpenAI 兼容服务（真实 HTTP，覆盖 SDK 全链路）。"""
    import uvicorn
    from tests.mock_openai import app as mock_app, REQUESTS

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = uvicorn.Server(uvicorn.Config(mock_app, host="127.0.0.1", port=port,
                                           log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(100):
        try:
            httpx.get(f"http://127.0.0.1:{port}/health", timeout=0.5)
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.1)
    else:
        raise RuntimeError("mock server failed to start")
    REQUESTS.clear()
    yield f"http://127.0.0.1:{port}/v1"
    REQUESTS.clear()


@pytest.fixture
def client(tmp_path, monkeypatch):
    """每个测试独立数据目录 + 缩短重试退避。"""
    monkeypatch.setenv("WORKBENCH_DATA", str(tmp_path / "data"))
    monkeypatch.setenv("WORKBENCH_RETRY_DELAYS", "0.05,0.05")
    from app.main import create_app
    app = create_app()
    from fastapi.testclient import TestClient
    with TestClient(app) as c:
        yield c


def configure_models(client, base_url, text_model="mock-text", vision_model="mock-vision",
                     api_key="sk-test-secret-9876"):
    r = client.put("/api/settings", json={
        "text": {"base_url": base_url, "api_key": api_key, "model": text_model},
        "vision": {"base_url": base_url, "api_key": api_key, "model": vision_model},
    })
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def data_dir():
    """当前测试的数据目录（由 client fixture 设置 env 决定）。"""
    import os
    return Path(os.environ["WORKBENCH_DATA"])
