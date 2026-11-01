"""F1/F2 · 自然语言解析与确认落库（架构 5.1）。"""
from datetime import datetime, timedelta


def test_parse_relative_time_echo_absolute(client, mock_base_url):
    """相对时间回显绝对时间：输入「明天上午10点站会」→ 卡片回显明天 10:00。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    r = client.post("/api/parse", json={"text": "明天上午10点站会"})
    assert r.status_code == 200
    d = r.json()
    assert d["fallback"] is False
    assert d["parse"]["intent"] == "meeting"
    start = d["parse"]["meeting"]["start_at"]
    tomorrow = datetime.now() + timedelta(days=1)
    assert start == f"{tomorrow.strftime('%Y-%m-%d')}T10:00:00"
    # source_record 先落库、原文保留
    assert d["raw_text"] == "明天上午10点站会"
    assert d["source_record_id"] >= 1


def test_confirm_meeting_lands_in_list(client, mock_base_url):
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "明天上午10点站会"}).json()
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "meeting",
        "meeting": {"title": "站会", "start_at": d["parse"]["meeting"]["start_at"]},
    })
    assert r.status_code == 200
    assert r.json()["status"] == "planned"
    meetings = client.get("/api/meetings").json()
    assert len(meetings) == 1
    assert meetings[0]["title"] == "站会"
    assert meetings[0]["status"] == "planned"


def test_time_ambiguous_pending_completion(client, mock_base_url):
    """时间歧义：不能落库为有确定时间的会议 → 状态待补全。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "下周找时间和李总碰一下"}).json()
    assert d["parse"]["meeting"]["start_at"] is None
    assert "start_at" in d["parse"]["meeting"]["missing"]
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "meeting",
        "meeting": {"title": "和李总碰一下", "start_at": None, "participants": "李总"},
    })
    assert r.status_code == 200
    meetings = client.get("/api/meetings").json()
    assert meetings[0]["status"] == "pending_completion"
    assert meetings[0]["start_at"] is None
    # 补全时间后状态自动转待开
    mid = meetings[0]["id"]
    client.patch(f"/api/meetings/{mid}", json={"start_at": "2026-09-21T15:00:00"})
    m = client.get("/api/meetings").json()[0]
    assert m["status"] == "planned" and m["start_at"] == "2026-09-21T15:00:00"


def test_mixed_intent_switch_to_todo(client, mock_base_url):
    """混合意图：卡片提供存为会议/待办切换（默认建议项），用户可改选待办。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "周三开会讨论B项目，记得提前发材料"}).json()
    assert d["parse"]["intent"] == "mixed"
    assert d["parse"]["suggested_destination"] == "meeting"
    # 用户切换为待办确认
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo",
        "todo": {"content": "提前发B项目材料"},
    })
    assert r.status_code == 200
    todos = client.get("/api/todos").json()
    assert len(todos) == 1 and todos[0]["content"] == "提前发B项目材料"


def test_multiple_items_split_prompt_first(client, mock_base_url):
    """A12：先提示拆分，确认为单事项后再进入切换。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "订下季度评审的会议室以及发周报"}).json()
    assert d["parse"]["multiple_items"] is True
    assert "拆" in d["parse"]["split_hint"]


def test_todo_with_named_project_and_due(client, mock_base_url):
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    client.post("/api/projects", json={"name": "A项目"})
    d = client.post("/api/parse", json={"text": "跟进A项目合同初稿，周五前给对方"}).json()
    assert d["parse"]["todo"]["project_name"] == "A项目"
    assert d["parse"]["todo"]["due_date"] is not None
    projects = client.get("/api/projects?status=active").json()
    pid = projects[0]["id"]
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo",
        "todo": {"content": "跟进A项目合同初稿", "due_date": d["parse"]["todo"]["due_date"],
                 "project_id": pid},
    })
    assert r.status_code == 200
    t = client.get("/api/todos").json()[0]
    assert t["project_name"] == "A项目" and t["due_date"]


def test_unnamed_project_requires_user_choice(client, mock_base_url):
    """未点名项目：不自动猜测，候选由用户在卡片选择（前端呈现，接口不强制归属）。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "订下季度评审的会议室"}).json()
    assert d["parse"]["todo"]["project_name"] is None
    # 确认时不带 project_id → 未归属，留待补
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo", "todo": {"content": "订下季度评审的会议室"}})
    assert r.status_code == 200
    t = client.get("/api/todos").json()[0]
    assert t["project_id"] is None and t["project_name"] is None


def test_confirm_archived_project_rejected(client, mock_base_url):
    """点名已归档项目 → 提示恢复或改选（409）。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    r = client.post("/api/projects", json={"name": "C项目"})
    pid = r.json()["id"]
    client.patch(f"/api/projects/{pid}", json={"status": "archived"})
    d = client.post("/api/parse", json={"text": "跟进C项目的事"}).json()
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo", "todo": {"content": "跟进C项目的事", "project_id": pid}})
    assert r.status_code == 409
    assert "归档" in r.json()["detail"]["message"]
    # 恢复后可确认
    client.patch(f"/api/projects/{pid}", json={"status": "active"})
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo", "todo": {"content": "跟进C项目的事", "project_id": pid}})
    assert r.status_code == 200


def test_create_project_inline_in_confirm(client, mock_base_url):
    """确认卡片直接新建项目归属。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "写D项目的立项材料"}).json()
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo",
        "todo": {"content": "写D项目的立项材料", "new_project_name": "D项目"}})
    assert r.status_code == 200
    t = client.get("/api/todos").json()[0]
    assert t["project_name"] == "D项目"


def test_model_failure_fallback_preserves_raw(client, mock_base_url):
    """解析失败兜底：原文完整保留为待办内容，字段留空待补，不丢输入。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-500"}})
    raw = "一句会触发服务端错误的输入"
    d = client.post("/api/parse", json={"text": raw}).json()
    assert d["fallback"] is True
    assert d["error"]["category"] == "server_error"
    assert d["parse"]["todo"]["content"] == raw  # 原文保留
    # 兜底卡片仍可确认落库为待办
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo", "todo": {"content": raw}})
    assert r.status_code == 200
    assert client.get("/api/todos").json()[0]["content"] == raw


def test_not_configured_degrades_explicitly(client):
    d = client.post("/api/parse", json={"text": "任何输入"}).json()
    assert d["fallback"] is True
    assert d["error"]["category"] == "not_configured"
    assert "设置页" in d["error"]["message"]


def test_bad_json_schema_retry_then_fallback(client, mock_base_url):
    """输出不合 schema：自动带错误重请求 1 次，仍失败走兜底（架构 3.3）。"""
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-bad-json"}})
    d = client.post("/api/parse", json={"text": "触发非JSON输出"}).json()
    assert d["fallback"] is True and d["error"]["category"] == "schema"


def test_discard_keeps_raw(client, mock_base_url, data_dir):
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-text"}})
    d = client.post("/api/parse", json={"text": "将被放弃的输入"}).json()
    r = client.delete(f"/api/parse/{d['source_record_id']}")
    assert r.status_code == 200
    # 放弃后原文仍在库中可回看
    from app import db
    with db.get_conn() as conn:
        row = conn.execute("SELECT status, raw_text FROM source_records WHERE id = ?",
                           (d["source_record_id"],)).fetchone()
    assert row["status"] == "discarded" and row["raw_text"] == "将被放弃的输入"
    # 已确认/已放弃的记录不能再确认
    r = client.post(f"/api/parse/{d['source_record_id']}/confirm", json={
        "destination": "todo", "todo": {"content": "x"}})
    assert r.status_code == 404
