"""PawSide v0.4.1 check —— 版本检查 + 弹层里 toast 不再挡住「填入」。

只有两个改动点，所以只验这两条，其余回归靠 test_v4.py。

Run:  xvfb-run -a python3 spike/test_v5.py
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
PAGE_PORT = 8131
AGENT_PORT = 8132
RELEASE_URL = "https://github.com/hxx0611/pawside/releases/tag/v9.9.9"

PAGE_HTML = """<!doctype html><html><head><meta charset="utf-8">
<title>版本检查用页面</title></head><body>
<article><h1>Local-first</h1>
<p>这一页只用来触发一次填表流程，正文有几百字方便面板统计。</p>
<p>第二段：侧栏负责收集上下文，真正的推理发生在你自己的 agent 里。</p>
<p>第三段：一切都走本机 127.0.0.1，没有第三方服务器参与。</p></article>
<form action="#" method="post">
  <label>你的名字 <input name="name" type="text" /></label>
  <label>邮箱 <input name="email" type="email" /></label>
  <label>留言 <textarea name="message"></textarea></label>
  <button type="submit">提交</button>
</form>
</body></html>"""


def wait_js(page, expr: str, timeout_ms: int = 30000, interval: float = 0.3):
    end = time.time() + timeout_ms / 1000
    last = None
    while time.time() < end:
        try:
            if page.evaluate(expr):
                return True
        except Exception as exc:
            last = exc
        time.sleep(interval)
    raise TimeoutError(f"condition not met ({last}): {expr[:120]}")


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        body = PAGE_HTML.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


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
            return self._json({"ok": True})
        if not self.path.startswith("/api/console/chat"):
            return self._json({"error": "not found"}, 404)

        text = json.dumps(
            [
                {"idx": 0, "value": "张三", "why": "页面署名"},
                {"idx": 1, "value": "zhangsan@example.com", "why": "文章里的邮箱"},
                {"idx": 2, "value": "想了解本地部署", "why": "结合主题"},
            ],
            ensure_ascii=False,
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def send(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode())
            self.wfile.flush()

        send({"object": "message", "type": "message", "id": "m1", "role": "assistant"})
        send({"type": "text", "msg_id": "m1", "delta": True, "text": text})
        send({"object": "response", "status": "completed", "output": [{"role": "assistant", "content": [{"type": "text", "text": text}]}]})
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

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=f"/tmp/pawside-v5-{int(time.time())}",
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

        # 假 GitHub：接口返回 v9.9.9，Release 页返回一段极简 HTML
        release = {"tag": "v9.9.9"}

        def github(route):
            url = route.request.url
            if "api.github.com" in url:
                return route.fulfill(
                    status=200,
                    content_type="application/json",
                    body=json.dumps(
                        {
                            "tag_name": release["tag"],
                            "html_url": f"https://github.com/hxx0611/pawside/releases/tag/{release['tag']}",
                            "body": "## 改了什么\n- 版本检查\n- 弹层里的提示不再挡按钮",
                        },
                        ensure_ascii=False,
                    ),
                )
            return route.fulfill(status=200, content_type="text/html", body="<h1>release page</h1>")

        ctx.route("https://api.github.com/**", github)
        ctx.route("https://github.com/**", github)

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

            panel.evaluate(
                f"""async () => {{
                  const tabs = await chrome.tabs.query({{}});
                  const t = tabs.find(x => (x.url || '').includes('127.0.0.1:{PAGE_PORT}'));
                  await chrome.storage.local.set({{
                    baseUrl: 'http://127.0.0.1:{AGENT_PORT}',
                    agentId: 'default', token: '', sendContext: true,
                    lastTabId: t ? t.id : undefined,
                    clips: [], threads: [], theme: 'auto',
                  }});
                  await chrome.storage.local.remove('update.checked');
                }}"""
            )
            panel.reload()
            wait_js(panel, "() => !!document.getElementById('pageTitle')", 10000)
            wait_js(panel, "() => document.getElementById('pillText').textContent === '在线'", 20000)

            # ---------- 1. 有新版本 → 设置页出提示 ----------
            panel.click("#btnSettings")
            wait_js(panel, "() => document.getElementById('v-settings').classList.contains('on')", 5000)
            wait_js(panel, "() => !document.getElementById('updRow').hidden", 20000)
            title = panel.inner_text("#updTitle")
            check("newer version detected", "9.9.9" in title, title)
            check("update button label", "去更新" in panel.inner_text("#btnUpdate"))
            check("gear shows a dot", panel.evaluate("() => document.getElementById('btnSettings').classList.contains('dot')"))
            panel.evaluate("() => document.getElementById('updRow').scrollIntoView({block: 'center'})")
            time.sleep(0.3)
            panel.screenshot(path=str(ROOT / "spike" / "v5-update.png"))

            # ---------- 2. 点「去更新」开 Release 页 ----------
            with ctx.expect_page(timeout=10000) as new_page_info:
                panel.click("#btnUpdate")
            rel = new_page_info.value
            rel.wait_for_load_state("domcontentloaded")
            check("release page opened", "releases/tag/v9.9.9" in rel.url, rel.url)
            rel.close()

            # ---------- 3. 已是最新 → 不出现，文案说清楚 ----------
            release["tag"] = "v0.4.1"
            panel.evaluate("async () => chrome.storage.local.remove('update.checked')")
            panel.click("#checkUpdate")
            wait_js(panel, "() => document.getElementById('checkUpdate').textContent.includes('已是最新')", 20000)
            check("up-to-date hides row", panel.evaluate("() => document.getElementById('updRow').hidden"))
            check("up-to-date label", "已是最新" in panel.inner_text("#checkUpdate"), panel.inner_text("#checkUpdate"))
            check("dot cleared", not panel.evaluate("() => document.getElementById('btnSettings').classList.contains('dot')"))

            # ---------- 4. 弹层在场时 toast 让位给「填入」 ----------
            release["tag"] = "v9.9.9"
            panel.evaluate("async () => chrome.storage.local.remove('update.checked')")
            panel.click("#backBtn")
            wait_js(panel, "() => document.getElementById('v-empty').classList.contains('on')", 5000)
            panel.evaluate("() => document.getElementById('formQuick').scrollIntoView({block: 'center'})")
            time.sleep(0.3)
            panel.click("#formQuick")
            try:
                wait_js(panel, "() => document.querySelectorAll('.ff-row').length >= 3", 45000)
            except TimeoutError:
                report["formFailState"] = panel.evaluate(
                    """() => ({
                      view: document.querySelector('.view.on')?.id,
                      toast: document.getElementById('toast').textContent,
                      quickVisible: !!document.getElementById('formQuick')?.offsetParent,
                      tab: document.getElementById('pageUrl')?.textContent,
                    })"""
                )
                raise
            open_state = panel.evaluate(
                """() => {
                  const toast = document.getElementById('toast');
                  const rect = toast.getBoundingClientRect();
                  const btn = document.querySelector('[data-x="yes"]');
                  const b = btn.getBoundingClientRect();
                  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                  return {
                    sheetOpen: document.body.classList.contains('sheet-open'),
                    toastTop: Math.round(rect.top),
                    toastOn: toast.classList.contains('on'),
                    btnHit: !!hit && (hit === btn || btn.contains(hit) || hit.closest('[data-x="yes"]') !== null),
                  };
                }"""
            )
            report["sheetToast"] = open_state
            check("sheet marks body", open_state["sheetOpen"])
            check("toast moved to top", open_state["toastTop"] < 90, open_state["toastTop"])
            check("confirm button is clickable", open_state["btnHit"])
            panel.screenshot(path=str(ROOT / "spike" / "v5-sheet-toast.png"))

            panel.click('[data-x="yes"]')
            wait_js(page, "() => document.querySelector('input[name=name]').value === '张三'", 10000)
            check("form still fills", page.evaluate("() => document.querySelector('input[name=name]').value") == "张三")
            check("sheet-open cleared", not panel.evaluate("() => document.body.classList.contains('sheet-open')"))

            check("no page errors", len(report["errors"]) == 0, report["errors"])
        except Exception as exc:
            report["error"] = f"{type(exc).__name__}: {exc}"
            ok = False
        finally:
            ctx.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())