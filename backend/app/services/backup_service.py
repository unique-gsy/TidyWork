"""备份服务（架构 4.4 / 7.3）：VACUUM INTO 一致性快照 + images 打包为 zip。"""
import logging
import zipfile
from datetime import datetime
from pathlib import Path

from .. import config, db

logger = logging.getLogger("workbench.backup")


def create_backup() -> dict:
    """POST /api/backup：不锁写在线备份，产物落 data/backups/backup-<时间戳>.zip。"""
    data_dir = config.get_data_dir()
    backup_dir = data_dir / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    snapshot = backup_dir / f".snapshot-{ts}.db"
    target = backup_dir / f"backup-{ts}.zip"

    # 1) VACUUM INTO 产出一致性快照（WAL 下不阻塞读写）
    with db.get_conn() as conn:
        conn.execute("VACUUM INTO ?", (str(snapshot),))

    # 2) 快照 + images/ + VERSION 打包
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(snapshot, "app.db")
        images_dir = data_dir / "images"
        if images_dir.is_dir():
            for p in images_dir.rglob("*"):
                if p.is_file():
                    zf.write(p, p.relative_to(data_dir))
        version_file = data_dir / "VERSION"
        if version_file.exists():
            zf.write(version_file, "VERSION")
    snapshot.unlink(missing_ok=True)

    size = target.stat().st_size
    logger.info("backup created file=%s size=%d", target.name, size)
    return {"file": target.name, "path": str(target), "size": size}
