"""Pydantic 模型：请求体校验 + 模型输出的 JSON Schema 校验（ADR-003）。"""
from typing import Literal

from pydantic import BaseModel, Field


# ---------- 模型输出 schema（解析） ----------

class MeetingDraft(BaseModel):
    title: str | None = None
    start_at: str | None = None  # 本地时间 YYYY-MM-DDTHH:MM:SS，无法确定则 None
    participants: str | None = None
    location: str | None = None
    note: str | None = None
    missing: list[str] = Field(default_factory=list)

    model_config = {"extra": "ignore"}


class TodoDraft(BaseModel):
    content: str | None = None
    due_date: str | None = None  # 本地日期 YYYY-MM-DD
    project_name: str | None = None
    missing: list[str] = Field(default_factory=list)

    model_config = {"extra": "ignore"}


class ParseOutput(BaseModel):
    """文本解析 / 图片识别的统一模型输出协议。"""
    intent: Literal["meeting", "todo", "mixed"] = "todo"
    suggested_destination: Literal["meeting", "todo"] = "todo"
    multiple_items: bool = False
    split_hint: str = ""
    meeting: MeetingDraft = Field(default_factory=MeetingDraft)
    todo: TodoDraft = Field(default_factory=TodoDraft)

    model_config = {"extra": "ignore"}


class RecognitionOutput(BaseModel):
    """图片识别模型输出：识别文本 + 候选结构化字段。"""
    recognized_text: str = ""
    suggested: ParseOutput = Field(default_factory=ParseOutput)

    model_config = {"extra": "ignore"}


# ---------- API 请求体 ----------

class ParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class ParseUpdateRequest(BaseModel):
    """确认前修改解析字段（含存为会议/待办切换）。"""
    destination: Literal["meeting", "todo", "note"] | None = None
    parse: ParseOutput | None = None
    recognized_text: str | None = None


class MeetingConfirm(BaseModel):
    title: str = Field(min_length=1, max_length=500)
    start_at: str | None = None  # 本地时间；空 = 待补全
    participants: str = ""
    location: str = ""
    note: str = ""


class TodoConfirm(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    due_date: str | None = None  # 本地日期
    project_id: int | None = None
    new_project_name: str | None = None  # 卡片上直接新建项目


class ConfirmRequest(BaseModel):
    destination: Literal["meeting", "todo", "note"]
    meeting: MeetingConfirm | None = None
    todo: TodoConfirm | None = None


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = ""


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = None
    status: Literal["active", "archived"] | None = None


class TodoCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    due_date: str | None = None
    project_id: int | None = None


class TodoUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    due_date: str | None = None
    project_id: int | None = None
    status: Literal["open", "done"] | None = None


class MeetingUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=500)
    start_at: str | None = None
    participants: str | None = None
    location: str | None = None
    note: str | None = None
    status: Literal["planned", "held", "cancelled", "pending_completion"] | None = None


class ReportGenerateRequest(BaseModel):
    week_start: str | None = None  # 本地日期，须为周一；默认本周
    force: bool = False  # 覆盖已有编辑内容草稿的二次确认标记


class ReportUpdate(BaseModel):
    content_markdown: str | None = None
    status: Literal["draft", "finalized"] | None = None


class SlotSettings(BaseModel):
    base_url: str | None = None
    api_key: str | None = None  # 空/None = 保持不变（三条硬规则之二）
    model: str | None = None
    timeout: float | None = Field(default=None, gt=0, le=600)


class SettingsUpdate(BaseModel):
    text: SlotSettings | None = None
    vision: SlotSettings | None = None
    image_max_size_mb: float | None = Field(default=None, gt=0, le=200)
    timezone: str | None = None


class SettingsTestRequest(BaseModel):
    slots: list[Literal["text", "vision"]] = Field(default_factory=lambda: ["text", "vision"])
