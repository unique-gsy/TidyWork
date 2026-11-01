"""F4 · 图片上传识别链路：校验、存图/识别解耦、降级、原文保留；附备份链路。"""
import sqlite3
import struct
import tempfile
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
    + struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    + b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _png(extra_kb=1):
    # 合法 PNG 头 + 填充（魔数嗅探够用，识别内容走 mock）
    return PNG_1PX + b"\x00" * (extra_kb * 1024)


def _upload(client, content=None, filename="board.png", note="会议白板照片"):
    return client.post(
        "/api/images",
        files={"file": (filename, content or _png(), "image/png")},
        data={"note": note},
    )


def _configure(client, base_url, vision_model):
    from tests.conftest import configure_models

    configure_models(client, base_url, vision_model=vision_model)


def test_upload_store_and_review(client):
    """存图与识别解耦：上传即落盘登记，可在记录里回看。"""
    r = _upload(client, note="白板待办")
    assert r.status_code == 200
    d = r.json()
    assert d["mime"] == "image/png"
    assert d["size"] > 0
    listing = client.get("/api/images").json()
    assert any(i["id"] == d["image_id"] for i in listing)
    assert any(i["note"] == "白板待办" for i in listing)
    detail = client.get(f"/api/images/{d['image_id']}").json()
    assert detail["records"][0]["raw_text"] == "白板待办"
    assert detail["records"][0]["status"] == "pending"
    # 文件可访问
    f = client.get(f"/api/images/{d['image_id']}/file")
    assert f.status_code == 200
    assert f.headers["content-type"].startswith("image/")


def test_upload_rejects_disallowed_format(client):
    """A4：仅 PNG/JPG/WebP；魔数校验，不信任声明的 content-type。"""
    r = _upload(client, content=b"%PDF-1.4 fake pdf bytes", filename="a.pdf")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "unsupported_type"
    # 声明 png 但实际是文本 → 同样拒绝
    r2 = client.post(
        "/api/images",
        files={"file": ("fake.png", b"plain text not an image", "image/png")},
        data={"note": ""},
    )
    assert r2.status_code == 400


def test_upload_rejects_oversize(client):
    """A4：单张 ≤10MB。"""
    big = PNG_1PX + b"\x00" * (10 * 1024 * 1024 + 1)
    r = _upload(client, content=big, filename="big.png")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "too_large"
    # 恰好 10MB 通过
    ok = PNG_1PX + b"\x00" * (10 * 1024 * 1024 - len(PNG_1PX))
    r2 = _upload(client, content=ok, filename="edge.png")
    assert r2.status_code == 200


def test_upload_dedup_by_sha(client, data_dir):
    content = _png(2)
    r1 = _upload(client, content=content, filename="a.png")
    r2 = _upload(client, content=content, filename="b.png", note="同一张图")
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["sha256"] if "sha256" in r1.json() else True
    detail1 = client.get(f"/api/images/{r1.json()['image_id']}").json()
    detail2 = client.get(f"/api/images/{r2.json()['image_id']}").json()
    assert detail1["sha256"] == detail2["sha256"]
    assert detail1["stored_path"] == detail2["stored_path"]


def test_recognize_success_and_confirm_todo(client, mock_base_url):
    """识别成功 → 识别文本 + 建议解析 → 走统一确认通道落库为待办。"""
    _configure(client, mock_base_url, "mock-vision")
    up = _upload(client, note="白板照片")
    img_id = up.json()["image_id"]
    record_id = up.json()["source_record_id"]
    r = client.post(f"/api/images/{img_id}/recognize")
    assert r.status_code == 200
    d = r.json()
    assert d["source_record_id"] == record_id
    assert "完成季度评审材料" in d["recognized_text"]
    assert d["suggested"]["intent"] == "todo"
    assert d["suggested"]["todo"]["content"] == "完成季度评审材料"
    assert "due_date" in d["suggested"]["todo"]["missing"]  # 缺失字段标注待补
    # 复用 /api/parse/{id}/confirm 确认落库
    rr = client.post(f"/api/parse/{record_id}/confirm", json={
        "destination": "todo",
        "todo": {"content": d["suggested"]["todo"]["content"]},
    })
    assert rr.status_code == 200
    todos = client.get("/api/todos").json()
    assert any(t["content"] == "完成季度评审材料" for t in todos)
    detail = client.get(f"/api/images/{img_id}").json()
    assert detail["records"][0]["status"] == "confirmed"
    assert detail["records"][0]["destination"] == "todo"


def test_recognize_note_only_archive(client, mock_base_url):
    """识别后选择仅存档：不生成结构化数据，记录可回看。"""
    _configure(client, mock_base_url, "mock-vision")
    up = _upload(client, note="随手记")
    img_id, record_id = up.json()["image_id"], up.json()["source_record_id"]
    client.post(f"/api/images/{img_id}/recognize")
    rr = client.post(f"/api/parse/{record_id}/confirm", json={"destination": "note"})
    assert rr.status_code == 200
    detail = client.get(f"/api/images/{img_id}").json()
    assert detail["records"][0]["status"] == "confirmed"
    assert detail["records"][0]["destination"] == "note"
    # 没有产生待办/会议
    assert client.get("/api/todos").json() == []
    assert client.get("/api/meetings").json() == []


def test_recognize_vision_unsupported_degrades(client, mock_base_url):
    """多模态不可用：422 + 明确指引，原图保留可重试，文本功能不受影响。"""
    _configure(client, mock_base_url, "mock-unsupported-vision")
    up = _upload(client, note="x")
    img_id = up.json()["image_id"]
    r = client.post(f"/api/images/{img_id}/recognize")
    assert r.status_code == 422
    err = r.json()["detail"]
    assert err["category"] == "vision_unsupported"
    assert "设置" in err["message"] or "模型" in err["message"]
    # 原图保留（存图与识别解耦）
    f = client.get(f"/api/images/{img_id}/file")
    assert f.status_code == 200
    # 文本槽不受影响
    rr = client.post("/api/parse", json={"text": "明天上午10点站会"})
    assert rr.status_code == 200
    assert rr.json()["fallback"] is False


def test_recognize_not_configured_shows_hint(client):
    up = _upload(client)
    r = client.post(f"/api/images/{up.json()['image_id']}/recognize")
    assert r.status_code == 400
    err = r.json()["detail"]
    assert err["category"] == "not_configured"
    assert "设置" in err["message"]


def test_recognize_upstream_error_keeps_image(client, mock_base_url):
    """上游 5xx：502 分类返回，图片与记录仍保留。"""
    _configure(client, mock_base_url, "mock-500")
    up = _upload(client)
    img_id = up.json()["image_id"]
    r = client.post(f"/api/images/{img_id}/recognize")
    assert r.status_code == 502
    assert r.json()["detail"]["category"] == "server_error"
    assert client.get(f"/api/images/{img_id}/file").status_code == 200


def test_backup_and_restore_drill(client, data_dir):
    """备份：VACUUM INTO 快照 + images 打包；解压可读、数据完整。"""
    r = client.post("/api/projects", json={"name": "备份验证项目"})
    assert r.status_code == 200
    up = _upload(client, note="备份前上传的图")
    r = client.post("/api/backup")
    assert r.status_code == 200
    d = r.json()
    assert d["file"].startswith("backup-") and d["file"].endswith(".zip")
    assert d["size"] > 0
    assert Path(d["path"]).exists()
    assert str(data_dir) in d["path"]

    with zipfile.ZipFile(d["path"]) as zf:
        names = zf.namelist()
        assert "app.db" in names and "VERSION" in names
        assert any(n.startswith("images/") for n in names)
        with tempfile.TemporaryDirectory() as td:
            zf.extract("app.db", td)
            con = sqlite3.connect(str(Path(td) / "app.db"))
            rows = con.execute("SELECT name FROM projects").fetchall()
            assert ("备份验证项目",) in rows
            con.close()
