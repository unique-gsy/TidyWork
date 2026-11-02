"""模型接入层：OpenAI 兼容接口统一封装（架构第 3 节）。

- text / vision 分槽配置，各自独立（base_url、api_key、model、timeout）；
- 上层只见三个语义方法：parse_text / summarize_week / recognize_image；
- 超时重试：仅超时、429、5xx 自动重试，指数退避，最多 2 次；4xx 不重试；
- 错误分类 → 用户可读提示，全部不泄露 api_key（日志脱敏见 logging_setup）。
"""
import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime

import httpx

import os

from . import config, db, timex
from .schemas import ParseOutput, RecognitionOutput

logger = logging.getLogger("workbench.llm")


# ---------- 错误分类 ----------

class LLMError(Exception):
    """分类后的模型调用错误。message 可直接展示给用户，不含密钥。"""

    def __init__(self, category: str, message: str, status_code: int = 502):
        super().__init__(message)
        self.category = category
        self.message = message
        self.status_code = status_code


FRIENDLY = {
    "not_configured": "模型未配置，请到设置页填写模型地址与模型名",
    "network": "无法连接模型服务，请检查 base_url 与网络后重试",
    "timeout": "模型服务响应超时，请稍后重试",
    "auth": "密钥无效或无权限，请到设置页检查 api_key",
    "model_not_found": "模型名可能有误，请到设置页检查模型名",
    "vision_unsupported": "当前模型不支持图片识别，请到设置页切换多模态模型",
    "rate_limit": "模型服务繁忙，请稍后再试",
    "schema": "模型输出格式异常，已保留原文，可重试",
    "server_error": "模型服务内部错误，请稍后重试",
    "bad_request": "模型服务拒绝了本次请求（请求参数问题），请检查配置",
    "unknown": "模型调用失败，请稍后重试",
}

RETRYABLE = {"timeout", "rate_limit", "server_error"}


def _classify(exc: Exception) -> str:
    """把 SDK/网络异常映射到错误类别（架构 3.3 表）。"""
    import openai
    if isinstance(exc, openai.APITimeoutError):
        return "timeout"
    if isinstance(exc, openai.APIConnectionError):
        return "network"
    if isinstance(exc, (openai.AuthenticationError, openai.PermissionDeniedError)):
        return "auth"
    if isinstance(exc, openai.NotFoundError):
        return "model_not_found"
    if isinstance(exc, openai.RateLimitError):
        return "rate_limit"
    if isinstance(exc, openai.InternalServerError):
        return "server_error"
    if isinstance(exc, openai.BadRequestError):
        msg = str(exc).lower()
        if any(k in msg for k in ("image", "vision", "multimodal", "multi-modal", "图片")):
            return "vision_unsupported"
        return "bad_request"
    if isinstance(exc, openai.APIStatusError):
        return "server_error"
    return "unknown"


def error_payload(e: LLMError) -> dict:
    return {"category": e.category, "message": e.message}


# ---------- 槽位配置 ----------

@dataclass
class SlotConfig:
    slot: str
    base_url: str
    api_key: str
    model: str
    read_timeout: float


def load_slot(slot: str) -> SlotConfig:
    return SlotConfig(
        slot=slot,
        base_url=db.get_setting(f"{slot}.base_url").strip(),
        api_key=os.environ.get("DEEPSEEK_API_KEY", ""),  # Key 只配置在 DSH 容器侧
        model=db.get_setting(f"{slot}.model").strip(),
        read_timeout=float(db.get_setting(f"{slot}.timeout", "60")),
    )


def mask_key(key: str) -> str:
    """脱敏回显：**** + 末 4 位（三条硬规则之一）。"""
    if not key:
        return ""
    if len(key) <= 4:
        return "****"
    return "****" + key[-4:]


def _client(cfg: SlotConfig):
    import openai
    return openai.OpenAI(
        base_url=cfg.base_url,
        api_key=cfg.api_key or "not-set",
        timeout=httpx.Timeout(cfg.read_timeout, connect=5.0),
        max_retries=0,  # 重试策略由本层控制
    )


def _chat(slot: str, messages: list[dict], temperature: float = 0.1) -> str:
    """带超时重试的 chat completion 调用，返回模型文本输出。"""
    cfg = load_slot(slot)
    if not cfg.base_url or not cfg.model:
        raise LLMError("not_configured", FRIENDLY["not_configured"], 400)
    client = _client(cfg)
    delays = config.retry_delays()
    attempt = 0
    while True:
        try:
            resp = client.chat.completions.create(
                model=cfg.model, messages=messages, temperature=temperature,
            )
            content = resp.choices[0].message.content or ""
            logger.info("llm call ok slot=%s model=%s len=%d", slot, cfg.model, len(content))
            return content
        except Exception as exc:  # noqa: BLE001 — 统一分类
            category = _classify(exc)
            if category in RETRYABLE and attempt < len(delays):
                logger.warning(
                    "llm retry slot=%s category=%s attempt=%d (status/类别见此，无请求体)",
                    slot, category, attempt,
                )
                time.sleep(delays[attempt])
                attempt += 1
                continue
            logger.warning("llm failed slot=%s category=%s", slot, category)
            status = 400 if category in ("not_configured",) else 502
            if category == "vision_unsupported":
                status = 422
            raise LLMError(category, FRIENDLY.get(category, FRIENDLY["unknown"]), status)


# ---------- JSON 输出解析 ----------

def _extract_json(text: str) -> dict:
    """从模型输出中提取 JSON 对象（容忍 markdown 代码块与前后噪声）。"""
    cleaned = text.strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", cleaned, re.S)
    if fence:
        cleaned = fence.group(1).strip()
    start = cleaned.find("{")
    if start < 0:
        raise ValueError("no json object in output")
    depth = 0
    for i, ch in enumerate(cleaned[start:], start=start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return json.loads(cleaned[start:i + 1])
    raise ValueError("unbalanced json in output")


# ---------- 三个语义方法 ----------

def _now_context() -> str:
    now = timex.now_local()
    weekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
    return (
        f"当前时间：{now.strftime('%Y-%m-%d %H:%M')}（{weekdays[now.weekday()]}），"
        f"时区 {db.get_setting('app.timezone', 'Asia/Shanghai')}。"
    )


PARSE_SYSTEM_PROMPT = """你是个人工作台的记录解析器，负责把用户输入的一句话解析为结构化 JSON。
规则：
1. 相对时间（"明天上午10点""下周三""周四10点"等）必须以当前时间为基准换算成绝对日期时间，格式 YYYY-MM-DDTHH:MM:SS；用户未提年份时按最近将来推算。
2. 时间缺失或模糊（如"下周找时间碰一下"）时不要猜测，对应字段置 null，并把字段名（如 start_at）加入 missing 数组。
3. intent 取 meeting（会议安排）/ todo（工作待办）/ mixed（既像会议又像待办）。
4. suggested_destination 给出建议去向；mixed 时也必须给出建议。
5. 输入包含多个独立事项时 multiple_items 置 true，并在 split_hint 中给出建议的拆分方式（一句话）。
6. todo.project_name 仅在输入明确点名项目时填写，不要猜测。
7. 只输出一个 JSON 对象，不要输出任何其他文字。JSON 结构：
{"intent":"meeting|todo|mixed","suggested_destination":"meeting|todo","multiple_items":false,"split_hint":"","meeting":{"title":null,"start_at":null,"participants":null,"location":null,"note":null,"missing":[]},"todo":{"content":null,"due_date":null,"project_name":null,"missing":[]}}"""


def parse_text(raw: str) -> ParseOutput:
    """文本结构化抽取 + JSON Schema 校验；不合规带错误重请求 1 次（架构 3.3）。"""
    messages = [
        {"role": "system", "content": f"{_now_context()}\n{PARSE_SYSTEM_PROMPT}"},
        {"role": "user", "content": raw},
    ]
    last_schema_error = None
    for i in range(2):
        text = _chat("text", messages)
        try:
            return ParseOutput.model_validate(_extract_json(text))
        except Exception as exc:  # noqa: BLE001
            last_schema_error = exc
            messages.append({"role": "assistant", "content": text})
            messages.append({
                "role": "user",
                "content": f"你的输出不符合要求：{exc}。请严格按系统提示中的 JSON 结构重新输出，只输出 JSON。",
            })
    raise LLMError("schema", FRIENDLY["schema"], 502)


RECOGNIZE_SYSTEM_PROMPT = """你是图片识别助手。识别图片内容（白板照片、任务截图等），提取文字要点与候选结构化字段。
规则：
1. recognized_text 为图片中识别出的要点，逐条用换行分隔；识别不到内容则留空字符串。
2. suggested 按输入解析规则给出候选结构化字段（同样遵守相对时间换算与不猜测原则）。
3. 只输出一个 JSON 对象。JSON 结构：
{"recognized_text":"","suggested":{"intent":"meeting|todo|mixed","suggested_destination":"meeting|todo","multiple_items":false,"split_hint":"","meeting":{"title":null,"start_at":null,"participants":null,"location":null,"note":null,"missing":[]},"todo":{"content":null,"due_date":null,"project_name":null,"missing":[]}}}"""


def recognize_image(image_b64: str, mime: str, note: str) -> RecognitionOutput:
    """多模态识别：图片 base64 内嵌消息传入 vision 槽（架构 3.1/5.3）。"""
    content: list[dict] = [
        {"type": "text", "text": f"{_now_context()}\n{RECOGNIZE_SYSTEM_PROMPT}"},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
    ]
    if note:
        content.append({"type": "text", "text": f"用户补充说明：{note}"})
    messages = [{"role": "user", "content": content}]
    last_schema_error = None
    for i in range(2):
        text = _chat("vision", messages)
        try:
            return RecognitionOutput.model_validate(_extract_json(text))
        except Exception as exc:  # noqa: BLE001
            last_schema_error = exc
            messages.append({"role": "assistant", "content": text})
            messages.append({
                "role": "user",
                "content": f"你的输出不符合要求：{exc}。请严格按之前的 JSON 结构重新输出，只输出 JSON。",
            })
    raise LLMError("schema", FRIENDLY["schema"], 502)


SUMMARY_SYSTEM_PROMPT = """你是周报撰写助手。根据用户提供的本周工作事实清单，写一段 100-200 字的概览摘要。
硬性要求：
1. 只能基于清单中出现的事实，禁止编造任何未发生的事项、数字或结论；
2. 语言简洁、陈述句为主；
3. 只输出摘要正文，不要标题、不要列表、不要任何前后缀说明。"""


def summarize_week(facts_markdown: str, week_label: str) -> str:
    messages = [
        {"role": "system", "content": SUMMARY_SYSTEM_PROMPT},
        {"role": "user", "content": f"周报区间：{week_label}\n本周事实清单：\n{facts_markdown}"},
    ]
    text = _chat("text", messages, temperature=0.3)
    return text.strip()


def test_slot(slot: str) -> dict:
    """设置页「测试连接」：对指定槽位发起一次最小补全调用。"""
    try:
        cfg = load_slot(slot)
        if not cfg.base_url or not cfg.model:
            return {"slot": slot, "ok": False, "category": "not_configured",
                    "message": FRIENDLY["not_configured"]}
        reply = _chat(slot, [
            {"role": "system", "content": "你是连通性测试助手。"},
            {"role": "user", "content": "请回复：ok"},
        ])
        return {"slot": slot, "ok": True, "message": f"连接成功（模型返回 {len(reply)} 字符）"}
    except LLMError as e:
        return {"slot": slot, "ok": False, "category": e.category, "message": e.message}
