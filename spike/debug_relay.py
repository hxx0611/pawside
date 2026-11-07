"""Debug: where does the relay stream die?"""

from __future__ import annotations

import json
import time

from playwright.sync_api import sync_playwright

import test_relay as T

def main():
    art = T.serve_article()
    inst = T.serve_instance()
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(
                user_data_dir=f"/tmp/pawside-dbg-{int(time.time())}",
                headless=False,
                executable_path="/usr/bin/chromium",
                args=[
                    f"--disable-extensions-except={T.EXT}",
                    f"--load-extension={T.EXT}",
                    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
                ],
            )
            ext_id = T.find_extension_id(ctx)
            article = ctx.new_page()
            article.goto("http://127.0.0.1:8124/", wait_until="domcontentloaded")
            panel = ctx.new_page()
            logs = []
            panel.on("console", lambda m: logs.append(f"console:{m.text[:200]}"))
            panel.on("pageerror", lambda e: logs.append(f"pageerror:{e}"))
            panel.goto(f"chrome-extension://{ext_id}/sidepanel.html")
            T.wait_js(panel, "() => document.getElementById('baseUrl') !== null", 10000)

            # spy on every runtime message the panel can see
            panel.evaluate("""() => { window.__log = [];
                chrome.runtime.onMessage.addListener(m => {
                  if (m && m.type && m.type.startsWith('pawside:relay')) window.__log.push(m.type);
                });
            }""")

            panel.evaluate("() => document.getElementById('settings').classList.remove('hidden')")
            panel.fill("#baseUrl", f"http://127.0.0.1:{T.INSTANCE_PORT}")
            panel.evaluate("() => { document.getElementById('otherAuth').open = true; }")
            panel.fill("#token", T.GOOD)
            panel.click("#save")
            T.wait_js(panel, "() => (document.getElementById('probe').textContent||'').includes('已连接')", 20000)

            panel.evaluate("""async () => {
              const tabs = await chrome.tabs.query({});
              const t = tabs.find(x => (x.url || '').includes('8124'));
              await chrome.storage.local.set({ lastTabId: t.id });
            }""")

            panel.evaluate("() => document.querySelector('#summarize').click()")
            time.sleep(12)

            diag = panel.evaluate("() => ({log: window.__log, msgs: [...document.querySelectorAll('.msg')].map(n=>n.className+'|'+n.textContent.slice(0,80))})")
            # ask the relay tab directly
            relay_tab = panel.evaluate(
                f"""async () => (await chrome.tabs.query({{}})).find(t => (t.url||'').startsWith('http://127.0.0.1:{T.INSTANCE_PORT}'))?.id"""
            )
            ping = "n/a"
            if relay_tab:
                ping = panel.evaluate(
                    "async (tabId) => { try { return JSON.stringify(await chrome.tabs.sendMessage(tabId, {type:'pawside:relay-ping'})); } catch (e) { return 'ERR:'+e.message; } }",
                    relay_tab,
                )
            print(json.dumps({"diag": diag, "relayTab": relay_tab, "ping": ping,
                              "state": dict(T.STATE), "logs": logs[-10:]}, ensure_ascii=False, indent=2))
            ctx.close()
    finally:
        art.shutdown()
        inst.shutdown()


if __name__ == "__main__":
    main()