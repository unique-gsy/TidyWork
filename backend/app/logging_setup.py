"""日志初始化与脱敏（三条硬规则之三：日志永不落 api_key）。"""
import logging
import logging.handlers

from . import config, db


class SecretScrubberFilter(logging.Filter):
    """已配置的 api_key 出现在任何日志中都会被替换为 ****。"""

    def __init__(self):
        super().__init__()
        self._secrets: list[str] = []

    def refresh(self):
        try:
            keys = []
            for slot in ("text", "vision"):
                k = db.get_setting(f"{slot}.api_key")
                if k and len(k) >= 4:
                    keys.append(k)
            self._secrets = keys
        except Exception:  # noqa: BLE001 — 库未就绪时跳过
            self._secrets = []

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        for s in self._secrets:
            if s in msg:
                record.msg = msg.replace(s, "****")
                record.args = None
        return True


scrubber = SecretScrubberFilter()


def setup_logging() -> None:
    log_dir = config.get_data_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    root = logging.getLogger()
    # 数据目录可能变化（测试隔离）：摘除旧的本应用 handler 后重挂
    for h in [h for h in root.handlers
              if isinstance(h, logging.Handler) and any(
                  isinstance(f, SecretScrubberFilter) for f in h.filters)]:
        root.removeHandler(h)
        h.close()
    handler = logging.handlers.RotatingFileHandler(
        log_dir / "app.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.addFilter(scrubber)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    handler.setFormatter(fmt)
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    console.addFilter(scrubber)
    root.addHandler(console)
