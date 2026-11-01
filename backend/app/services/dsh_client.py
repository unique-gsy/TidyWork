"""DSH（DeepSeek Harness）接入层：headless agent 调用。

- 方寸后端与 DSH 同容器部署：通过容器内 `dsh headless` CLI 执行独立 agent 任务，返回最终回复；
- DeepSeek API Key 取自设置页 text 槽位（用户人工存入），以 DEEPSEEK_API_KEY 环境变量注入调用环境；
- 错误分类与 llm.py 一致（auth/network/timeout/unknown），message 可直接展示给用户，不含密钥；
- DSH 可随时升级：本层只依赖 `dsh headless` CLI 约定，不依赖其内部 npm 包结构。
"""
import logging
import os
import re
import subprocess

from .. import db, timex
from ..llm import LLMError

logger = logging.getLogger("workbench.dsh")

# 容器内引导 DSH 环境的固定前缀（nvm 安装的 Node 不在默认 PATH）
_BOOT = 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd ~'

_KEY_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def api_key() -> str:
    """当前配置的 DeepSeek API Key（设置页 text 槽，人工存入）。"""
    return db.get_setting("text.api_key").strip()


def dsh_available() -> bool:
    """DSH CLI 是否可用（二进制存在且版本可读）。"""
    try:
        r = subprocess.run(
            ["bash", "-lc", f'{_BOOT}; command -v dsh >/dev/null && dsh --version 2>/dev/null | head -1'],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def dsh_version() -> str:
    try:
        r = subprocess.run(
            ["bash", "-lc", f'{_BOOT}; dsh --version 2>/dev/null | head -1'],
            capture_output=True, text=True, timeout=30,
        )
        return r.stdout.strip() or ""
    except Exception:
        return ""


def run_headless(prompt: str, timeout: int = 150) -> str:
    """调用 DSH headless 执行一次独立任务，返回最终回复文本。

    - prompt 以单独 argv 传入（不经过 shell 拼接），避免注入；
    - 超时 / 凭证缺失 / 异常统一映射为 LLMError 分类。
    """
    key = api_key()
    if not key:
        raise LLMError("auth", "DeepSeek API Key 未配置，请到设置页「模型设置」填写后重试", 400)
    if not _KEY_RE.match(key):
        raise LLMError("auth", "API Key 格式异常，请到设置页检查", 400)
    script = (
        f'{_BOOT}; '
        f'export DEEPSEEK_API_KEY="{key}"; '
        f'dsh headless "$1"'
    )
    try:
        proc = subprocess.run(
            ["bash", "-lc", script, "dsh", prompt],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        logger.warning("dsh headless timeout len=%d", len(prompt))
        raise LLMError("timeout", "DSH 响应超时，请稍后重试（或检查 DeepSeek API 额度）", 504)
    except Exception as exc:  # noqa: BLE001
        logger.warning("dsh headless spawn failed: %s", exc)
        raise LLMError("network", "无法启动 DSH 服务，请确认 OrbStack 容器运行中", 502)

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        if "MISSING_CREDENTIAL" in out or "MISSING_CREDENTIAL" in err or "no API key" in err:
            raise LLMError("auth", "DSH 未获得 DeepSeek API Key，请到设置页填写", 400)
        logger.warning("dsh headless rc=%d err=%s", proc.returncode, err[:300])
        raise LLMError("unknown", "DSH 任务执行失败，请查看容器日志", 502)
    if not out:
        logger.warning("dsh headless empty output err=%s", err[:200])
        raise LLMError("unknown", "DSH 未返回内容，请重试", 502)
    return out


def build_context(project_filter: str | None = None) -> str:
    """从工作台（SQLite）构建给 DSH 的事实上下文：待办 / 会议 / 项目。"""
    from . import query_service
    todos, meetings = query_service._load_records()
    projects = []
    with db.get_conn() as conn:
        for r in conn.execute(
            "SELECT name, description, status FROM projects WHERE status='active' ORDER BY name"
        ).fetchall():
            projects.append(dict(r))
    lines = []
    lines.append(f"今天：{timex.now_local().strftime('%Y-%m-%d %H:%M %A')}")
    lines.append("项目：" + ("、".join(p["name"] for p in projects) if projects else "（无）"))
    lines.append("待办：")
    for t in todos:
        lines.append("- " + query_service._fmt_todo(t))
    lines.append("会议：")
    for m in meetings:
        lines.append("- " + query_service._fmt_meeting(m))
    return "\n".join(lines)


def health() -> dict:
    """设置页「测试 DSH」：DSH CLI + DeepSeek Key 配置状态。"""
    key_set = bool(api_key())
    ver = dsh_version()
    ok = bool(ver) and key_set
    detail = []
    if ver:
        detail.append(f"DSH {ver}")
    else:
        detail.append("DSH CLI 不可用（请确认 OrbStack 容器运行中）")
    detail.append("DeepSeek API Key 已配置" if key_set else "DeepSeek API Key 未配置（请到设置页填写）")
    return {
        "ok": ok,
        "dsh_version": ver,
        "deepseek_key_set": key_set,
        "detail": "；".join(detail),
    }
