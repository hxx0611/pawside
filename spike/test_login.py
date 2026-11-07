"""PawSide account -> token helper check (v0.2.1).

Drives the real side panel against a mock QwenPaw instance and asserts the
four outcomes the UI must distinguish: empty input, wrong password, auth
disabled, and success (token stored + probe green).

Run:  xvfb-run -a python3 spike/test_login.py
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
MOCK_PORT = 8199
MOCK = f"http://127.0.0.1:{MOCK_PORT}"
GOOD_TOKEN = "mock-jwt-permanent-token"


def wait_js(page, expr: str, timeout_ms: int = 30000, interval: float = 0.25):
    end = time.time() + timeout_ms / 1000
    last = None
    while time.time() < end:
        try:
            if page.evaluate(expr):
                return True
        except Exception as exc:  # page may still be loading
            last = exc
        time.sleep(interval)
    raise TimeoutError(f"condition not met ({last}): {expr[:100]}")


def serve_mock() -> socketserver.TCPServer:
    class Handler(http.server.BaseHTTPRequestHandler):
        def _json(self, code: int, payload: dict):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/api/config/theme"):
                return self._json(200, {"theme": "dark"})
            if self.path.startswith("/api/auth/status"):
                return self._json(200, {"enabled": True, "has_users": True})
            if self.path.startswith("/api/agents"):
                # v0.3 diagnoses auth through the agent list, not a public endpoint
                if self.headers.get("Authorization") == f"Bearer {GOOD_TOKEN}":
                    return self._json(200, {"agents": [{"id": "default", "name": "小蜗"}]})
                return self._json(401, {"detail": "Unauthorized"})
            return self._json(404, {"detail": "not found"})

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(raw or b"{}")
            except Exception:
                req = {}
            if not self.path.startswith("/api/auth/login"):
                return self._json(404, {"detail": "not found"})
            user, pwd = req.get("username"), req.get("password")
            if user == "demo" and pwd == "pass":
                return self._json(200, {"token": GOOD_TOKEN, "username": "demo"})
            if user == "nopass":
                # QwenPaw answers with an empty token when auth is disabled.
                return self._json(200, {"token": "", "username": ""})
            return self._json(401, {"detail": "Invalid username or password"})

        def log_message(self, *args):
            pass

    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", MOCK_PORT), Handler)
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


def msg_is(text: str) -> str:
    return f"() => (document.getElementById('loginMsg').textContent || '').includes({text!r})"


def run_case(panel, base: dict, user: str, pwd: str, expect: str) -> str:
    panel.fill("#loginUser", user)
    panel.fill("#loginPass", pwd)
    panel.click("#getToken")
    wait_js(panel, msg_is(expect), 20000)
    return panel.inner_text("#loginMsg")


def main() -> int:
    httpd = serve_mock()
    report: dict = {"extension": str(EXT), "mock": MOCK}
    errors: list[str] = []

    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=f"/tmp/pawside-login-{int(time.time())}",
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
                report["error"] = "PawSide not loaded"
                print(json.dumps(report, ensure_ascii=False, indent=2))
                return 1

            panel = ctx.new_page()
            panel.on("pageerror", lambda e: errors.append(str(e)))
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            wait_js(panel, "() => document.getElementById('getToken') !== null", 10000)

            # open settings, then the cloud block
            panel.click("#gear")
            panel.fill("#baseUrl", MOCK)
            panel.click("#otherAuth summary")

            # 1. empty input is rejected before any request
            report["empty"] = run_case(panel, report, "", "", "先填用户名和密码")

            # 2. wrong password -> 401 mapping
            report["wrong"] = run_case(panel, report, "demo", "nope", "用户名或密码不对")

            # 3. auth disabled -> tell the user the token can stay empty
            report["noauth"] = run_case(panel, report, "nopass", "x", "令牌留空即可")

            # 4. success -> token filled, saved to storage, probe turns green
            run_case(panel, report, "demo", "pass", "已拿到令牌并保存")
            wait_js(panel, "() => (document.getElementById('probe').textContent||'').includes('已连接')", 20000)
            report["success"] = {
                "tokenField": panel.input_value("#token"),
                "probe": panel.inner_text("#probe"),
                "stored": panel.evaluate("async () => (await chrome.storage.local.get('token')).token"),
                "passwordCleared": panel.input_value("#loginPass") == "",
            }

            panel.screenshot(path=str(ROOT / "spike" / "panel-cloud.png"), full_page=True)
            report["pageErrors"] = errors
            ctx.close()
    finally:
        httpd.shutdown()

    ok = (
        report.get("success", {}).get("tokenField") == GOOD_TOKEN
        and report.get("success", {}).get("stored") == GOOD_TOKEN
        and report.get("success", {}).get("passwordCleared") is True
        and not report.get("pageErrors")
    )
    report["PASS"] = ok
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())