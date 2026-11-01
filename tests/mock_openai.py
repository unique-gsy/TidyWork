"""Mock OpenAI 兼容服务：按 /v1/chat/completions 协议模拟各类模型行为。

通过模型名路由行为，覆盖：正常解析 / 识别 / 摘要、非 JSON 输出、
401 / 404 / 429 / 500 / 超时、不支持图片输入。
请求计数暴露在 /stats，供测试断言「空数据不调用模型」。
"""
import re
import time
from datetime import datetime, timedelta

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()

REQUESTS: list[dict] = []


def _chat(content: str, model: str) -> JSONResponse:
    body = {
        "id": "chatcmpl-mock", "object": "chat.completion", "created": 1700000000,
        "model": model,
        "choices": [{
            "index": 0, "finish_reason": "stop",
            "message": {"role": "assistant", "content": content},
        }],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    }
    return JSONResponse(body)


def _err(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": {"message": message, "type": "mock_error"}},
                        status_code=status)


def _extract_now(messages: list[dict]) -> datetime:
    """从 system 消息里解析「当前时间：YYYY-MM-DD HH:MM」作为相对时间基准。"""
    for m in messages:
        text = m.get("content") or ""
        if isinstance(text, list):
            text = " ".join(c.get("text", "") for c in text if isinstance(c, dict))
        mm = re.search(r"当前时间：(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})", text)
        if mm:
            return datetime.strptime(f"{mm.group(1)} {mm.group(2)}", "%Y-%m-%d %H:%M")
    return datetime.now()


def _user_text(messages: list[dict]) -> str:
    """取最后一条 user 消息的文本（解析场景即用户原始输入）。"""
    for m in reversed(messages):
        if m.get("role") != "user":
            continue
        c = m.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return " ".join(x.get("text", "") for x in c if isinstance(x, dict))
    return ""


def _mock_parse_result(user_text: str, now: datetime) -> str:
    if "以及" in user_text or "还有一件事" in user_text:
        result = {
            "intent": "todo", "suggested_destination": "todo", "multiple_items": True,
            "split_hint": "检测到两个事项，建议拆成两条分别输入",
            "meeting": {"title": None, "start_at": None, "participants": None,
                        "location": None, "note": None, "missing": []},
            "todo": {"content": user_text, "due_date": None, "project_name": None,
                     "missing": []},
        }
    elif "站会" in user_text:  # 相对时间：明天上午10点
        tomorrow = now + timedelta(days=1)
        result = {
            "intent": "meeting", "suggested_destination": "meeting", "multiple_items": False,
            "split_hint": "",
            "meeting": {"title": "站会", "start_at": f"{tomorrow.strftime('%Y-%m-%d')}T10:00:00",
                        "participants": None, "location": None, "note": None, "missing": []},
            "todo": {"content": None, "due_date": None, "project_name": None, "missing": []},
        }
    elif "找时间" in user_text:  # 时间歧义：不给确定时间
        result = {
            "intent": "meeting", "suggested_destination": "meeting", "multiple_items": False,
            "split_hint": "",
            "meeting": {"title": "和李总碰一下", "start_at": None, "participants": "李总",
                        "location": None, "note": None, "missing": ["start_at"]},
            "todo": {"content": None, "due_date": None, "project_name": None, "missing": []},
        }
    elif "开会讨论" in user_text and "发材料" in user_text:  # 混合意图
        result = {
            "intent": "mixed", "suggested_destination": "meeting", "multiple_items": False,
            "split_hint": "",
            "meeting": {"title": "讨论B项目", "start_at": None, "participants": None,
                        "location": None, "note": "提前发材料", "missing": ["start_at"]},
            "todo": {"content": "提前发B项目材料", "due_date": None, "project_name": "B项目",
                     "missing": []},
        }
    else:  # 默认：待办，识别截止周五与点名项目
        due = None
        project = None
        if "周五前" in user_text:
            due = now + timedelta(days=(4 - now.weekday()) % 7)
            if due <= now:
                due += timedelta(days=7)
            due = due.strftime("%Y-%m-%d")
        m = re.search(r"([A-Z])\s*项目", user_text)
        if m:
            project = f"{m.group(1)}项目"
        result = {
            "intent": "todo", "suggested_destination": "todo", "multiple_items": False,
            "split_hint": "",
            "meeting": {"title": None, "start_at": None, "participants": None,
                        "location": None, "note": None, "missing": []},
            "todo": {"content": user_text, "due_date": due, "project_name": project,
                     "missing": []},
        }
    import json
    return json.dumps(result, ensure_ascii=False)


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/stats")
def stats():
    return {"count": len(REQUESTS), "requests": REQUESTS}


@app.post("/v1/chat/completions")
async def completions(request: Request):
    body = await request.json()
    model = body.get("model", "")
    messages = body.get("messages", [])
    REQUESTS.append({"model": model, "messages_len": len(messages)})

    if model == "mock-401":
        return _err(401, "Invalid API key")
    if model == "mock-404":
        return _err(404, "model not found")
    if model == "mock-429":
        return _err(429, "rate limited")
    if model == "mock-500":
        return _err(500, "internal server error")
    if model == "mock-timeout":
        time.sleep(3)
        return _chat("ok", model)
    if model == "mock-bad-json":
        return _chat("这不是 JSON 输出", model)
    if model == "mock-unsupported-vision":
        return _err(400, "This model does not support image input")
    if model == "mock-vision":
        import json
        result = {
            "recognized_text": "1. 完成季度评审材料\n2. 预约下周三评审会",
            "suggested": {
                "intent": "todo", "suggested_destination": "todo", "multiple_items": False,
                "split_hint": "",
                "meeting": {"title": None, "start_at": None, "participants": None,
                            "location": None, "note": None, "missing": []},
                "todo": {"content": "完成季度评审材料", "due_date": None,
                         "project_name": None, "missing": ["due_date"]},
            },
        }
        return _chat(json.dumps(result, ensure_ascii=False), model)
    if model == "mock-summary":
        return _chat("本周完成多项待办并参加多场会议，整体进展顺利。", model)
    if model == "mock-echo":
        return _chat("ok", model)
    # mock-text / 其他：结构化解析模拟
    now = _extract_now(messages)
    user_text = _user_text(messages)
    return _chat(_mock_parse_result(user_text, now), model)
