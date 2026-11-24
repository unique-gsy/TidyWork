#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TidyWorky 邮箱模块 - 统一启动入口（对标京东 scripts/run.sh）。

用法（在技能包根目录）：
    python scripts/run.py <子命令> [参数]
例如：
    python scripts/run.py self-check
    python scripts/run.py search --folder inbox --unread

A 阶段只依赖 Python 标准库（imaplib/smtplib/email），无需安装第三方包。
B 阶段（CalDAV 日程）才需要 caldav 第三方库。
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
os.chdir(SCRIPT_DIR)

# 无论宿主控制台/管道编码为何（Windows 常见 GBK），统一按 UTF-8 输出，
# 避免中文与 Markdown emoji 在 print 时触发 UnicodeEncodeError。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

REQUIRED_STDLIB = ["imaplib", "smtplib", "email", "argparse", "configparser", "zoneinfo"]


def _fail(message: str, code: str = "ENV_ERROR") -> None:
    import json
    print(json.dumps({"success": False, "error_code": code, "error": message},
                     ensure_ascii=False))
    sys.exit(1)


def ensure_runtime() -> None:
    if sys.version_info < (3, 9):
        _fail(f"需要 Python 3.9 及以上版本，当前为 {sys.version.split()[0]}。", "PYTHON_TOO_OLD")
    missing = [name for name in REQUIRED_STDLIB if importlib.util.find_spec(name) is None]
    if missing:
        _fail("当前 Python 缺少标准库模块：" + "、".join(missing) + "，请使用完整 Python 安装。",
              "MISSING_STDLIB")


def main() -> None:
    ensure_runtime()
    try:
        import qqmail_cli
    except ImportError as exc:
        _fail(f"无法加载 qqmail_cli（请确认在 scripts/ 目录运行）：{exc}", "IMPORT_FAILED")
        return
    qqmail_cli.main()


if __name__ == "__main__":
    main()
