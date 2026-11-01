"""SQLite 存储层：连接管理、WAL、schema 迁移、settings 读写。

- 单文件库 app.db，统一 WAL 模式 + busy_timeout；
- 迁移用 PRAGMA user_version 驱动，数据目录带 VERSION 文件（架构 4.3/4.4）；
- settings 键值表承载模型分槽配置等全部可调参数。
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from . import config

MIGRATIONS: list[str] = [
    # v1：初始 schema（7 实体，架构 4.1/4.2）
    """
    CREATE TABLE images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stored_path TEXT NOT NULL,
        original_name TEXT,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE source_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        input_type TEXT NOT NULL,
        raw_text TEXT NOT NULL DEFAULT '',
        image_id INTEGER REFERENCES images(id),
        parse_result_json TEXT,
        destination TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        resolved_at TEXT
    );
    CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        archived_at TEXT
    );
    CREATE TABLE todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        due_date TEXT,
        project_id INTEGER REFERENCES projects(id),
        status TEXT NOT NULL DEFAULT 'open',
        source_record_id INTEGER REFERENCES source_records(id),
        created_at TEXT NOT NULL,
        completed_at TEXT
    );
    CREATE TABLE meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        start_at TEXT,
        participants TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned',
        project_id INTEGER,
        source_record_id INTEGER REFERENCES source_records(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE weekly_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        week_start TEXT NOT NULL UNIQUE,
        week_end TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        edited_since_generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE INDEX idx_todos_project ON todos(project_id);
    CREATE INDEX idx_todos_status ON todos(status);
    CREATE INDEX idx_meetings_start ON meetings(start_at);
    CREATE INDEX idx_source_records_status ON source_records(status);
    """,
]


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def db_path() -> Path:
    return config.get_data_dir() / "app.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def get_conn():
    """每次操作一个连接，事务由 with 块控制。"""
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def set_wal_once() -> None:
    """journal_mode=WAL 是库级持久属性，设置一次即可。"""
    with get_conn() as conn:
        conn.execute("PRAGMA journal_mode = WAL")


def init_db() -> None:
    """初始化数据目录、迁移 schema、写入 VERSION。幂等。"""
    data_dir = config.get_data_dir()
    for sub in ("images", "backups", "logs"):
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    version_file = data_dir / "VERSION"
    if not version_file.exists():
        version_file.write_text(f"{config.DATA_VERSION}\n", encoding="utf-8")

    set_wal_once()
    with get_conn() as conn:
        current = conn.execute("PRAGMA user_version").fetchone()[0]
        for i, sql in enumerate(MIGRATIONS, start=1):
            if current < i:
                conn.executescript(sql)
                conn.execute(f"PRAGMA user_version = {i}")
        # 默认设置项（不覆盖已有值）
        for k, v in config.DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO NOTHING",
                (k, v),
            )


def integrity_check() -> bool:
    with get_conn() as conn:
        row = conn.execute("PRAGMA integrity_check").fetchone()
        return row[0] == "ok"


# ---------- settings ----------

def get_setting(key: str, default: str = "") -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def get_all_settings() -> dict[str, str]:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
        return {r["key"]: r["value"] for r in rows}
