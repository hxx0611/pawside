"""PawSide v0.4 end-to-end check.

Runs against a fake agent so the assertions are deterministic; the transport,
SSE parsing, storage and UI are all the real code paths.

Covers:
  * empty state: page card, real char/paragraph counts, permission counter
  * status pill from a live probe
  * summarize / translate through the real SSE client + markdown rendering
  * 繁简 conversion via the vendored OpenCC build
  * local history: save, new chat, restore
  * clip -> workspace mirror + bookmarks list
  * settings: theme switch, base URL, optional-permission list
  * form fill: scan -> proposal sheet -> per-field confirm -> values written,
    nothing submitted

Run:  xvfb-run -a python3 spike/test_v4.py
"""

from __future__ import annotations

import http.server
import json
import socketserver
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
WORKSPACE = ROOT.parent
PAGE_PORT = 8123
AGENT_PORT = 8124

ARTICLE = """<!doctype html><html><head><meta charset="utf-8">
<title>PawSide 测试文章 · 本地优先</title>
<meta name="description" content="spike fixture for pawside v4">
</head><body>
<nav>导航 首页 关于</nav>
<article>
<h1>Why local-first browser assistants win</h1>
<p>First: your data never leaves the machine. The model is chosen by you, so there is no account and no third-party custodian.</p>
<p>Second: the side panel only collects context, while the agent does the reasoning and tool calls. They talk over a local HTTP interface.</p>
</article>
<form action="#" method="post">
  <label>你的名字 <input name="name" type="text" /></label>
  <label>邮箱 <input name="email" type="email" /></label>
  <label>留言 <textarea name="message"></textarea></label>
  <button type="submit">提交</button>
</form>
<footer>copyright</footer>
</body></html>"""


def wait_js(page, expr: str, timeout_ms: int = 60000, interval: float = 0.35):
    """CSP-safe polling: extension pages can't use wait_for_function."""
    end = time.time() + timeout_ms / 1000
    last = None
    while time.time() < end:
        try:
            if page.evaluate(expr):
                return True
        except Exception as exc:  # page still loading
            last = exc
        time.sleep(interval)
    raise TimeoutError(f"condition not met ({last}): {expr[:120]}")


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = ARTICLE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def reply_for(prompt: str) -> str:
    if "表单填写建议" in prompt:
        return json.dumps(
            [
                {"idx": 0, "value": "张三", "why": "页面署名是张三"},
                {"idx": 1, "value": "zhangsan@example.com", "why": "文章里的联系邮箱"},
                {"idx": 2, "value": "想了解本地部署方案", "why": "结合文章主题"},
            ],
            ensure_ascii=False,
        )
    if "总结" in prompt:
        return (
            "## 一句话结论\n\n"
            "这是简体中文的总结：本地优先的浏览器助手把数据留在自己机器上。\n\n"
            "### 三个要点\n\n"
            "- **数据不出本机**，模型由你选择\n"
            "- 侧栏只负责收集上下文\n"
            "- 两者通过本地 HTTP 接口通信\n"
        )
    if "翻译" in prompt:
        return "## Translation\n\nLocal-first assistants keep your data on your own machine.\n\n- No account needed\n- The side panel only collects context"
    return "这是简体中文的回答：**重点** 有三条。\n\n- 第一条\n- 第二条\n- 第三条"


class FakeAgent(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/api/config/theme"):
            return self._json({"theme": "light"})
        if self.path.startswith("/api/agents"):
            return self._json({"agents": [{"id": "default", "name": "小蜗"}]})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if self.path.startswith("/api/workspace/file-upload"):
            Path("/tmp/pawside-upload-last.md").write_bytes(raw)
            return self._json({"ok": True, "filename": "pawside-clips.md"})
        if not self.path.startswith("/api/console/chat"):
            return self._json({"error": "not found"}, 404)

        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            payload = {}
        prompt = ""
        for item in payload.get("input") or []:
            for part in item.get("content") or []:
                prompt += part.get("text") or ""
        text = reply_for(prompt)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def send(obj):
            chunk = ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode()
            self.wfile.write(chunk)
            self.wfile.flush()

        send({"object": "message", "type": "message", "id": "m1", "role": "assistant"})
        # split into a few deltas so streaming is actually exercised
        step = max(1, len(text) // 4)
        for i in range(0, len(text), step):
            send({"type": "text", "msg_id": "m1", "delta": True, "text": text[i : i + step]})
            time.sleep(0.01)
        send(
            {
                "object": "response",
                "status": "completed",
                "output": [
                    {"role": "assistant", "content": [{"type": "text", "text": text}]}
                ],
            }
        )
        self.close_connection = True

    def log_message(self, *args):
        pass


def serve(port: int, handler) -> socketserver.TCPServer:
    socketserver.TCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def find_extension_id(ctx) -> str | None:
    page = ctx.new_page()
    page.goto("chrome://extensions/")
    time.sleep(1.5)
    items = page.evaluate(
        """() => {
          const m = document.querySelector('extensions-manager');
          const list = m && m.shadowRoot.querySelector('extensions-item-list');
          return list ? Array.from(list.shadowRoot.querySelectorAll('extensions-item'))
              .map(i => ({id: i.id, name: (i.shadowRoot.querySelector('#name')?.textContent || '').trim()})) : [];
        }"""
    )
    page.close()
    return next((i["id"] for i in items if i["name"] == "PawSide"), None)


def main() -> int:
    serve(PAGE_PORT, Fixture)
    serve(AGENT_PORT, FakeAgent)

    report: dict = {"extension": str(EXT), "checks": {}, "errors": []}
    ok = True

    def check(name: str, cond: bool, detail=None):
        nonlocal ok
        report["checks"][name] = {"ok": bool(cond), "detail": detail}
        if not cond:
            ok = False

    upload_file = Path("/tmp/pawside-upload-last.md")
    if upload_file.exists():
        upload_file.unlink()

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=f"/tmp/pawside-v4-{int(time.time())}",
            headless=False,
            executable_path="/usr/bin/chromium",
            viewport={"width": 380, "height": 800},
            args=[
                f"--disable-extensions-except={EXT}",
                f"--load-extension={EXT}",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        )
        try:
            ext_id = find_extension_id(ctx)
            report["extensionId"] = ext_id
            if not ext_id:
                print(json.dumps({**report, "error": "extension not loaded"}, ensure_ascii=False, indent=2))
                return 1

            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{PAGE_PORT}/", wait_until="domcontentloaded")

            panel = ctx.new_page()
            panel.on("pageerror", lambda e: report["errors"].append(str(e)))
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            wait_js(panel, "() => !!document.getElementById('pageTitle')", 10000)

            # point the panel at the fake agent and pin the fixture tab
            panel.evaluate(
                f"""async () => {{
                  const tabs = await chrome.tabs.query({{}});
                  const t = tabs.find(x => (x.url || '').includes('127.0.0.1:{PAGE_PORT}'));
                  await chrome.storage.local.set({{
                    baseUrl: 'http://127.0.0.1:{AGENT_PORT}',
                    agentId: 'default',
                    token: '',
                    sendContext: true,
                    lastTabId: t ? t.id : undefined,
                    clips: [],
                    threads: [],
                    theme: 'auto',
                  }});
                }}"""
            )
            panel.reload()
            wait_js(panel, "() => !!document.getElementById('pageTitle')", 10000)

            # ---------- empty state ----------
            wait_js(panel, "() => document.getElementById('pillText').textContent === '在线'", 20000)
            wait_js(panel, "() => (document.getElementById('metaChars').textContent || '0') !== '0'", 15000)
            report["checks"]["page"] = {
                "title": panel.inner_text("#pageTitle"),
                "chars": panel.inner_text("#metaChars"),
                "paras": panel.inner_text("#metaParas"),
                "permCount": panel.inner_text("#permCount"),
                "pill": panel.inner_text("#pillText"),
            }
            check("page title", "本地优先" in panel.inner_text("#pageTitle"))
            check("chars extracted", int(panel.inner_text("#metaChars").replace(",", "")) > 200)
            check("status pill", panel.inner_text("#pillText") == "在线")
            check("perm count is zero", panel.inner_text("#permCount") == "0")
            panel.screenshot(path=str(ROOT / "spike" / "v4-empty.png"))

            # ---------- summarize ----------
            panel.click('.tile[data-act="summary"]')
            wait_js(panel, "() => document.querySelectorAll('.msg.ai .ai').length > 0", 10000)
            wait_js(
                panel,
                "() => { const b = document.querySelector('.msg.ai .ai');"
                " return !!b && !b.querySelector('.pending'); }",
                30000,
            )
            summary = panel.inner_text(".msg.ai .ai")
            check("summary text", "本地优先" in summary, summary[:80])
            check("markdown rendered", panel.evaluate("() => document.querySelectorAll('.ai strong').length") > 0)
            check("toolbar visible", panel.is_visible("#toolbar"))
            panel.screenshot(path=str(ROOT / "spike" / "v4-thread.png"))

            # ---------- 繁简 ----------
            panel.click('.tool[data-act="fanti"]')
            wait_js(panel, "() => !document.getElementById('sheet').hidden", 5000)
            panel.click('[data-x="tw"]')
            wait_js(panel, "() => document.querySelector('.msg.ai .ai').textContent.includes('這是')", 8000)
            check("to traditional", "這是" in panel.inner_text(".msg.ai .ai"))

            panel.click('.tool[data-act="fanti"]')
            wait_js(panel, "() => !document.getElementById('sheet').hidden", 5000)
            panel.click('[data-x="cn"]')
            wait_js(panel, "() => document.querySelector('.msg.ai .ai').textContent.includes('这是')", 8000)
            check("back to simplified", "这是" in panel.inner_text(".msg.ai .ai"))

            # ---------- history ----------
            panel.click("#btnNew")
            wait_js(panel, "() => document.getElementById('v-empty').classList.contains('on')", 5000)
            panel.click("#btnHistory")
            wait_js(panel, "() => document.querySelectorAll('#historyList .thread-item').length > 0", 8000)
            check("history item", panel.locator("#historyList .thread-item").count() >= 1)
            panel.click("#historyList .thread-item")
            wait_js(panel, "() => document.querySelectorAll('#msgs .msg').length >= 2", 5000)
            check("history restores thread", panel.locator("#msgs .msg").count() >= 2)

            # ---------- clip + bookmarks ----------
            panel.click("#btnNew")
            wait_js(panel, "() => document.getElementById('v-empty').classList.contains('on')", 5000)
            panel.click('.tile[data-act="clip"]')
            wait_js(panel, "() => !document.getElementById('bookBadge').hidden", 20000)
            time.sleep(0.4)
            check("clip badge", panel.inner_text("#bookBadge") == "1")
            check(
                "workspace mirror uploaded",
                upload_file.exists() and "测试文章" in upload_file.read_text(errors="ignore"),
            )
            panel.click("#btnBook")
            wait_js(panel, "() => document.querySelectorAll('#bookList .book-item').length > 0", 5000)
            check("bookmark listed", panel.locator("#bookList .book-item").count() == 1)
            panel.screenshot(path=str(ROOT / "spike" / "v4-bookmarks.png"))
            panel.click("#backBtn")

            # ---------- settings ----------
            panel.click("#btnSettings")
            wait_js(panel, "() => document.getElementById('v-settings').classList.contains('on')", 5000)
            check("base url field", panel.input_value("#setBase") == f"http://127.0.0.1:{AGENT_PORT}")
            panel.click('#themeSeg [data-theme="dark"]')
            wait_js(panel, "() => document.documentElement.classList.contains('dark')", 5000)
            check("dark theme", panel.evaluate("() => document.documentElement.classList.contains('dark')"))
            check(
                "theme persisted",
                panel.evaluate("async () => (await chrome.storage.local.get('theme')).theme") == "dark",
            )
            panel.screenshot(path=str(ROOT / "spike" / "v4-settings-dark.png"))
            panel.click("#managePerms")
            wait_js(panel, "() => document.getElementById('v-perms').classList.contains('on')", 5000)
            check("perms empty state", "还没有授权的网站" in panel.inner_text("#siteList"))
            panel.click("#backBtn")
            panel.click('#themeSeg [data-theme="light"]')

            # ---------- form fill ----------
            panel.click("#btnNew")
            wait_js(panel, "() => document.getElementById('v-empty').classList.contains('on')", 5000)
            panel.click("#formQuick")
            wait_js(panel, "() => document.querySelectorAll('.ff-row').length >= 3", 30000)
            check("proposal rows", panel.locator(".ff-row").count() >= 3)
            panel.screenshot(path=str(ROOT / "spike" / "v4-form-sheet.png"))
            panel.click('[data-x="yes"]')
            wait_js(
                page,
                "() => document.querySelector('input[name=name]').value === '张三'"
                " && document.querySelector('input[name=email]').value === 'zhangsan@example.com'"
                " && document.querySelector('textarea[name=message]').value.length > 0",
                10000,
            )
            check("form filled", page.evaluate("() => document.querySelector('input[name=name]').value") == "张三")
            check("did not submit", page.evaluate("() => location.search === '' && document.querySelector('textarea[name=message]').value.length > 0"))

            # ---------- diagnostics ----------
            check("no page errors", len(report["errors"]) == 0, report["errors"])
        except Exception as exc:  # keep the partial report for debugging
            report["error"] = f"{type(exc).__name__}: {exc}"
            ok = False
        finally:
            ctx.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())