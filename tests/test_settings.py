"""F·非功能：设置与密钥三条硬规则、测试连接、日志脱敏。"""
import logging


def _get(client):
    return client.get("/api/settings").json()


def test_defaults_masked(client):
    s = _get(client)
    assert s["text"]["api_key_masked"] == ""
    assert s["text"]["api_key_set"] is False
    assert s["vision"]["api_key_set"] is False
    assert s["image_max_size_mb"] == 10.0


def test_hard_rule_1_get_never_returns_plaintext(client, mock_base_url):
    r = client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-plaintext-abcdef1234",
                 "model": "mock-text"},
    })
    assert r.status_code == 200
    # 任何 GET 响应都不得包含明文密钥
    body = client.get("/api/settings")
    assert "sk-plaintext-abcdef1234" not in body.text
    s = body.json()
    assert s["text"]["api_key_masked"] == "****1234"
    assert s["text"]["api_key_set"] is True


def test_hard_rule_2_empty_key_keeps_previous(client, mock_base_url):
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-keep-me-9999",
                 "model": "mock-text"},
    })
    # 更新其它字段但 api_key 留空 → 密钥不变
    r = client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "model": "mock-echo"},
    })
    assert r.status_code == 200
    from app import db
    assert db.get_setting("text.api_key") == "sk-keep-me-9999"
    s = _get(client)
    assert s["text"]["model"] == "mock-echo"
    assert s["text"]["api_key_masked"] == "****9999"


def test_hard_rule_3_logs_never_contain_key(client, mock_base_url, data_dir):
    """认证失败 + 直接记录日志两种路径下，日志文件不落明文密钥。"""
    key = "sk-log-secret-7777"
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": key, "model": "mock-401"},
    })
    # 触发一次失败的模型调用（auth 错误路径会写 warning 日志）
    r = client.post("/api/parse", json={"text": "触发一次失败的调用"})
    assert r.status_code == 200
    assert r.json()["fallback"] is True
    assert r.json()["error"]["category"] == "auth"
    # 直接用 logging 记一条含密钥的日志，验证脱敏过滤器
    logging.getLogger("workbench.test").warning("manual log with key=%s", key)
    log_text = (data_dir / "logs" / "app.log").read_text(encoding="utf-8")
    assert key not in log_text, "日志中出现明文 api_key"
    assert "****" in log_text


def test_connection_test(client, mock_base_url):
    # 未配置 → 明确提示
    r = client.post("/api/settings/test", json={"slots": ["text"]}).json()
    assert r[0]["ok"] is False and r[0]["category"] == "not_configured"
    # 配置后 → 连接成功
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "api_key": "sk-x", "model": "mock-echo"},
    })
    r = client.post("/api/settings/test", json={"slots": ["text"]}).json()
    assert r[0]["ok"] is True
    # 模型名错误 → 分类提示指引设置页
    client.put("/api/settings", json={"text": {"model": "mock-404"}})
    r = client.post("/api/settings/test", json={"slots": ["text"]}).json()
    assert r[0]["ok"] is False and r[0]["category"] == "model_not_found"


def test_invalid_base_url_rejected(client):
    r = client.put("/api/settings", json={"text": {"base_url": "ftp://x"}})
    assert r.status_code == 400


def test_switch_model_keeps_data(client, mock_base_url):
    """切换模型配置后已有数据不变（非功能验收）。"""
    client.post("/api/projects", json={"name": "A项目"})
    before = client.get("/api/projects").json()
    client.put("/api/settings", json={
        "text": {"base_url": mock_base_url, "model": "mock-echo"},
        "vision": {"base_url": mock_base_url, "model": "mock-vision"},
    })
    after = client.get("/api/projects").json()
    assert before == after
