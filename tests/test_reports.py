"""F3 · 周报生成（数据事实与模型生成分离 / 空数据不调模型 / 覆盖保护 / 导出）。"""
import httpx


def _seed_week_data(client, mock_base_url):
    """造数：2 个项目共 3 条已完成、2 条未完成（1 逾期）、2 场会议（1 待补全）。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    pa = client.post("/api/projects", json={"name": "A项目"}).json()["id"]
    pb = client.post("/api/projects", json={"name": "B项目"}).json()["id"]
    for content, pid in (("A-合同初稿", pa), ("A-法务意见", pa), ("B-评审材料", pb)):
        t = client.post("/api/todos", json={"content": content, "project_id": pid}).json()
        client.patch(f"/api/todos/{t['id']}", json={"status": "done"})
    client.post("/api/todos", json={"content": "A-下阶段计划", "project_id": pa,
                                    "due_date": "2026-09-25"})
    client.post("/api/todos", json={"content": "B-逾期事项", "project_id": pb,
                                    "due_date": "2026-09-10"})
    # 本周一场确定时间会议 + 一场待补全会议
    d = client.post("/api/parse", json={"text": "明天上午10点站会"}).json()
    client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "meeting",
        "meeting": {"title": "站会", "start_at": d["parse"]["meeting"]["start_at"],
                    "participants": "风控组"},
    })
    d = client.post("/api/parse", json={"text": "下周找时间和李总碰一下"}).json()
    client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "meeting", "meeting": {"title": "和李总碰一下"}})


def _mock_request_count(mock_base_url) -> int:
    stats = httpx.get(mock_base_url.replace("/v1", "/stats"), timeout=5).json()
    return stats["count"]


def test_generate_report_with_data(client, mock_base_url):
    _seed_week_data(client, mock_base_url)
    # 造数用 mock-text（解析），摘要生成切到 mock-summary
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-summary"}})
    before = _mock_request_count(mock_base_url)
    r = client.post("/api/reports/generate", json={})
    assert r.status_code == 200, r.text
    rep = r.json()
    assert rep["status"] == "draft" and rep["has_data"] is True
    md = rep["content_markdown"]
    assert "本周完成" in md and "进行中" in md and "本周会议" in md
    assert "A-合同初稿" in md          # 完成事项来自落库数据
    assert "已逾期" in md              # 逾期标注
    assert "时间待补全" in md          # A11：待补全会议列入并标注
    assert "概览" in md               # 摘要区块存在
    assert "整体进展顺利" in md        # 摘要内容由模型生成（mock-summary）
    # 摘要调用走 text 槽 → mock 请求数 +1
    assert _mock_request_count(mock_base_url) == before + 1


def test_empty_week_no_model_call_no_fabrication(client, mock_base_url):
    """空数据：占位草稿，不调用模型，不出现虚构内容。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    before = _mock_request_count(mock_base_url)
    r = client.post("/api/reports/generate", json={})
    assert r.status_code == 200
    rep = r.json()
    assert rep["has_data"] is False
    assert "本周暂无记录" in rep["content_markdown"]
    assert _mock_request_count(mock_base_url) == before  # 未调用模型


def test_overwrite_protection_and_force(client, mock_base_url):
    _seed_week_data(client, mock_base_url)
    rep = client.post("/api/reports/generate", json={}).json()
    # 编辑草稿 → 再次生成需二次确认（接口层 = force 标记）
    r = client.patch(f"/api/reports/{rep['id']}",
                     json={"content_markdown": rep["content_markdown"] + "\n手动补充一段。"})
    assert r.status_code == 200
    r = client.post("/api/reports/generate", json={})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "overwrite_confirm"
    # 取消（不 force）→ 原草稿不变
    r = client.post("/api/reports/generate", json={"force": False})
    assert r.status_code == 409
    cur = client.get(f"/api/reports/{rep['id']}").json()
    assert "手动补充一段。" in cur["content_markdown"]
    # 确认覆盖 → 重新生成（含摘要重新产出，A13）
    r = client.post("/api/reports/generate", json={"force": True})
    assert r.status_code == 200
    cur = client.get(f"/api/reports/{rep['id']}").json()
    assert "手动补充一段。" not in cur["content_markdown"]


def test_finalize_then_edit_as_revision(client, mock_base_url):
    _seed_week_data(client, mock_base_url)
    rep = client.post("/api/reports/generate", json={}).json()
    r = client.patch(f"/api/reports/{rep['id']}", json={"status": "finalized"})
    assert r.json()["status"] == "finalized"
    # 已定稿：再次生成被拒，定稿不受影响
    r = client.post("/api/reports/generate", json={"force": True})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "finalized"
    # 定稿后仍可再编辑（记为修订）
    r = client.patch(f"/api/reports/{rep['id']}",
                     json={"content_markdown": "# 修订后的周报\n"})
    assert r.status_code == 200
    assert client.get(f"/api/reports/{rep['id']}").json()["content_markdown"].startswith("# 修订后的周报")


def test_export_markdown(client, mock_base_url):
    _seed_week_data(client, mock_base_url)
    rep = client.post("/api/reports/generate", json={}).json()
    r = client.get(f"/api/reports/{rep['id']}/export")
    assert r.status_code == 200
    assert "text/markdown" in r.headers["content-type"]
    assert "attachment" in r.headers["content-disposition"]
    assert r.text == client.get(f"/api/reports/{rep['id']}").json()["content_markdown"]


def test_week_range_monday_to_sunday(client, mock_base_url):
    """A1：周一 00:00 至周日 24:00；传入周三自动校正为所在周周一。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    from app import timex
    this_monday = timex.last_monday(timex.now_local().date()).isoformat()
    wednesday_shift = "2026-09-16" if this_monday == "2026-09-14" else this_monday
    r = client.post("/api/reports/generate", json={"week_start": wednesday_shift})
    assert r.status_code == 200
    rep = r.json()
    assert rep["week_start"] == this_monday
    # 上周无数据 → 占位
    last_week = (timex.now_local().date().fromisoformat(this_monday)
                 - __import__("datetime").timedelta(days=7)).isoformat()
    r = client.post("/api/reports/generate", json={"week_start": last_week})
    assert r.status_code == 200 and "本周暂无记录" in r.json()["content_markdown"]


def test_summary_failure_degrades_in_draft(client, mock_base_url):
    """摘要模型失败：结构化区块照常产出，摘要段明确标注失败可重试。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-500"}})
    t = client.post("/api/todos", json={"content": "本周做了一件事"}).json()
    client.patch(f"/api/todos/{t['id']}", json={"status": "done"})
    r = client.post("/api/reports/generate", json={})
    assert r.status_code == 200
    rep = r.json()
    assert rep["has_data"] is True
    assert "本周做了一件事" in rep["content_markdown"]
    assert "摘要生成失败" in rep["content_markdown"]
    assert rep["summary_note"] == "server_error"
