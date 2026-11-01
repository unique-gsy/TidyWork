"""路由：AI 助手（DSH 接入）。

- /api/agent/chat      ：对话页单一引擎（DSH 动作协议：reply + actions[] 写回方寸）
- /api/agent/extract   ：纪要 / 长文提炼为结构化待办候选
- /api/agent/summarize ：按给定事实清单生成周报 / 项目摘要
- /api/agent/health    ：DSH + DeepSeek Key 连通性检查
"""
import json
import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import db, timex
from ..llm import LLMError, _extract_json, error_payload
from ..services import dsh_client

logger = logging.getLogger("workbench.agent")

router = APIRouter(prefix="/api/agent", tags=["agent"])


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    project: str | None = None  # 可附加项目筛选（前端项目联动上下文）
    note_context: str | None = None  # 前端可选附带的笔记摘要
    workspace: dict | None = None  # 前端工作台事实（todos/meetings/expenses/notes/projects）


class ExtractRequest(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


class SummarizeRequest(BaseModel):
    facts_markdown: str = Field(min_length=1, max_length=20000)
    label: str = "本周工作"
    max_words: int = Field(default=200, ge=50, le=800)


CHAT_SYSTEM = """你是「方寸」的 AI 助手（由 DeepSeek Harness 驱动），也是方寸工作台的数据管家。
用户会提供工作台事实（待办/会议/记账/笔记/项目）和消息。你必须且只能输出一个 JSON 对象：

{"reply": "给用户的自然语言回复", "actions": [动作列表]}

reply 必填（给用户的回复）；actions 可为空数组（纯回答/闲聊时）。

可用动作 op（白名单，不得使用其他 op）：
- add_todo    : {"op":"add_todo", "title":"待办内容", "due":"YYYY-MM-DD 或 null", "project":"项目名或 null"}
- add_meeting : {"op":"add_meeting", "title":"会议主题", "at":"YYYY-MM-DDTHH:MM 或 null", "project":"项目名或 null"}
- add_expense : {"op":"add_expense", "amount_cents":整数分, "category":"交通/餐饮/购物/其他等"}
- add_note    : {"op":"add_note", "title":"笔记标题", "content":"笔记正文"}
- set_done    : {"op":"set_done", "todo_title":"与工作台事实中一致的待办标题"}

规则：
1. 仅当用户明确表达「记录/新增/记一下/更新/完成/标记」等写操作意图时，才产生 add_*/set_done 动作；
   闲聊、问答、查询一律 actions=[]；
2. 动作字段只取用户消息与工作台事实中的内容，不得编造；日期相对表达按工作台事实中的「今天」换算成具体日期；
3. add_todo/add_meeting 的 title 用用户原话的核心内容；
4. set_done 只针对工作台事实中存在的待办（标题一致）；
5. reply 要具体、简洁，优先引用事实中的真实条目；事实里没有的信息，如实说明「工作台里没有记录」。
只输出 JSON，不要任何前后缀、解释或 markdown 代码块。"""


_ALLOWED_OPS = {"add_todo", "add_meeting", "add_expense", "add_note", "set_done"}


def _fmt_workspace(ws: dict | None) -> str:
    """把前端工作台事实格式化为 DSH 上下文。"""
    if not ws:
        return "（前端未提供工作台事实）"
    lines = [f"今天：{timex.now_local().strftime('%Y-%m-%d %H:%M %A')}"]
    projects = ws.get("projects") or []
    todos = ws.get("todos") or []
    meetings = ws.get("meetings") or []
    notes = ws.get("notes") or []
    expenses = ws.get("expenses") or []
    lines.append("项目：" + ("、".join(str(p.get("name", "")) for p in projects) if projects else "（无）"))
    lines.append("待办：")
    if not todos:
        lines.append("（无）")
    for t in todos:
        mark = "✓" if t.get("done") else ""
        due = f"（{t.get('due')}）" if t.get("due") else ""
        lines.append(f"- [{mark}] {t.get('title')}{due}")
    lines.append("会议：")
    if not meetings:
        lines.append("（无）")
    for m in meetings:
        at = f"（{m.get('at')}）" if m.get("at") else ""
        lines.append(f"- {m.get('title')}{at}")
    lines.append("笔记：")
    if not notes:
        lines.append("（无）")
    for n in notes:
        lines.append(f"- {n.get('title')}")
    lines.append("记账：")
    if not expenses:
        lines.append("（无）")
    for e in expenses:
        lines.append(f"- {e.get('category')} {e.get('amount')} 元")
    return "\n".join(lines)


def _clean_actions(actions) -> list[dict]:
    """白名单清洗 DSH 返回的动作。"""
    out = []
    for a in (actions if isinstance(actions, list) else []):
        if not isinstance(a, dict):
            continue
        op = a.get("op")
        if op not in _ALLOWED_OPS:
            continue
        item = {"op": op}
        if op == "add_todo":
            title = str(a.get("title") or "").strip()
            if not title:
                continue
            item.update(title=title[:200], due=a.get("due") or None,
                        project=(str(a.get("project") or "")[:100]) or None)
        elif op == "add_meeting":
            title = str(a.get("title") or "").strip()
            if not title:
                continue
            item.update(title=title[:200], at=a.get("at") or None,
                        project=(str(a.get("project") or "")[:100]) or None)
        elif op == "add_expense":
            try:
                amt = int(a.get("amount_cents"))
            except (TypeError, ValueError):
                continue
            if amt <= 0 or amt > 100000000:
                continue
            item.update(amount_cents=amt,
                        category=str(a.get("category") or "其他")[:50])
        elif op == "add_note":
            item.update(title=(str(a.get("title") or "").strip() or "笔记")[:200],
                        content=str(a.get("content") or "")[:20000])
        elif op == "set_done":
            title = str(a.get("todo_title") or "").strip()
            if not title:
                continue
            item.update(todo_title=title[:200])
        out.append(item)
    return out


def _action_prompt(req: ChatRequest) -> str:
    parts = [CHAT_SYSTEM, "===== 工作台事实 =====", _fmt_workspace(req.workspace)]
    if req.note_context:
        parts.append("===== 用户附带笔记 =====")
        parts.append(req.note_context[:4000])
    parts.append("===== 用户消息 =====")
    parts.append(req.message)
    return "\n".join(parts)


@router.post("/chat")
def chat(req: ChatRequest):
    try:
        raw = dsh_client.run_headless(_action_prompt(req))
    except LLMError as e:
        return {"reply": None, "actions": [], "error": error_payload(e)}
    try:
        data = _extract_json(raw)
        reply = str(data.get("reply") or "").strip()
        actions = _clean_actions(data.get("actions"))
        if not reply:
            reply = "好的，已为你处理。" if actions else raw.strip()
        return {"reply": reply[:2000], "actions": actions, "raw": raw}
    except Exception:  # noqa: BLE001  DSH 未按协议输出时退化为纯文本
        return {"reply": raw.strip()[:2000], "actions": [], "raw": raw}


EXTRACT_SYSTEM = """你是任务提炼助手。从用户提供的文本（会议纪要、长文、随手记录）中提炼可以执行的待办或会议安排。
规则：
1. 只提炼文本中明确出现的任务/事项，不推断、不编造；
2. 每项给 type（todo=待办 / meeting=会议）、content（待办内容或会议主题）；
3. 文本中提到的日期写 due_date（YYYY-MM-DD 或 null）；会议若有时间写 start_at（YYYY-MM-DDTHH:MM 或 null）；
4. 无法提炼出任何任务时返回空数组。
只输出一个 JSON 对象：{"items":[{"type":"todo|meeting","content":"...","due_date":null,"start_at":null,"note":null}]}"""


@router.post("/extract")
def extract(req: ExtractRequest):
    prompt = f"{EXTRACT_SYSTEM}\n\n===== 用户文本 =====\n{req.text}"
    try:
        raw = dsh_client.run_headless(prompt)
        data = _extract_json(raw)
        items = data.get("items", [])
        if not isinstance(items, list):
            items = []
        # 清洗：只保留合法字段
        cleaned = []
        for it in items:
            if not isinstance(it, dict):
                continue
            t = it.get("type") if it.get("type") in ("todo", "meeting") else "todo"
            content = str(it.get("content") or "").strip()
            if not content:
                continue
            cleaned.append({
                "type": t,
                "content": content[:500],
                "due_date": it.get("due_date") or None,
                "start_at": it.get("start_at") or None,
                "note": (str(it.get("note") or "")[:300]) or None,
            })
        return {"items": cleaned, "raw_reply": None}
    except LLMError as e:
        return {"items": None, "error": error_payload(e)}


SUMMARIZE_SYSTEM = """你是周报/项目摘要助手。根据用户提供的本周工作事实清单，写一段概览摘要。
硬性要求：
1. 只能基于清单中出现的事实，禁止编造任何未发生的事项、数字或结论；
2. 语言简洁、陈述句为主；
3. 只输出摘要正文，不要标题、不要列表、不要任何前后缀说明。"""


@router.post("/summarize")
def summarize(req: SummarizeRequest):
    prompt = (
        f"{SUMMARIZE_SYSTEM}\n\n"
        f"摘要区间：{req.label}（目标约 {req.max_words} 字）\n"
        f"事实清单：\n{req.facts_markdown}"
    )
    try:
        text = dsh_client.run_headless(prompt)
        return {"summary": text.strip()}
    except LLMError as e:
        return {"summary": None, "error": error_payload(e)}


@router.get("/health")
def health():
    return dsh_client.health()
