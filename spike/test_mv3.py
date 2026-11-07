"""PawSide spike — verify what a Chrome extension actually needs here.

1. Can an MV3 extension page reach QwenPaw on 127.0.0.1:8088 (CORS / local-network policy)?
2. Does SSE streaming work from the side panel page?
3. Can we read the current page via chrome.scripting + host_permissions?
4. Does chrome.storage persist settings? Does the sidePanel API exist?

Run:  xvfb-run -a python3 spike/test_mv3.py
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
API = "http://127.0.0.1:8088"

ARTICLE = """<!doctype html><html><head><meta charset="utf-8">
<title>PawSide 测试文章</title>
<meta name="description" content="spike fixture">
</head><body>
<nav>导航 首页 关于</nav>
<article>
<h1>为什么本地优先的浏览器助手更好</h1>
<p>第一段：数据留在本机，模型由用户自己选择，没有账号体系，也没有第三方托管。</p>
<p>第二段：浏览器侧栏负责取上下文，agent 负责推理和调用工具，两者通过本地 HTTP 接口对话。</p>
<ul><li>要点一</li><li>要点二</li></ul>
</article>
<footer>版权所有</footer>
<script>console.log("should be stripped")</script>
</body></html>"""


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


PROBE_JS = r"""
async () => {
  const out = {};

  const t0 = performance.now();
  try {
    const r = await fetch("http://127.0.0.1:8088/api/config/theme");
    out.health = { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    out.health = { ok: false, error: String(e) };
  }

  const t1 = performance.now();
  try {
    const r = await fetch("http://127.0.0.1:8088/api/console/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Id": "default" },
      body: JSON.stringify({
        input: [{ role: "user", content: [{ type: "text", text: "只回复三个字：收到了" }] }],
        session_id: "pawside-spike",
        user_id: "pawside",
        channel: "console",
        stream: true,
      }),
    });
    out.stream = { status: r.status, hasBody: !!r.body };
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "", firstDelta = null, events = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let e;
          try { e = JSON.parse(raw); } catch { continue; }
          events++;
          if (e.type === "text" && e.delta && typeof e.text === "string") {
            if (firstDelta === null) firstDelta = Math.round(performance.now() - t1);
            text += e.text;
          }
        }
      }
    }
    out.stream.firstDeltaMs = firstDelta;
    out.stream.totalMs = Math.round(performance.now() - t1);
    out.stream.events = events;
    out.stream.text = text;
  } catch (e) {
    out.stream = { error: String(e), type: e.name };
  }

  try {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => (t.url || "").includes("127.0.0.1:8123"));
    if (!tab) throw new Error("fixture tab not found: " + tabs.map((t) => t.url).join(","));
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        text: document.querySelector("article")?.innerText || "",
        hasScript: !!document.querySelector("script"),
      }),
    });
    out.scripting = {
      tabId: tab.id,
      title: res?.result?.title,
      chars: (res?.result?.text || "").length,
      sample: (res?.result?.text || "").slice(0, 40),
    };
  } catch (e) {
    out.scripting = { error: String(e) };
  }

  try {
    await chrome.storage.local.set({ spike: "ok" });
    const got = await chrome.storage.local.get("spike");
    out.storage = { value: got.spike };
  } catch (e) {
    out.storage = { error: String(e) };
  }

  out.api = {
    sidePanel: typeof chrome.sidePanel,
    scripting: typeof chrome.scripting,
    ua: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
  };
  return out;
}
"""


def find_extension_id(ctx) -> tuple[str | None, list]:
    page = ctx.new_page()
    page.goto("chrome://extensions/")
    time.sleep(1.5)
    items = page.evaluate(
        """() => {
          const m = document.querySelector('extensions-manager');
          const list = m && m.shadowRoot.querySelector('extensions-item-list');
          return list ? Array.from(list.shadowRoot.querySelectorAll('extensions-item'))
              .map(i => ({
                id: i.id,
                name: (i.shadowRoot.querySelector('#name')?.textContent || '').trim(),
                enabled: !i.shadowRoot.querySelector('#enableToggle')?.checked === false,
              })) : [];
        }"""
    )
    page.close()
    hit = next((i for i in items if i["name"] == "PawSide"), None)
    return (hit["id"] if hit else None), items


def main() -> int:
    httpd = serve_fixture()
    report: dict = {"extension": str(EXT)}
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=f"/tmp/pawside-spike-{int(time.time())}",
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
            ext_id, items = find_extension_id(ctx)
            report["loadedItems"] = items
            report["extensionId"] = ext_id
            if not ext_id:
                report["error"] = "PawSide not loaded"
                print(json.dumps(report, ensure_ascii=False, indent=2))
                return 1

            page = ctx.new_page()
            page.goto(f"http://127.0.0.1:{PAGE_PORT}/", wait_until="domcontentloaded")

            panel = ctx.new_page()
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            report["panelTitle"] = panel.title()

            report["probe"] = panel.evaluate(PROBE_JS)

            report["serviceWorker"] = panel.evaluate(
                """async () => {
                  try {
                    const r = await chrome.runtime.sendMessage({ ping: 1 });
                    return { response: r ?? "no-handler" };
                  } catch (e) { return { error: String(e) }; }
                }"""
            )
            report["sidePanelApi"] = panel.evaluate(
                """async () => {
                  try {
                    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
                    const info = await chrome.sidePanel.getOptions({});
                    return { ok: true, options: info };
                  } catch (e) { return { ok: false, error: String(e) }; }
                }"""
            )

            # run the real UI once: type a question, wait for the bubble
            try:
                # The harness opens the panel as a tab, so it steals focus from
                # the article. Prime the fallback tab exactly like a real side
                # panel would have it, then fire the quick action.
                panel.evaluate(
                    """async () => {
                      const tabs = await chrome.tabs.query({});
                      const t = tabs.find(t => (t.url || '').includes('127.0.0.1:8123'));
                      await chrome.storage.local.set({ lastTabId: t.id });
                    }"""
                )
                panel.evaluate("document.getElementById('summarize').click()")
                panel.wait_for_selector(".msg.assistant:not(.pending)", timeout=60000)
                report["ui"] = {
                    "ctxBar": panel.inner_text("#ctxBar"),
                    "bubbles": panel.locator(".msg").count(),
                    "replyHead": panel.locator(".msg.assistant").last.inner_text()[:120],
                    "dotClass": panel.get_attribute("#dot", "class"),
                }
            except Exception as e:  # noqa: BLE001
                report["ui"] = {"error": str(e)}

            panel.screenshot(path=str(ROOT / "spike" / "panel.png"), full_page=True)
            ctx.close()
    finally:
        httpd.shutdown()

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())