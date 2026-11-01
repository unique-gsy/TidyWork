"""图片服务（架构 5.3）：存图与识别解耦，识别失败不丢原图。"""
import base64
import hashlib
import json
import logging
import shutil
from pathlib import Path

from .. import config, db, llm
from ..schemas import RecognitionOutput

logger = logging.getLogger("workbench.image")


def _sniff_mime(data: bytes) -> str | None:
    """按魔数判定（不信任客户端 content_type）。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def upload(file_bytes: bytes, original_name: str, declared_mime: str, note: str) -> dict:
    """POST /api/images：校验 → 落盘 → 登记 images → 建 pending source_record。"""
    mime = _sniff_mime(file_bytes)
    if mime not in config.ALLOWED_IMAGE_MIMES:
        return {"error": {
            "code": "unsupported_type",
            "message": "仅支持 PNG / JPG / WebP 图片",
        }}
    max_mb = float(db.get_setting("image.max_size_mb", "10"))
    if len(file_bytes) > max_mb * 1024 * 1024:
        return {"error": {
            "code": "too_large",
            "message": f"图片超过大小上限 {max_mb}MB（可在设置页调整）",
        }}

    sha = hashlib.sha256(file_bytes).hexdigest()
    ext = config.ALLOWED_IMAGE_MIMES[mime]
    now = db.utcnow_iso()
    sub_dir = Path("images") / now[:4] / now[5:7]
    stored = sub_dir / f"{sha}{ext}"
    abs_dir = config.get_data_dir() / sub_dir
    abs_dir.mkdir(parents=True, exist_ok=True)
    abs_path = config.get_data_dir() / stored
    if not abs_path.exists():  # SHA256 去重
        abs_path.write_bytes(file_bytes)

    with db.get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO images(stored_path, original_name, mime, size, sha256, created_at) "
            "VALUES(?,?,?,?,?,?)",
            (str(stored), original_name, mime, len(file_bytes), sha, now),
        )
        image_id = cur.lastrowid
        cur = conn.execute(
            "INSERT INTO source_records(input_type, raw_text, image_id, status, created_at) "
            "VALUES('image', ?, ?, 'pending', ?)",
            (note, image_id, now),
        )
        record_id = cur.lastrowid
    return {
        "image_id": image_id,
        "source_record_id": record_id,
        "mime": mime,
        "size": len(file_bytes),
        "url": f"/api/images/{image_id}/file",
    }


def get_image_file(image_id: int) -> Path | None:
    with db.get_conn() as conn:
        row = conn.execute("SELECT stored_path FROM images WHERE id = ?", (image_id,)).fetchone()
    if not row:
        return None
    p = config.get_data_dir() / row["stored_path"]
    return p if p.exists() else None


def get_image_detail(image_id: int) -> dict | None:
    """GET /api/images/{id}：元数据 + 关联 source_records（识别文本与状态）。"""
    with db.get_conn() as conn:
        img = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        if not img:
            return None
        records = conn.execute(
            "SELECT id, raw_text, parse_result_json, destination, status, created_at, resolved_at "
            "FROM source_records WHERE image_id = ? ORDER BY id DESC",
            (image_id,),
        ).fetchall()
    out = dict(img)
    out["url"] = f"/api/images/{image_id}/file"
    out["records"] = []
    for r in records:
        rec = dict(r)
        if rec["parse_result_json"]:
            rec["parse"] = json.loads(rec["parse_result_json"])
        rec.pop("parse_result_json", None)
        out["records"].append(rec)
    return out


def list_images() -> list[dict]:
    """图片识别记录列表（A14：统一回看，不设独立检索）。"""
    with db.get_conn() as conn:
        rows = conn.execute(
            "SELECT i.id, i.original_name, i.mime, i.size, i.created_at, "
            "sr.id AS source_record_id, sr.status AS record_status, sr.destination, "
            "sr.raw_text AS note, sr.parse_result_json "
            "FROM images i LEFT JOIN source_records sr ON sr.image_id = i.id "
            "ORDER BY i.id DESC"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        recognized = ""
        if d.pop("parse_result_json", None):
            try:
                parsed = json.loads(r["parse_result_json"])
                recognized = parsed.get("recognized_text", "")[:200]
            except Exception:  # noqa: BLE001
                pass
        d["recognized_preview"] = recognized
        d["url"] = f"/api/images/{r['id']}/file"
        out.append(d)
    return out


def recognize(image_id: int, note: str) -> dict:
    """POST /api/images/{id}/recognize：多模态识别；错误分类降级，原图保留。"""
    with db.get_conn() as conn:
        img = conn.execute("SELECT * FROM images WHERE id = ?", (image_id,)).fetchone()
        record = conn.execute(
            "SELECT * FROM source_records WHERE image_id = ? AND status = 'pending' "
            "ORDER BY id DESC LIMIT 1",
            (image_id,),
        ).fetchone()
    if not img:
        return {"error": {"code": "not_found", "message": "图片不存在"}}
    path = config.get_data_dir() / img["stored_path"]
    if not path.exists():
        return {"error": {"code": "file_missing", "message": "图片文件缺失（数据目录可能不完整）"}}
    record_id = record["id"] if record else None

    try:
        b64 = base64.b64encode(path.read_bytes()).decode()
        result: RecognitionOutput = llm.recognize_image(b64, img["mime"], note)
    except llm.LLMError as e:
        # 降级显式：不静默失败；原图已保存，可换模型重试（F4）
        logger.warning("recognize failed image=%s category=%s", image_id, e.category)
        return {"error": {**llm.error_payload(e), "image_preserved": True}}

    payload = {
        "recognized_text": result.recognized_text,
        "suggested": result.suggested.model_dump(),
    }
    if record_id:
        with db.get_conn() as conn:
            if note:
                conn.execute(
                    "UPDATE source_records SET parse_result_json = ?, raw_text = ? WHERE id = ?",
                    (json.dumps(payload, ensure_ascii=False), note, record_id),
                )
            else:
                conn.execute(
                    "UPDATE source_records SET parse_result_json = ? WHERE id = ?",
                    (json.dumps(payload, ensure_ascii=False), record_id),
                )
    return {
        "source_record_id": record_id,
        "recognized_text": result.recognized_text,
        "suggested": result.suggested.model_dump(),
    }
