"""DSH（DeepSeek Harness）接入层：headless agent 调用。

- 双容器部署：`dsh headless` 只在 DSH 容器内执行——TidyWork 经 docker socket
  调用 `docker exec DSH` 触发（compose 已挂载 /var/run/docker.sock），
  DeepSeek API Key 与技能（/root/.dsh/skills）都留在 DSH 容器侧，
  TidyWork 不保存、不接触 Key，也不注入该环境变量；
- 错误分类与 llm.py 一致（auth/network/timeout/unknown），message 可直接展示给用户；
- DSH 可随时升级：本层只依赖 `dsh headless` CLI 约定，不依赖其内部 npm 包结构。
"""
import logging
import subprocess

from .. import db, timex
from ..llm import LLMError

logger = logging.getLogger("workbench.dsh")

# 在 DSH 容器内执行 dsh CLI：DSH 为 node:22 镜像，dsh 全局安装于 /usr/local/bin，
# 无 nvm；cd ~ 仅为 headless 交互时的工作目录保持一致。
_BOOT = "cd ~"
_DSH_CONTAINER = "DSH"


def dsh_available() -> bool:
    """DSH 容器内 dsh CLI 是否可用。"""
    try:
        r = subprocess.run(
            ["docker", "exec", _DSH_CONTAINER, "bash", "-lc",
             f'{_BOOT}; command -v dsh >/dev/null && dsh --version 2>/dev/null | head -1'],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode == 0 and bool(r.stdout.strip())
    except Exception:
        return False


def dsh_version() -> str:
    try:
        r = subprocess.run(
            ["docker", "exec", _DSH_CONTAINER, "bash", "-lc",
             f'{_BOOT}; dsh --version 2>/dev/null | head -1'],
            capture_output=True, text=True, timeout=30,
        )
        return r.stdout.strip() or ""
    except Exception:
        return ""


def run_headless(prompt: str, timeout: int = 150) -> str:
    """调用 DSH headless 执行一次独立任务，返回最终回复文本。

    - prompt 以单独 argv 传入（不经过 shell 拼接），避免注入；
    - DeepSeek API Key 由 DSH 容器环境提供（DEEPSEEK_API_KEY），本层不再读取/注入；
    - 超时 / 凭证缺失 / 异常统一映射为 LLMError 分类。
    """
    script = f'{_BOOT}; dsh headless "$1"'
    try:
        proc = subprocess.run(
            ["docker", "exec", _DSH_CONTAINER, "bash", "-lc", script, "dsh", prompt],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        logger.warning("dsh headless timeout len=%d", len(prompt))
        raise LLMError("timeout", "DSH 响应超时，请稍后重试（或检查 DeepSeek API 额度）", 504)
    except Exception as exc:  # noqa: BLE001
        logger.warning("dsh headless spawn failed: %s", exc)
        raise LLMError("network", "无法启动 DSH 服务，请确认 DSH 容器运行中", 502)

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        if "MISSING_CREDENTIAL" in out or "MISSING_CREDENTIAL" in err or "no API key" in err:
            raise LLMError(
                "auth",
                "DSH 未配置 DeepSeek API Key：请在宿主机 docker/.env 设置 DEEPSEEK_API_KEY 后重建 DSH 容器",
                400)
        logger.warning("dsh headless rc=%d err=%s", proc.returncode, err[:300])
        raise LLMError("unknown", "DSH 任务执行失败，请查看容器日志", 502)
    if not out:
        logger.warning("dsh headless empty output err=%s", err[:200])
        raise LLMError("unknown", "DSH 未返回内容，请重试", 502)
    return out


def build_context(project_filter: str | None = None) -> str:
    """从工作台（SQLite）构建给 DSH 的事实上下文：待办 / 会议 / 项目。"""
    with db.get_conn() as conn:
        todos = [
            dict(r) for r in conn.execute(
                "SELECT t.id, t.content, t.due_date, t.status, p.name AS project_name "
                "FROM todos t LEFT JOIN projects p ON p.id = t.project_id "
                "ORDER BY t.status, t.due_date IS NULL, t.due_date, t.id DESC"
            ).fetchall()
        ]
        meetings = [
            dict(r) for r in conn.execute(
                "SELECT id, title, start_at, participants, location, status "
                "FROM meetings ORDER BY start_at IS NULL, start_at, id DESC"
            ).fetchall()
        ]
        projects = [
            dict(r) for r in conn.execute(
                "SELECT name, description, status FROM projects WHERE status='active' ORDER BY name"
            ).fetchall()
        ]

    def fmt_todo(t: dict) -> str:
        due = t.get("due_date") or "无截止"
        proj = t.get("project_name") or "未归属"
        return f"[id={t['id']}][{t['status']}] 截止{due} | {proj} | {t['content']}"

    def fmt_meeting(m: dict) -> str:
        local = timex.utc_to_local_str(m["start_at"]) if m.get("start_at") else ""
        return f"[id={m['id']}][{m['status']}] {local or '时间待补'} | {m['title']}"

    lines = []
    lines.append(f"今天：{timex.now_local().strftime('%Y-%m-%d %H:%M %A')}")
    lines.append("项目：" + ("、".join(p["name"] for p in projects) if projects else "（无）"))
    if todos:
        lines.append("待办：")
        lines.extend("- " + fmt_todo(t) for t in todos)
    else:
        lines.append("待办：（无）")
    if meetings:
        lines.append("会议：")
        lines.extend("- " + fmt_meeting(m) for m in meetings)
    else:
        lines.append("会议：（无）")
    return "\n".join(lines)


def health() -> dict:
    """DSH 连通性检查：DSH CLI 可用即视为正常（Key 配置在 DSH 容器侧）。"""
    ver = dsh_version()
    ok = bool(ver)
    detail = []
    if ver:
        detail.append(f"DSH {ver}")
    else:
        detail.append("DSH CLI 不可用（请确认 DSH 容器运行中）")
    detail.append("DeepSeek API Key 配置在 DSH 容器侧（宿主机 .env 的 DEEPSEEK_API_KEY）")
    return {
        "ok": ok,
        "dsh_version": ver,
        "deepseek_key_set": None,
        "detail": "；".join(detail),
    }
