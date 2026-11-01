"""全局配置：路径、默认设置项。

数据目录与静态资源目录通过环境变量覆盖（Docker 用），默认相对仓库根目录，
支持运行时切换（测试需要独立数据目录）。
"""
import os
from pathlib import Path

APP_VERSION = "0.1.0"
DATA_VERSION = 1

BASE_DIR = Path(__file__).resolve().parents[2]

DEFAULT_SETTINGS = {
    # 文本模型槽位（F1/F2 解析、周报摘要）
    "text.base_url": "",
    "text.api_key": "",
    "text.model": "",
    "text.timeout": "60",  # 读超时（秒）
    # 多模态模型槽位（F4 图片识别）
    "vision.base_url": "",
    "vision.api_key": "",
    "vision.model": "",
    "vision.timeout": "120",
    # 图片上传限制（A4，可调）
    "image.max_size_mb": "10",
    # 应用时区（周报区间与展示）
    "app.timezone": "Asia/Shanghai",
}

ALLOWED_IMAGE_MIMES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def get_data_dir() -> Path:
    """数据目录：env WORKBENCH_DATA 优先，默认 <repo>/data。运行时求值以支持测试隔离。"""
    d = Path(os.environ.get("WORKBENCH_DATA") or (BASE_DIR / "data"))
    return d


def get_static_dir() -> Path | None:
    """前端静态资源目录：env WORKBENCH_STATIC > <repo>/frontend/dist > <repo>/static。"""
    candidates = [
        os.environ.get("WORKBENCH_STATIC"),
        BASE_DIR / "frontend" / "dist",
        BASE_DIR / "static",
    ]
    for c in candidates:
        if c and Path(c).is_dir() and (Path(c) / "index.html").exists():
            return Path(c)
    return None


def retry_delays() -> list[float]:
    """模型调用重试退避间隔（秒）。默认 1,4（架构 3.3）；测试可用 env 缩短。"""
    raw = os.environ.get("WORKBENCH_RETRY_DELAYS", "1,4")
    return [float(x) for x in raw.split(",") if x.strip() != ""]
