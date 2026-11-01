"""DSH Web 反向代理：token 解析、cookie 会话、HTML 注入「切回方寸」脚本。

- DSH Web 鉴权：URL 携带 ?token=xxx 访问首页 → 303 并下发 dsh-auth-* cookie（30 天）；
  静态资源（assets/*）免鉴权。本模块持有一个带 cookie jar 的 httpx 客户端完成会话。
- HTML 注入：在入口页面追加一段脚本，轮询匹配 DSH 右上角图标并绑定点击 →
  parent.postMessage({type:'dsh-back'})，方寸外壳收到后切回；Esc 键兜底。
- 不改 DSH 前端任何文件，DSH 升级后仅需重新验证选择器（有 Esc 兜底）。
"""
import logging
import os
import re
import subprocess

import httpx

logger = logging.getLogger("workbench.dshweb")

# 可经环境变量覆盖（Docker 部署时指向 dsh 服务名/共享日志卷；默认值保持本地 TidyWork 行为不变）
_WEB_BASE = os.environ.get("DSH_WEB_BASE", "http://127.0.0.1:3080")
_TOKEN_RE = re.compile(r"https?://[^ ]*\?token=([A-Za-z0-9_\-]+)")
_AUTH_COOKIE_PREFIX = "dsh-auth-"
_LOG_PATH = os.environ.get("DSH_LOG_PATH", "/home/guosy/dsh-web.log")

_client: httpx.AsyncClient | None = None

INJECT_SCRIPT = """<script>
(function(){
  function backToTidyWork(){
    try{ parent.postMessage({type:'dsh-back'},'*'); }catch(e){}
  }
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') backToTidyWork(); });
  var lastBound=null;
  // 无限轮询：DSH 为 SPA，图标可能在后续页面才出现；元素变化时自动重绑
  setInterval(function(){
    var vw=window.innerWidth, best=null;
    var els=document.querySelectorAll('button,[role="button"],a');
    for(var i=0;i<els.length;i++){
      var el=els[i], r=el.getBoundingClientRect();
      if(r.width===0||r.height===0) continue;
      if(r.right>vw*0.72 && r.top<90 && r.bottom<150 && r.right<=vw+1){
        if(!best || r.right>best.r.right) best={el:el,r:r};
      }
    }
    if(best){
      if(best.el!==lastBound){
        if(lastBound){ lastBound.removeEventListener('click',backToTidyWork); }
        best.el.addEventListener('click',backToTidyWork);
        best.el.style.cursor='pointer';
        best.el.title='回到 TidyWork (Esc)';
        lastBound=best.el;
      }
    }
  },500);
})();
</script>"""


def token_from_log() -> str:
    """从 dsh web 日志解析当前 token（每次启动变化）。"""
    try:
        txt = open(_LOG_PATH, encoding="utf-8", errors="ignore").read()
        found = _TOKEN_RE.findall(txt)
        if found:
            return found[-1]  # 日志为 append，取最后一次启动的 token
    except Exception:
        pass
    try:
        r = subprocess.run(
            ["bash", "-lc",
             "sudo journalctl -u dsh-web -n 500 --no-pager 2>/dev/null | grep -oE '\\?token=[A-Za-z0-9_\\-]+' | tail -1"],
            capture_output=True, text=True, timeout=15,
        )
        m = re.search(r"token=([A-Za-z0-9_\-]+)", r.stdout or "")
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=_WEB_BASE, follow_redirects=True, timeout=20.0)
    return _client


def _has_auth_cookie(c: httpx.AsyncClient) -> bool:
    return any(k.startswith(_AUTH_COOKIE_PREFIX) for k in c.cookies.keys())


def auth_cookie_header() -> str:
    """导出 httpx 会话持有的 cookie 串（供 WebSocket 握手转发）。"""
    c = _get_client()
    return "; ".join(f"{k}={v}" for k, v in c.cookies.items())


async def ensure_auth() -> None:
    """用 token 换取 dsh-auth cookie；已持有则跳过。"""
    c = _get_client()
    if _has_auth_cookie(c):
        return
    tok = token_from_log()
    if not tok:
        raise RuntimeError("DSH token 解析失败（DSH Web 可能未启动）")
    await c.get("/", params={"token": tok})  # 303 -> Set-Cookie -> 200
    if not _has_auth_cookie(c):
        logger.warning("dsh auth exchange ok but no cookie present")


async def proxy(
    path: str, method: str, raw_query: str | None, body: bytes | None, headers: dict | None
) -> tuple[int, dict, bytes]:
    """转发到 DSH Web；入口 HTML 追加注入脚本。raw_query 为原始 query 字符串（原样透传）。"""
    c = _get_client()
    url = "/" + path
    if raw_query:
        url += "?" + raw_query
    try:
        await ensure_auth()
        resp = await c.request(method, url, content=body, headers=headers or None)
    except Exception as exc:  # noqa: BLE001
        logger.warning("dsh proxy failed path=%s err=%s", path, exc)
        return 502, {"content-type": "text/plain; charset=utf-8"}, "DSH 代理失败：请确认 DSH Web 已启动（sudo systemctl restart dsh-web）".encode("utf-8")

    ctype = resp.headers.get("content-type", "")
    out = resp.content
    is_entry = (path == "" or path == "index.html") and "text/html" in ctype
    if is_entry:
        out = out.replace(b"</body>", INJECT_SCRIPT.encode("utf-8") + b"</body>", 1)

    hdrs = {
        k: v for k, v in resp.headers.items()
        if k.lower() not in ("content-length", "set-cookie", "content-encoding", "transfer-encoding")
    }
    if is_entry:
        hdrs["content-type"] = "text/html; charset=utf-8"
    return resp.status_code, hdrs, out
