"""PawSide v0.3 connection-wizard check.

Reproduces the exact situation from the field report: a hosted instance whose
gateway answers POST /api/auth/login with an Apache 403 HTML page, while public
GET endpoints still work. Asserts that

  1. step 1 diagnoses "reachable but needs authorization" (not a false green),
  2. the account->token path surfaces a human sentence, never raw HTML,
  3. a token makes the panel green and step 3 auto-fills the agent list,
  4. no page errors.

Run:  xvfb-run -a python3 spike/test_wizard.py
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
MOCK_PORT = 8901
GOOD = "tok-live-42"

APACHE_403 = """<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">
<html><head>
<title>403 Forbidden</title>
</head><body>
<h1>Forbidden</h1>
<p>You don't have permission to access this resource.</p>
</body></html>
"""

SSE = (
    'data: {"type":"text","text":"ok"}\n\n'
    'data: {"type":"done"}\n\n'
).encode()


def serve_mock() -> socketserver.TCPServer:
    socketserver.TCPServer.allow_reuse_address = True

    class Server(socketserver.ThreadingTCPServer):
        # Chrome holds a keep-alive socket to the console tab; a single-threaded
        # server would then block the panel's API calls behind it.
        daemon_threads = True
        allow_reuse_address = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authed(self) -> bool:
            return self.headers.get("Authorization") == f"Bearer {GOOD}"

        def do_GET(self):  # noqa: N802
            if self.path == "/api/config/theme":
                self._send(200, b'{"mode":"light"}', "application/json")
            elif self.path == "/":
                # Stand-in for the QwenPaw console: logging in leaves a token in
                # localStorage under this exact key (seen in the real bundle).
                page = f"""<!doctype html><html><head><meta charset="utf-8">
<title>Mock Console</title></head><body><h1>Mock Console</h1>
<script>localStorage.setItem("qwenpaw_auth_token", "{GOOD}");
localStorage.setItem("qwenpaw-last-used-agent", "snooze");</script>
</body></html>"""
                self._send(200, page.encode(), "text/html; charset=utf-8")
            elif self.path == "/api/agents":
                if not self._authed():
                    self._send(401, b'{"detail":"Unauthorized"}', "application/json")
                    return
                agents = [{"id": "default", "name": "小蜗"}, {"id": "snooze", "name": "snooze"}]
                self._send(200, json.dumps({"agents": agents}).encode(), "application/json")
            else:
                self._send(404, b'{"detail":"Not Found"}', "application/json")

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            if self.path == "/api/auth/login":
                # What the hosted platform's edge does: HTML 403, not JSON.
                self._send(403, APACHE_403.encode(), "text/html")
            elif self.path == "/api/console/chat":
                if not self._authed():
                    self._send(401, b'{"detail":"Unauthorized"}', "application/json")
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(SSE)))
                self.end_headers()
                self.wfile.write(SSE)
            else:
                self._send(404, b'{"detail":"Not Found"}', "application/json")

        def log_message(self, *args):
            pass

    httpd = Server(("127.0.0.1", MOCK_PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


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


def main() -> int:
    httpd = serve_mock()
    report: dict = {"mock": f"http://127.0.0.1:{MOCK_PORT}"}
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=f"/tmp/pawside-wizard-{int(time.time())}",
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

            panel = ctx.new_page()
            errors: list[str] = []
            panel.on("pageerror", lambda e: errors.append(str(e)))
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            wait_js(panel, "() => document.getElementById('grabToken') !== null", 10000)

            # keep the wizard visible
            panel.evaluate("() => document.getElementById('settings').classList.remove('hidden')")

            # --- step 1: wrong address -> needs authorization, not false green
            panel.fill("#baseUrl", f"http://127.0.0.1:{MOCK_PORT}")
            wait_js(
                panel,
                "() => (document.getElementById('diag').textContent||'').includes('需要授权')",
                15000,
            )
            report["step1_diag"] = panel.inner_text("#diag")
            report["step1_dot"] = panel.get_attribute("#dot", "class")

            # --- step 2: account->token hits the gateway 403, must read as prose
            panel.click("#otherAuth summary")
            panel.fill("#loginUser", "snooze")
            panel.fill("#loginPass", "whatever")
            panel.click("#getToken")
            wait_js(
                panel,
                "() => (document.getElementById('loginMsg').textContent||'').includes('网关')",
                15000,
            )
            login_msg = panel.inner_text("#loginMsg")
            report["loginMsg"] = login_msg
            body_text = panel.inner_text("body")
            report["no_raw_html"] = not ("DOCTYPE" in body_text or "<html" in body_text)
            panel.screenshot(path=str(ROOT / "spike" / "panel-wizard-blocked.png"), full_page=True)

            # --- step 2b: "read token from the console you already logged into"
            console = ctx.new_page()
            console.goto(f"http://127.0.0.1:{MOCK_PORT}/", wait_until="domcontentloaded")
            time.sleep(0.5)
            panel.bring_to_front()
            # the panel may still show the earlier local-instance green light;
            # clear it so the wait below can only be satisfied by this attempt
            panel.evaluate("() => { document.getElementById('probe').textContent = ''; }")
            panel.click("#grabToken")
            try:
                wait_js(
                    panel,
                    f"""() => (document.getElementById('probe').textContent||'').includes('已连接')
                        && document.getElementById('token').value === '{GOOD}'""",
                    20000,
                )
            except TimeoutError:
                report["grab_debug"] = {
                    "grabMsg": panel.inner_text("#grabMsg"),
                    "token": panel.input_value("#token"),
                    "probe": panel.inner_text("#probe"),
                    "diag": panel.inner_text("#diag"),
                    "tabs": panel.evaluate(
                        "async () => (await chrome.tabs.query({})).map(t => t.url || '(no url)')"
                    ),
                }
                print(json.dumps(report, ensure_ascii=False, indent=2))
                raise
            report["grabbed"] = {
                "msg": panel.inner_text("#grabMsg"),
                "token": panel.input_value("#token"),
                "probe": panel.inner_text("#probe"),
                "agent": panel.eval_on_selector("#agentId", "s => s.value"),
            }

            # --- step 2c: no console tab open -> offer to open one, don't crash
            console.close()
            time.sleep(0.5)
            panel.click("#grabToken")
            wait_js(
                panel,
                "() => (document.getElementById('grabMsg').textContent||'').includes('先帮你打开')",
                15000,
            )
            report["no_tab"] = panel.inner_text("#grabMsg")
            report["tabs_after"] = panel.evaluate(
                f"""async () => (await chrome.tabs.query({{}}))
                    .filter(t => (t.url||'').startsWith('http://127.0.0.1:{MOCK_PORT}')).length"""
            )

            report["diag"] = panel.inner_text("#diag")
            report["agents"] = panel.evaluate(
                "() => Array.from(document.getElementById('agentId').options).map(o => o.value)"
            )
            report["agentHint"] = panel.inner_text("#agentHint")
            panel.screenshot(path=str(ROOT / "spike" / "panel-wizard-ok.png"), full_page=True)
            report["pageErrors"] = errors
            ctx.close()
    finally:
        httpd.shutdown()

    ok = (
        report.get("no_raw_html")
        and report.get("agents") == ["default", "snooze"]
        and report.get("grabbed", {}).get("token") == GOOD
        and "已连接" in (report.get("grabbed", {}).get("probe") or "")
        and report.get("grabbed", {}).get("agent") == "snooze"
        and "warn" in (report.get("step1_dot") or "")
        and not report.get("pageErrors")
    )
    report["PASS"] = bool(ok)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())