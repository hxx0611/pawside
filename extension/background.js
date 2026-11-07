// PawSide service worker: side panel wiring, selection-translate bridge, clips.

import {
  getSettings,
  streamChat,
  saveClip,
  renderClips,
  uploadClipFile,
  probe,
  createSseConsumer,
  describeHttp,
} from "./lib/agent.js";

const SCRIPT_ID = "pawside-selection";

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  syncSelectionScript().catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  syncSelectionScript().catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!chrome.sidePanel?.open) return;
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch {
    /* opening needs a user gesture; onClicked supplies one */
  }
});

/* ---------------- selection script lifecycle ---------------- */

async function hasAllUrls() {
  return chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
}

async function syncSelectionScript() {
  const { selectionEnabled } = await getSettings();
  const granted = await hasAllUrls();
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const isRegistered = registered.some((s) => s.id === SCRIPT_ID);

  if (selectionEnabled && granted && !isRegistered) {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches: ["http://*/*", "https://*/*"],
        js: ["content/selection.js"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
  } else if ((!selectionEnabled || !granted) && isRegistered) {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  }
  return { enabled: selectionEnabled && granted, registered: isRegistered || (selectionEnabled && granted) };
}

/* ---------------- translate port (content script <-> agent) ---------------- */

const TRANSLATE_PROMPT = (text, lang) => {
  const target =
    lang === "zh" ? "中文" : lang === "en" ? "英文" : "中文（如果原文已经是中文，就译成英文）";
  return [
    "【划词翻译请求】这是用户选中的一段文字，与之前任何对话无关，不要引用聊天历史。",
    `把下面的内容翻译成${target}。要求：只输出译文，不要解释，不要加引号，保留原有的换行和标点风格。`,
    "如果内容只有一两个词，直接给对应译词。",
    "",
    "--- 开始 ---",
    text,
    "--- 结束 ---",
  ].join("\n");
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pawside-translate") return;

  const controller = new AbortController();
  let started = false;

  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== "translate" || !msg.text) return;
    if (started) return;
    started = true;

    try {
      const settings = await getSettings();
      port.postMessage({ type: "start" });
      const prompt = TRANSLATE_PROMPT(msg.text, msg.lang || settings.targetLang);
      const onDelta = (delta) => port.postMessage({ type: "delta", text: delta });
      let result;
      try {
        result = await streamChat(settings, prompt, "pawside-translate", {
          signal: controller.signal,
          timeoutMs: 45000,
          onDelta,
        });
      } catch (err) {
        const blocked = err?.gatewayBlocked || err?.status === 403 || err instanceof TypeError;
        if (!blocked || controller.signal.aborted) throw err;
        result = await relayChatInBackground(settings, prompt, "pawside-translate", {
          onDelta,
          timeoutMs: 60000,
        });
      }
      port.postMessage({ type: "done", text: result });
    } catch (err) {
      port.postMessage({ type: "error", message: String(err?.message || err) });
    }
  });
});

/* ---------------- page relay (hosted instances behind an origin-locked gateway) ---------------- */

// Some deployments answer every cross-origin POST with an Apache 403 and only
// accept requests issued by their own pages. Those requests are replayed inside
// a tab that already lives on the instance origin — same-origin, exactly like
// the web console — and the bytes come back through chrome.runtime messages,
// which every extension page (the panel included) receives.

const relayTabs = new Map(); // requestId -> tabId where it was dispatched

async function waitTabReady(tabId, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
    } catch {
      throw new Error("中转标签页已关闭");
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Find (or open) a tab on the instance's own origin and put the relay in it. */
async function ensureRelayTab(baseUrl) {
  const origin = new URL(baseUrl).origin;
  let tab = (await chrome.tabs.query({ url: `${origin}/*` }))[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: `${origin}/`, active: false });
    await waitTabReady(tab.id);
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/relay.js"] });
  return tab.id;
}

async function sendToRelayTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // The tab navigated between inject and send; re-inject and retry once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/relay.js"] });
    await chrome.tabs.sendMessage(tabId, message);
  }
}

/** Run a panel-initiated relay request inside the instance tab. */
async function dispatchRelay({ requestId, kind, payload }) {
  const baseUrl = payload?.baseUrl || (await getSettings()).baseUrl;
  const tabId = await ensureRelayTab(baseUrl);
  relayTabs.set(requestId, tabId);
  const type = kind === "upload" ? "pawside:relay-upload" : "pawside:relay-chat";
  await sendToRelayTab(tabId, { ...payload, type, requestId });
  return { tabId };
}

async function abortRelay(requestId) {
  const tabId = relayTabs.get(requestId);
  relayTabs.delete(requestId);
  if (tabId == null) return;
  await chrome.tabs.sendMessage(tabId, { type: "pawside:relay-abort", requestId }).catch(() => {});
}

/**
 * Relay one chat turn from inside the instance tab, for callers that live in
 * the service worker (selection translate) rather than the panel.
 */
async function relayChatInBackground(settings, prompt, sessionId, { onDelta, timeoutMs = 60000 } = {}) {
  const requestId = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const consumer = createSseConsumer({ onDelta });
  const tabId = await ensureRelayTab(settings.baseUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("等待实例响应超时")), timeoutMs);
    const listener = (m) => {
      if (m?.requestId !== requestId) return;
      if (m.type === "pawside:relay-chunk") {
        try {
          consumer.push(m.text);
        } catch (err) {
          finish(err);
        }
      } else if (m.type === "pawside:relay-end") {
        finish(null, consumer.finish());
      } else if (m.type === "pawside:relay-error") {
        finish(new Error(m.status ? describeHttp(m.status, m.body) : `中转请求失败：${m.message}`));
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    sendToRelayTab(tabId, {
      type: "pawside:relay-chat",
      requestId,
      baseUrl: settings.baseUrl,
      token: settings.token,
      agentId: settings.agentId || "default",
      path: "/api/console/chat",
      body: {
        input: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        session_id: sessionId,
        user_id: "pawside",
        channel: "console",
        stream: true,
      },
    }).catch((err) => finish(new Error(String(err?.message || err))));
  });
}

/** Upload a clip through the relay tab; used when the direct POST is blocked. */
async function relayUploadClip(settings, md) {
  const requestId = `clip-${Date.now()}`;
  let tabId;
  try {
    tabId = await ensureRelayTab(settings.baseUrl);
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, message: "中转上传超时" }), 30000);
    const listener = (m) => {
      if (m?.type !== "pawside:relay-upload" || m.requestId !== requestId) return;
      finish(m.ok ? { ok: true, relayed: true } : { ok: false, relayed: true, message: `HTTP ${m.status || "?"}` });
    };
    chrome.runtime.onMessage.addListener(listener);
    sendToRelayTab(tabId, {
      type: "pawside:relay-upload",
      requestId,
      baseUrl: settings.baseUrl,
      token: settings.token,
      filename: "pawside-clips.md",
      text: md,
      mime: "text/markdown",
    }).catch((err) => finish({ ok: false, message: String(err?.message || err) }));
  });
}

/* ---------------- messages from panel / content script ---------------- */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.ping) {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }

  if (msg.type === "probe") {
    getSettings()
      .then((s) => probe(s))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, kind: "error", message: String(e) }));
    return true;
  }

  if (msg.type === "relayDispatch") {
    dispatchRelay(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, message: String(err?.message || err) }));
    return true;
  }

  if (msg.type === "relayAbort") {
    abortRelay(msg.requestId).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "clipDelete") {
    getSettings()
      .then(async (s) => {
        const { clips = [] } = await chrome.storage.local.get("clips");
        const kept = clips.filter((c) => `${c.savedAt || ""}|${c.url || ""}` !== msg.key);
        await chrome.storage.local.set({ clips: kept });
        const md = renderClips(kept);
        let res = await uploadClipFile(s, md);
        if (!res.ok && (res.gatewayBlocked || res.network)) res = await relayUploadClip(s, md);
        return { ok: true, kept: kept.length, synced: !!res.ok, syncedMessage: res.ok ? "" : res.message };
      })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String(e?.message || e) }));
    return true;
  }

  if (msg.type === "clip") {
    getSettings()
      .then((s) => saveClip(s, msg.clip, (md) => relayUploadClip(s, md)))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String(e?.message || e) }));
    return true;
  }

  if (msg.type === "syncSelection") {
    syncSelectionScript()
      .then(sendResponse)
      .catch((e) => sendResponse({ enabled: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === "openOptions" || msg.type === "openPanel") {
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

/* Remember the last real web page so the panel can read context even when
   focus has moved to an extension page. */
const isWebPage = (url) => /^https?:/i.test(url || "");

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isWebPage(tab.url)) await chrome.storage.local.set({ lastTabId: tabId });
  } catch {
    /* ignore */
  }
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.active && isWebPage(tab.url)) {
    chrome.storage.local.set({ lastTabId: tabId }).catch(() => {});
  }
});