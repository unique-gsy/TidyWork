"""F2 · 待办与项目分类管理（A7：仅归档不可删除）。"""


def test_project_lifecycle(client):
    # 新建
    r = client.post("/api/projects", json={"name": "A项目", "description": "授信方案"})
    assert r.status_code == 200 and r.json()["status"] == "active"
    pid = r.json()["id"]
    # 重名 409
    assert client.post("/api/projects", json={"name": "A项目"}).status_code == 409
    # 归档：不提供删除端点（A7）
    r = client.patch(f"/api/projects/{pid}", json={"status": "archived"})
    assert r.json()["status"] == "archived" and r.json()["archived_at"]
    # 候选列表（active）不再出现，全量列表仍可见
    assert all(p["id"] != pid for p in client.get("/api/projects?status=active").json())
    assert any(p["id"] == pid for p in client.get("/api/projects").json())
    # 恢复
    r = client.patch(f"/api/projects/{pid}", json={"status": "active"})
    assert r.json()["status"] == "active" and r.json()["archived_at"] is None


def test_todo_crud_and_grouping(client):
    pa = client.post("/api/projects", json={"name": "A项目"}).json()["id"]
    pb = client.post("/api/projects", json={"name": "B项目"}).json()["id"]
    t1 = client.post("/api/todos", json={"content": "A项目合同", "project_id": pa,
                                         "due_date": "2026-09-25"}).json()
    t2 = client.post("/api/todos", json={"content": "B项目评审", "project_id": pb}).json()
    t3 = client.post("/api/todos", json={"content": "无归属事项"}).json()
    # 按项目筛选
    assert len(client.get("/api/todos", params={"project_id": pa}).json()) == 1
    assert len(client.get("/api/todos", params={"project_id": pb}).json()) == 1
    assert len(client.get("/api/todos").json()) == 3
    # 完成与重开
    r = client.patch(f"/api/todos/{t1['id']}", json={"status": "done"})
    assert r.json()["status"] == "done" and r.json()["completed_at"]
    r = client.patch(f"/api/todos/{t1['id']}", json={"status": "open"})
    assert r.json()["status"] == "open" and r.json()["completed_at"] is None
    # 更换所属项目
    r = client.patch(f"/api/todos/{t3['id']}", json={"project_id": pa})
    assert r.json()["project_name"] == "A项目"
    # 编辑内容与截止日
    r = client.patch(f"/api/todos/{t2['id']}", json={"content": "B项目评审（改）",
                                                     "due_date": "2026-09-30"})
    assert r.json()["content"] == "B项目评审（改）"
    # 项目归档后历史待办仍可见（只读历史）
    client.patch(f"/api/projects/{pb}", json={"status": "archived"})
    todos = client.get("/api/todos", params={"project_id": pb}).json()
    assert len(todos) == 1  # 历史待办保持可见
    # 归档项目不能再接收新待办
    assert client.post("/api/todos", json={"content": "x", "project_id": pb}).status_code == 409


def test_manual_todo_requires_active_project(client):
    pa = client.post("/api/projects", json={"name": "A项目"}).json()["id"]
    client.patch(f"/api/projects/{pa}", json={"status": "archived"})
    assert client.post("/api/todos", json={"content": "x", "project_id": pa}).status_code == 409
