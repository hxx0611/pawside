// Chat transport with the hosted-instance fallback.
//
// A hosted QwenPaw may sit behind a gateway that 403s any POST not issued by
// its own pages. When that happens the request is replayed inside a tab on the
// instance origin (content/relay.js) and the bytes stream back here.

import {
  createSseConsumer,
  describeHttp,
  saveSettings,
  streamChat,
} from "./agent.js";

const relay = { waiters: new Map() };

// Relay frames are broadcast to every extension page, so no port is needed.
chrome.runtime.onMessage.addListener((m) => {
  if (!m || typeof m.type !== "string" || !m.type.startsWith("pawside:relay-")) return;
  const w = relay.waiters.get(m.requestId);
  if (!w) return;

  if (m.type === "pawside:relay-chunk") {
    try {
      w.consumer.push(m.text);
    } catch (err) {
      chrome.runtime.sendMessage({ type: "relayAbort", requestId: m.requestId }).catch(() => {});
      w.fail(err);
    }
  } else if (m.type === "pawside:relay-end") {
    if (m.aborted) {
      const err = new Error("已取消");
      err.name = "AbortError";
      w.fail(err);
    } else {
      w.succeed(w.consumer.finish());
    }
  } else if (m.type === "pawside:relay-error") {
    if (m.aborted) {
      w.fail(Object.assign(new Error("已取消"), { name: "AbortError" }));
      return;
    }
    const err = new Error(m.status ? describeHttp(m.status, m.body) : `中转请求失败：${m.message}`);
    err.status = m.status;
    w.fail(err);
  }
});

function streamChatViaRelay(settings, prompt, sessionId, { onDelta, signal, timeoutMs = 180000 } = {}) {
  const requestId = (crypto.randomUUID && crypto.randomUUID()) || `r-${Date.now()}`;
  const consumer = createSseConsumer({ onDelta });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      relay.waiters.delete(requestId);
      fn(value);
    };
    const abortRemote = () =>
      chrome.runtime.sendMessage({ type: "relayAbort", requestId }).catch(() => {});
    const timer = setTimeout(() => {
      abortRemote();
      done(reject, new Error("等待实例响应超时"));
    }, timeoutMs);
    const onAbort = () => {
      abortRemote();
      done(reject, Object.assign(new Error("已取消"), { name: "AbortError" }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    relay.waiters.set(requestId, {
      consumer,
      succeed: (v) => done(resolve, v),
      fail: (e) => done(reject, e),
    });

    chrome.runtime
      .sendMessage({
        type: "relayDispatch",
        requestId,
        kind: "chat",
        payload: {
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
        },
      })
      .then((res) => {
        if (!res?.ok) done(reject, new Error(res?.message || "无法建立实例页面中转"));
      })
      .catch((err) => done(reject, new Error(String(err?.message || err))));
  });
}

export const looksBlocked = (err) =>
  err?.gatewayBlocked || err?.status === 403 || err instanceof TypeError;

/**
 * Direct HTTP first; on a gateway block, replay it same-origin inside a tab.
 * The memo (`relayFor`) is remembered per endpoint so later turns skip the
 * doomed direct attempt.
 */
export async function chatStream(settings, prompt, sessionId, opts = {}) {
  if (settings.relayFor === settings.baseUrl) {
    try {
      return await streamChatViaRelay(settings, prompt, sessionId, opts);
    } catch (err) {
      if (!looksBlocked(err)) throw err;
    }
  }

  try {
    return await streamChat(settings, prompt, sessionId, opts);
  } catch (err) {
    if (!looksBlocked(err) || opts.signal?.aborted) throw err;
    const answer = await streamChatViaRelay(settings, prompt, sessionId, opts);
    if (settings.relayFor !== settings.baseUrl) {
      settings.relayFor = settings.baseUrl;
      await saveSettings({ relayFor: settings.baseUrl });
      opts.onRelay?.();
    }
    return answer;
  }
}