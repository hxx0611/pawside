"""PawSide v0.3.1 — page-relay check.

Reproduces the field report: a hosted instance whose gateway answers every
cross-origin POST with an Apache 403 HTML page while GETs are fine. The panel
must fall back to issuing the request inside a tab on the instance's own origin
(same-origin, like the web console) and still stream the answer.

Run:  xvfb-run -a python3 spike/test_relay.py
"""

from __future__ import annotations

import http.server
import json
import socketserver
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
INSTANCE_PORT = 8902
ARTICLE_PORT = 8124
GOOD = "tok-relay-42"
ANSWER = "中转链路可用：这是一段通过实例页面回传的回答。"

APACHE_403 = """<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>403 Forbidden</title>
</head><body>
<center><h1>403 Forbidden</h1></center>
<hr><center>Apache/2.4.41</center>
</body></html>
"""

SSE = "".join(
    [
        'data: {"object":"message","type":"message","id":"m1"}\n\n',
        f'data: {json.dumps({"type": "text", "text": ANSWER[:8], "delta": True, "msg_id": "m1"})}\n\n',
        f'data: {json.dumps({"type": "text", "text": ANSWER[8:], "delta": True, "msg_id": "m1"})}\n\n',
        'data: {"object":"response","status":"completed","output":[{"role":"assistant",'
        f'"content":[{{"type":"text","text":"{ANSWER}"}}]}}]}}\n\n',
    ]
).encode()

ARTICLE = """<!doctype html><html><head><meta charset="utf-8"><title>PawSide 中转测试</title>
</head><body><article><h1>Relay me</h1>
<p>第一段：网关只放行同源请求，所以扩展必须在实例自己的页面里发起这一次调用。</p>
<p>第二段：侧栏保持流式输出，用户看不出中转这件事。</p>
</article></body></html>"""

STATE = {"chat_posts": 0, "blocked": 0, "uploads": 0, "same_origin_posts": 0}


def _server(port: int, handler):
    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = True

    httpd = Server(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def serve_article():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = ARTICLE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return _server(ARTICLE_PORT, Handler)


def serve_instance():
    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authed(self) -> bool:
            return self.headers.get("Authorization") == f"Bearer {GOOD}"

        @property
        def _same_origin(self) -> bool:
            # What an origin-locked gateway looks at in practice.
            return (self.headers.get("Sec-Fetch-Site") or "") in ("same-origin", "")

        def do_GET(self):  # noqa: N802
            if self.path == "/api/config/theme":
                self._send(200, b'{"mode":"light"}', "application/json")
            elif self.path == "/api/agents":
                if not self._authed():
                    self._send(401, b'{"detail":"Unauthorized"}', "application/json")
                    return
                agents = [{"id": "default", "name": "小蜗"}, {"id": "qa", "name": "QA Agent"}]
                self._send(200, json.dumps({"agents": agents}).encode(), "application/json")
            elif self.path in ("/", "/index.html"):
                page = f"""<!doctype html><html><head><meta charset="utf-8"><title>Mock QwenPaw</title>
</head><body><h1>Mock QwenPaw console</h1>
<script>localStorage.setItem("qwenpaw_auth_token", "{GOOD}");</script></body></html>"""
                self._send(200, page.encode(), "text/html; charset=utf-8")
            else:
                self._send(404, b'{"detail":"Not Found"}', "application/json")

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            cross = not self._same_origin
            if cross:
                STATE["blocked"] += 1
                self._send(403, APACHE_403.encode(), "text/html")
                return
            STATE["same_origin_posts"] += 1
            if not self._authed():
                self._send(401, b'{"detail":"Unauthorized"}', "application/json")
                return
            if self.path == "/api/console/chat":
                STATE["chat_posts"] += 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(SSE)))
                self.end_headers()
                self.wfile.write(SSE)
            elif self.path.startswith("/api/workspace/file-upload"):
                STATE["uploads"] += 1
                self._send(200, b'{"ok":true}', "application/json")
            else:
                self._send(404, b'{"detail":"Not Found"}', "application/json")

        def log_message(self, *args):
            pass

    return _server(INSTANCE_PORT, Handler)


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


def answer_done(n: int) -> str:
    return (
        "() => { const nodes = document.querySelectorAll('.msg.assistant');"
        f" if (nodes.length <= {n}) return false;"
        " return nodes[nodes.length - 1].dataset.done === '1'; }"
    )


def main() -> int:
    art = serve_article()
    inst = serve_instance()
    report: dict = {"instance": f"http://127.0.0.1:{INSTANCE_PORT}"}
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=f"/tmp/pawside-relay-{int(time.time())}",
                headless=False,
                executable_path="/usr/bin/chromium",
                args=[
                    f"--disable-extensions-except={EXT}",
                    f"--load-extension={EXT}",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                ],
            )
            ext_id = find_extension_id(ctx)
            report["extensionId"] = ext_id
            if not ext_id:
                print(json.dumps({**report, "error": "not loaded"}, ensure_ascii=False, indent=2))
                return 1

            article = ctx.new_page()
            article.goto(f"http://127.0.0.1:{ARTICLE_PORT}/", wait_until="domcontentloaded")

            panel = ctx.new_page()
            errors: list[str] = []
            panel.on("pageerror", lambda e: errors.append(str(e)))
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            wait_js(panel, "() => document.getElementById('baseUrl') !== null", 10000)

            panel.evaluate("() => document.getElementById('settings').classList.remove('hidden')")
            panel.fill("#baseUrl", f"http://127.0.0.1:{INSTANCE_PORT}")
            panel.evaluate("() => { document.getElementById('otherAuth').open = true; }")
            panel.fill("#token", GOOD)
            panel.click("#save")
            wait_js(
                panel,
                "() => (document.getElementById('probe').textContent || '').includes('已连接')",
                20000,
            )
            report["probe"] = panel.inner_text("#probe")
            report["tabs_before"] = panel.evaluate(
                f"""async () => (await chrome.tabs.query({{}}))
                    .filter(t => (t.url||'').startsWith('http://127.0.0.1:{INSTANCE_PORT}')).length"""
            )

            panel.evaluate(
                """async () => {
                  const tabs = await chrome.tabs.query({});
                  const t = tabs.find(x => (x.url || '').includes('8124'));
                  await chrome.storage.local.set({ lastTabId: t.id });
                }"""
            )

            # --- summarize: direct POST is blocked, relay must carry it
            before = panel.locator(".msg.assistant").count()
            panel.evaluate("() => document.querySelector('#summarize').click()")
            try:
                wait_js(panel, answer_done(before), 60000)
            except TimeoutError:
                report["DIAG"] = {
                    "messages": panel.evaluate(
                        "() => [...document.querySelectorAll('.msg')].map(n => n.className + '|' + n.textContent.slice(0,120))"
                    ),
                    "lastTabId": panel.evaluate("async () => (await chrome.storage.local.get('lastTabId')).lastTabId"),
                    "tabs": panel.evaluate("async () => (await chrome.tabs.query({})).map(t => [t.id, t.url])"),
                    "pageErrors": errors,
                    "state": dict(STATE),
                }
                print(json.dumps({**report, "PASS": False}, ensure_ascii=False, indent=2))
                return 1
            first = panel.locator(".msg.assistant").last.inner_text()
            report["answer1"] = first[:80]
            report["answer1_ok"] = ANSWER in first
            report["metas"] = panel.evaluate(
                "() => [...document.querySelectorAll('.msg.meta, .msg')].map(n => n.className + '|' + n.textContent)"
            )
            report["tabs_after"] = panel.evaluate(
                f"""async () => (await chrome.tabs.query({{}}))
                    .filter(t => (t.url||'').startsWith('http://127.0.0.1:{INSTANCE_PORT}')).map(t => !!t.active)"""
            )
            report["storage"] = panel.evaluate("async () => (await chrome.storage.local.get('relayFor')).relayFor")

            # --- second turn: the memo must skip the doomed direct attempt
            blocked_before = STATE["blocked"]
            before2 = panel.locator(".msg.assistant").count()
            panel.fill("#input", "再说一次")
            panel.evaluate("() => document.querySelector('#send').click()")
            wait_js(panel, answer_done(before2), 60000)
            report["answer2_ok"] = ANSWER in panel.locator(".msg.assistant").last.inner_text()
            report["blocked_retries_saved"] = STATE["blocked"] == blocked_before

            # --- clip upload also survives the gateway
            panel.evaluate("() => document.querySelector('#clipPage').click()")
            wait_js(
                panel,
                "() => [...document.querySelectorAll('.msg')].some(n => n.textContent.includes('已收藏'))",
                40000,
            )
            report["uploads"] = STATE["uploads"]
            report["clip_msg"] = panel.evaluate(
                "() => [...document.querySelectorAll('.msg')].map(n => n.textContent)"
                ".filter(t => t.includes('已收藏')).slice(-1)[0]"
            )

            report["state"] = dict(STATE)
            report["pageErrors"] = errors
            panel.evaluate("() => document.getElementById('settings').classList.add('hidden')")
            time.sleep(0.4)
            panel.screenshot(path=str(ROOT / "spike" / "panel-relay.png"), full_page=True)
            ctx.close()
    finally:
        art.shutdown()
        inst.shutdown()

    ok = (
        report.get("answer1_ok")
        and report.get("answer2_ok")
        and report.get("blocked_retries_saved")
        and report.get("uploads", 0) >= 1
        and report.get("tabs_before") == 0
        and report.get("tabs_after") == [False]
        and report.get("storage") == f"http://127.0.0.1:{INSTANCE_PORT}"
        and any("只放行" in m for m in report.get("metas", []))
        and not report.get("pageErrors")
    )
    report["PASS"] = bool(ok)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())