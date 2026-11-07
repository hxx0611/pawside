// PawSide selection helper: shows a small chip on selection, translates in a
// floating bubble. Injected only after the user grants <all_urls>.
(() => {
  if (window.__pawsideSelection) return;
  window.__pawsideSelection = true;

  const MAX_TRANSLATE = 1200;
  const HOST_ID = "pawside-sel-host";

  let chip = null;
  let bubble = null;
  let lastRange = null;

  const css = `
    :host { all: initial; }
    .card, .chip {
      font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #1d2129; background: #fff; border: 1px solid #e5e6eb;
      box-shadow: 0 6px 24px rgba(0,0,0,.14); border-radius: 10px;
    }
    .chip {
      position: fixed; padding: 3px 8px; cursor: pointer; font-size: 12px;
      display: flex; align-items: center; gap: 4px; user-select: none;
    }
    .chip:hover { border-color: #2f7d4b; color: #2f7d4b; }
    .card { position: fixed; width: 320px; max-height: 340px; display: flex; flex-direction: column; overflow: hidden; }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 7px 10px; border-bottom: 1px solid #e5e6eb; font-size: 12px; color: #86909c;
    }
    header b { color: #1d2129; font-weight: 600; }
    .body { padding: 9px 11px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; max-height: 250px; }
    .src { color: #86909c; font-size: 12px; border-left: 2px solid #e5e6eb; padding-left: 8px; margin-bottom: 8px; max-height: 3.2em; overflow: hidden; }
    footer { display: flex; gap: 6px; padding: 6px 10px; border-top: 1px solid #e5e6eb; justify-content: flex-end; }
    button {
      font: inherit; font-size: 12px; border: 1px solid #e5e6eb; background: #fff;
      color: #1d2129; border-radius: 6px; padding: 2px 8px; cursor: pointer;
    }
    button:hover { border-color: #2f7d4b; color: #2f7d4b; }
    .err { color: #c0392b; }
    @media (prefers-color-scheme: dark) {
      .card, .chip { background: #1e2326; color: #dfe3e6; border-color: #2f373b; }
      header { border-color: #2f373b; } header b { color: #dfe3e6; }
      footer { border-color: #2f373b; }
      button { background: #262d31; color: #dfe3e6; border-color: #2f373b; }
      .src { border-color: #2f373b; }
    }
  `;

  function host() {
    let el = document.getElementById(HOST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = HOST_ID;
      el.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
      const root = el.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = css;
      root.append(style);
      document.documentElement.append(el);
    }
    return el.shadowRoot;
  }

  function clearChip() {
    chip?.remove();
    chip = null;
  }

  function closeBubble() {
    bubble?.remove();
    bubble = null;
  }

  function place(el, x, y, width = 0, height = 0) {
    const margin = 8;
    const left = Math.min(Math.max(margin, x), window.innerWidth - width - margin);
    const top = Math.min(Math.max(margin, y), window.innerHeight - height - margin);
    el.style.left = `${left + window.scrollX}px`;
    el.style.top = `${top + window.scrollY}px`;
  }

  function showChip(rect, text) {
    clearChip();
    const root = host();
    chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>🐾</span><span>翻译</span>`;
    chip.style.pointerEvents = "auto";
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      clearChip();
      openBubble(rect, text);
    });
    root.append(chip);
    place(chip, rect.right + 6, rect.bottom + 6, 74, 26);
  }

  async function openBubble(rect, text) {
    closeBubble();
    const root = host();
    bubble = document.createElement("div");
    bubble.className = "card";
    bubble.style.pointerEvents = "auto";
    bubble.innerHTML = `
      <header><span><b>PawSide</b> · 翻译</span><button data-act="close">✕</button></header>
      <div class="body">
        <div class="src"></div>
        <div class="out">正在翻译…</div>
      </div>
      <footer>
        <button data-act="copy">复制</button>
        <button data-act="clip">收藏</button>
      </footer>`;
    root.append(bubble);
    place(bubble, rect.right + 8, rect.bottom + 8, 320, 220);

    bubble.querySelector(".src").textContent = text.slice(0, 160);
    const out = bubble.querySelector(".out");

    bubble.querySelector('[data-act="close"]').onclick = closeBubble;
    bubble.querySelector('[data-act="copy"]').onclick = async () => {
      try {
        await navigator.clipboard.writeText(out.textContent || "");
        out.dataset.copied = "1";
      } catch {
        /* clipboard denied on some pages */
      }
    };
    bubble.querySelector('[data-act="clip"]').onclick = () => {
      chrome.runtime.sendMessage({
        type: "clip",
        clip: {
          title: document.title,
          url: location.href,
          quote: text,
          note: out.textContent || "",
        },
      });
      const btn = bubble.querySelector('[data-act="clip"]');
      btn.textContent = "已收藏 ✓";
      btn.disabled = true;
    };

    if (text.length > MAX_TRANSLATE) {
      out.textContent = `选中的内容有点长（${text.length} 字）。请打开侧栏，用「翻译本页」或把内容贴进输入框。`;
      out.classList.add("err");
      return;
    }

    const port = chrome.runtime.connect({ name: "pawside-translate" });
    let buf = "";
    port.onMessage.addListener((msg) => {
      if (msg.type === "start") {
        out.textContent = "";
      } else if (msg.type === "delta") {
        buf += msg.text;
        out.textContent = buf;
        bubble.querySelector(".body").scrollTop = 99999;
      } else if (msg.type === "done") {
        if (msg.text) out.textContent = msg.text;
        port.disconnect();
      } else if (msg.type === "error") {
        out.textContent = `翻译失败：${msg.message}`;
        out.classList.add("err");
        port.disconnect();
      }
    });
    port.postMessage({ type: "translate", text });
    setTimeout(() => {
      if (!buf) out.textContent = "…如果一直没反应，检查侧栏里的服务地址";
    }, 12000);
  }

  function selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const node = sel.anchorNode;
    const tag = node?.nodeType === 1 ? node.tagName : node?.parentElement?.tagName;
    if (tag && /^(INPUT|TEXTAREA|SELECT)$/.test(tag.toUpperCase())) return null;
    const range = sel.getRangeAt(0);
    lastRange = range.cloneRange();
    return { text, rect: range.getBoundingClientRect() };
  }

  document.addEventListener("mouseup", (e) => {
    if (e.button !== 0) return;
    setTimeout(() => {
      const info = selectionInfo();
      if (!info || info.rect.width === 0 && info.rect.height === 0) {
        clearChip();
        return;
      }
      showChip(info.rect, info.text);
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target?.id === HOST_ID) return;
    clearChip();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearChip();
      closeBubble();
    }
  });

  window.addEventListener("scroll", () => clearChip(), { passive: true });
})();