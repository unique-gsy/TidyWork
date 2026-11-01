"""端到端集成验证：真实 uvicorn 服务 + mock OpenAI 兼容服务，按验收标准跑四链路。

用法：python tests/e2e_check.py
输出：每步 PASS/FAIL 与总结。任何一步 FAIL 退出码 1。
"""
import base64
import struct
import subprocess
import sys
import time
from pathlib import Path

import httpx

WORKBENCH = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKBENCH / "backend"))
sys.path.insert(0, str(WORKBENCH))

APP_PORT = 18080
MOCK_PORT = 18081
BASE = f"http://127.0.0.1:{APP_PORT}"
MOCK = f"http://127.0.0.1:{MOCK_PORT}/v1"

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(f"{'PASS' if cond else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not cond else ""))


def wait_up(url, timeout=30):
    for _ in range(timeout * 10):
        try:
            httpx.get(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.1)
    return False


def main():
    procs = []
    # 1) mock OpenAI
    procs.append(subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "tests.mock_openai:app",
         "--host", "127.0.0.1", "--port", str(MOCK_PORT), "--log-level", "warning"],
        cwd=WORKBENCH))
    # 2) 应用本体（真实服务进程 + 已构建前端）
    import os
    env = {**os.environ,
           "WORKBENCH_DATA": "/tmp/wb-e2e-data",
           "WORKBENCH_RETRY_DELAYS": "0.2,0.2"}
    procs.append(subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(APP_PORT), "--log-level", "warning"],
        cwd=WORKBENCH / "backend", env=env))
    try:
        assert wait_up(f"http://127.0.0.1:{MOCK_PORT}/health"), "mock 未启动"
        assert wait_up(f"{BASE}/api/health"), "应用未启动"

        c = httpx.Client(base_url=BASE, timeout=30)

        # 验收 0：部署后浏览器可访问（入口 HTML 由后端托管）
        r = c.get("/")
        check("首页 HTML 可访问", r.status_code == 200 and "个人工作台" in r.text)
        r = c.get("/api/health")
        check("健康检查 ok", r.json()["status"] == "ok")

        # 验收 4：模型地址/密钥/模型名可配置可替换（分槽）
        r = c.put("/api/settings", json={
            "text": {"base_url": MOCK, "api_key": "sk-e2e-secret-1234", "model": "mock-text"},
            "vision": {"base_url": MOCK, "api_key": "sk-e2e-secret-1234", "model": "mock-vision"},
        })
        check("分槽配置保存", r.status_code == 200)
        s = c.get("/api/settings").json()
        check("密钥脱敏回显（不回明文）",
              "sk-e2e-secret-1234" not in str(s) and s["text"]["api_key_masked"].endswith("1234"))
        # 留空不变
        c.put("/api/settings", json={"text": {"base_url": MOCK, "model": "mock-text"}})
        s2 = c.get("/api/settings").json()
        check("密钥留空保持不变", s2["text"]["api_key_set"] is True)
        log = Path("/tmp/wb-e2e-data/logs/app.log")
        check("日志无明文密钥", log.exists() and "sk-e2e-secret-1234" not in log.read_text())

        # 验收 1a：一句话 → 解析确认卡片 → 落库为会议
        r = c.post("/api/parse", json={"text": "明天上午10点站会"})
        d = r.json()
        check("自然语言解析返回卡片数据", r.status_code == 200 and d["parse"]["intent"] == "meeting")
        check("相对时间已换算为绝对日期", d["parse"]["meeting"]["start_at"].endswith("T10:00:00"))
        r = c.post(f"/api/parse/{d['source_record_id']}/confirm", json={
            "destination": "meeting",
            "meeting": {"title": "站会", "start_at": d["parse"]["meeting"]["start_at"],
                        "participants": "风控组"}})
        check("确认落库为会议", r.status_code == 200 and r.json()["status"] == "planned")
        meetings = c.get("/api/meetings").json()
        check("会议出现在列表", any(m["title"] == "站会" for m in meetings))

        # 验收 1b：待办按项目分组管理
        pa = c.post("/api/projects", json={"name": "E2E项目A"}).json()
        pb = c.post("/api/projects", json={"name": "E2E项目B"}).json()
        c.post("/api/todos", json={"content": "A-需求梳理", "project_id": pa["id"]})
        c.post("/api/todos", json={"content": "B-数据核对", "project_id": pb["id"]})
        t = c.post("/api/todos", json={"content": "A-联调验证", "project_id": pa["id"]}).json()
        c.patch(f"/api/todos/{t['id']}", json={"status": "done"})
        todos = c.get("/api/todos").json()
        grouped = {}
        for x in todos:
            grouped.setdefault(x["project_name"], []).append(x)
        check("待办按项目分组可见",
              len(grouped.get("E2E项目A", [])) == 2 and len(grouped.get("E2E项目B", [])) == 1)
        # 归档/恢复（A7：不删除）
        r = c.patch(f"/api/projects/{pb['id']}", json={"status": "archived"})
        check("项目归档", r.status_code == 200)
        r = c.post("/api/todos", json={"content": "x", "project_id": pb["id"]})
        check("归档项目禁止新建待办", r.status_code == 409)
        r = c.patch(f"/api/projects/{pb['id']}", json={"status": "active"})
        check("项目恢复", r.status_code == 200)

        # 验收 1c：周报（有数据 / 模型摘要）
        stats0 = httpx.get(f"http://127.0.0.1:{MOCK_PORT}/stats").json()["count"]
        c.put("/api/settings", json={"text": {"model": "mock-summary"}})
        r = c.post("/api/reports/generate", json={})
        rep = r.json()
        check("周报草稿生成", r.status_code == 200 and rep["has_data"] is True)
        md = rep["content_markdown"]
        check("周报含本地数据事实", "A-需求梳理" in md and "站会" in md)
        check("周报含模型摘要", "整体进展顺利" in md)
        stats1 = httpx.get(f"http://127.0.0.1:{MOCK_PORT}/stats").json()["count"]
        check("摘要恰好一次模型调用", stats1 == stats0 + 1)
        # 导出
        r = c.get(f"/api/reports/{rep['id']}/export")
        check("Markdown 导出", r.status_code == 200 and "text/markdown" in r.headers["content-type"])
        # 空数据周（上周）不调模型不编造。注：「进行中」区块按设计包含全部未完成
        # 待办，故先把未完成待办收尾，使上周真正无数据（干净库场景另由 pytest 覆盖）
        from datetime import date, timedelta
        for x in c.get("/api/todos?status=open").json():
            c.patch(f"/api/todos/{x['id']}", json={"status": "done"})
        this_monday = date.today() - timedelta(days=date.today().weekday())
        last_monday = (this_monday - timedelta(days=7)).isoformat()
        stats2 = httpx.get(f"http://127.0.0.1:{MOCK_PORT}/stats").json()["count"]
        r = c.post("/api/reports/generate", json={"week_start": last_monday})
        check("空数据周占位不编造", r.json()["has_data"] is False and "本周暂无记录" in r.json()["content_markdown"])
        stats3 = httpx.get(f"http://127.0.0.1:{MOCK_PORT}/stats").json()["count"]
        check("空数据周不调用模型", stats3 == stats2)

        # 验收 1d：图片上传识别 + 多模态不可用降级
        png = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
               + struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
               + b"\x00\x00\x00\x00IEND\xaeB`\x82" + b"\x00" * 2048)
        r = c.post("/api/images",
                   files={"file": ("board.png", png, "image/png")},
                   data={"note": "白板待办"})
        up = r.json()
        check("图片上传（存图与识别解耦）", r.status_code == 200 and up["image_id"] >= 1)
        r = c.post(f"/api/images/{up['image_id']}/recognize")
        d = r.json()
        check("图片识别成功", r.status_code == 200 and "季度评审材料" in d["recognized_text"])
        r = c.post(f"/api/parse/{d['source_record_id']}/confirm", json={
            "destination": "todo", "todo": {"content": d["suggested"]["todo"]["content"]}})
        check("识别结果确认落库为待办", r.status_code == 200)
        # 多模态不可用降级
        c.put("/api/settings", json={"vision": {"model": "mock-unsupported-vision"}})
        up2 = c.post("/api/images", files={"file": ("x.png", png, "image/png")},
                     data={"note": ""}).json()
        r = c.post(f"/api/images/{up2['image_id']}/recognize")
        check("多模态不可用降级（422 且图片保留）",
              r.status_code == 422 and r.json()["detail"]["category"] == "vision_unsupported")
        check("降级后文本功能不受影响",
              c.post("/api/parse", json={"text": "明天上午10点站会"}).status_code == 200)

        # 备份
        r = c.post("/api/backup")
        check("手动备份生成", r.status_code == 200 and r.json()["file"].endswith(".zip"))
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()

    failed = [n for n, ok, _ in results if not ok]
    print(f"\n==== E2E 总结：{len(results) - len(failed)}/{len(results)} 通过 ====")
    if failed:
        print("失败项：", failed)
        sys.exit(1)


if __name__ == "__main__":
    main()
