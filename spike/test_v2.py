"""PawSide v0.2 end-to-end check.

Covers: panel boot (ES module), summarize, translate page, clip -> workspace
file, selection chip + streaming translation bubble, settings probe.

Run:  xvfb-run -a python3 spike/test_v2.py
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
PAGE_PORT = 8123
WORKSPACE = ROOT.parent

ARTICLE = """<!doctype html><html><head><meta charset="utf-8">
<title>PawSide 测试文章</title><meta name="description" content="spike fixture">
</head><body>
<nav>导航 首页 关于</nav>
<article>
<h1>Why local-first browser assistants win</h1>
<p>First: your data never leaves the machine. The model is chosen by you, so there is no account and no third-party custodian.</p>
<p>Second: the side panel only collects context, while the agent does the reasoning and tool calls. They talk over a local HTTP interface.</p>
</article>
<footer>copyright</footer>
</body></html>"""


def wait_js(page, expr: str, timeout_ms: int = 60000, interval: float = 0.5):
    """CSP-safe polling: extension pages block wait_for_function's eval."""
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


def serve_fixture() -> socketserver.TCPServer:
    socketserver.TCPServer.allow_reuse_address = True

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

    httpd = socketserver.TCPServer(("127.0.0.1", PAGE_PORT), Handler)
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


PROBE_OK = "() => (document.getElementById('probe').textContent || '').includes('已连接')"
PANEL_READY = "() => document.getElementById('summarize') !== null"
ASSISTANT_DONE = """(n) => {
  const nodes = document.querySelectorAll('.msg.assistant');
  if (nodes.length <= n) return false;
  return !nodes[nodes.length - 1].classList.contains('pending');
}"""


def done_expr(n: int) -> str:
    return (
        "() => { const nodes = document.querySelectorAll('.msg.assistant');"
        f" if (nodes.length <= {n}) return false;"
        " return !nodes[nodes.length - 1].classList.contains('pending'); }"
    )
CLIPPED = "() => [...document.querySelectorAll('.msg')].some(n => n.textContent.includes('已收藏'))"
CHIP_VISIBLE = """() => {
  const h = document.getElementById('pawside-sel-host');
  return !!(h && h.shadowRoot && h.shadowRoot.querySelector('.chip'));
}"""
BUBBLE_DONE = """() => {
  const h = document.getElementById('pawside-sel-host');
  const out = h && h.shadowRoot && h.shadowRoot.querySelector('.out');
  return !!(out && out.textContent && !out.textContent.includes('正在翻译'));
}"""


def main() -> int:
    httpd = serve_fixture()
    report: dict = {"extension": str(EXT)}
    clip_file = WORKSPACE / "pawside-clips.md"
    if clip_file.exists():
        clip_file.unlink()

    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=f"/tmp/pawside-v2-{int(time.time())}",
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

            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{PAGE_PORT}/", wait_until="domcontentloaded")

            panel = ctx.new_page()
            errors: list[str] = []
            panel.on("pageerror", lambda e: errors.append(str(e)))
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            wait_js(panel, PANEL_READY, 10000)
            wait_js(panel, PROBE_OK, 20000)
            report["probe"] = panel.inner_text("#probe")

            # pin the fixture as the context tab
            panel.evaluate(
                """async () => {
                  const tabs = await chrome.tabs.query({});
                  const t = tabs.find(x => (x.url || '').includes('127.0.0.1:8123'));
                  await chrome.storage.local.set({ lastTabId: t.id });
                }"""
            )

            def run_action(selector: str, label: str, timeout: int = 180000):
                """Click an action and wait for the reply bubble to be final."""
                before = panel.locator(".msg.assistant").count()
                panel.evaluate(f"document.querySelector('{selector}').click()")
                wait_js(
                    panel,
                    "() => { const n = document.querySelectorAll('.msg.assistant');"
                    f" return n.length > {before} && n[n.length - 1].dataset.done === '1'; }}",
                    timeout,
                )
                text = panel.locator(".msg.assistant").last.inner_text()
                report[label] = {"chars": len(text), "head": text[:160]}
                return text

            run_action("#summarize", "summarize")
            run_action("#translatePage", "translatePage")

            report["markdown"] = panel.evaluate(
                "() => ({strong: document.querySelectorAll('.msg.assistant strong').length,"
                " li: document.querySelectorAll('.msg.assistant li').length,"
                " literal: document.querySelector('.msg.assistant').textContent.includes('**')})"
            )

            # clip -> workspace file
            panel.evaluate("document.querySelector('#clipPage').click()")
            wait_js(panel, CLIPPED, 40000)
            time.sleep(0.5)
            report["clip"] = {
                "exists": clip_file.exists(),
                "size": clip_file.stat().st_size if clip_file.exists() else 0,
                "head": clip_file.read_text()[:200] if clip_file.exists() else "",
            }

            # selection bubble: inject the content script the way the extension
            # does after the user grants <all_urls>
            panel.evaluate(
                """async () => {
                  const tabs = await chrome.tabs.query({});
                  const t = tabs.find(x => (x.url || '').includes('127.0.0.1:8123'));
                  await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/selection.js'] });
                }"""
            )
            page.bring_to_front()
            page.evaluate(
                """() => {
                  const p = document.querySelectorAll('article p')[1];
                  const r = document.createRange(); r.selectNodeContents(p);
                  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
                  document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, button: 0}));
                }"""
            )
            wait_js(page, CHIP_VISIBLE, 10000)
            page.evaluate(
                "() => document.getElementById('pawside-sel-host').shadowRoot.querySelector('.chip').click()"
            )
            wait_js(page, BUBBLE_DONE, 120000)
            report["selection"] = page.evaluate(
                """() => {
                  const h = document.getElementById('pawside-sel-host');
                  return { text: h.shadowRoot.querySelector('.out').textContent.slice(0, 200) };
                }"""
            )
            page.screenshot(path=str(ROOT / "spike" / "selection.png"))
            panel.bring_to_front()
            panel.screenshot(path=str(ROOT / "spike" / "panel-v2.png"), full_page=True)

            report["pageErrors"] = errors
            ctx.close()
    finally:
        httpd.shutdown()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())