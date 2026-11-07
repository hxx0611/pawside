// Same-origin relay for hosted QwenPaw instances.
//
// Some deployments sit behind a gateway that only accepts requests issued by
// its own pages (a cross-origin POST from the extension gets an Apache 403).
// The background worker injects this script into a tab that already lives on
// the instance, so the request is same-origin — exactly like the web console —
// and the bytes are streamed back to the side panel.

if (!globalThis.__pawsideRelay) {
  globalThis.__pawsideRelay = true;

  const inflight = new Map();

  const post = (msg) => {
    try {
      chrome.runtime.sendMessage(msg);
    } catch {
      /* extension reloaded mid-stream */
    }
  };

  async function relayChat(message) {
    // The panel wraps its arguments in `payload`; background-side callers send
    // them flat. Accept both so the two entry points can't drift.
    const { requestId, baseUrl, token, agentId, path, body } = message.payload || message;
    const url = new URL(path || "/api/console/chat", baseUrl || location.origin).toString();
    const ctrl = new AbortController();
    inflight.set(requestId, ctrl);

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-Id": agentId || "default",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body || {}),
        signal: ctrl.signal,
      });
    } catch (err) {
      inflight.delete(requestId);
      if (ctrl.signal.aborted) return post({ type: "pawside:relay-end", requestId, aborted: true });
      return post({ type: "pawside:relay-error", requestId, message: String(err?.message || err) });
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      inflight.delete(requestId);
      return post({ type: "pawside:relay-error", requestId, status: res.status, body: detail });
    }

    try {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        post({ type: "pawside:relay-chunk", requestId, text: decoder.decode(value, { stream: true }) });
      }
      post({ type: "pawside:relay-end", requestId });
    } catch (err) {
      post({
        type: "pawside:relay-error",
        requestId,
        message: String(err?.message || err),
        aborted: ctrl.signal.aborted,
      });
    } finally {
      inflight.delete(requestId);
    }
  }

  async function relayUpload(message) {
    const { requestId, baseUrl, token, filename, text, mime } = message.payload || message;
    const fd = new FormData();
    fd.append("files", new File([text], filename, { type: mime || "text/markdown" }));
    let res;
    try {
      res = await fetch(
        new URL(
          "/api/workspace/file-upload?path=&root=project&conflict=overwrite",
          baseUrl || location.origin
        ).toString(),
        { method: "POST", headers: token ? { Authorization: `Bearer ${token}` } : {}, body: fd }
      );
    } catch (err) {
      return post({ type: "pawside:relay-upload", requestId, ok: false, message: String(err?.message || err) });
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return post({ type: "pawside:relay-upload", requestId, ok: false, status: res.status, body: detail });
    }
    post({ type: "pawside:relay-upload", requestId, ok: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;

    if (msg.type === "pawside:relay-chat") {
      sendResponse({ accepted: true });
      relayChat(msg);
      return false;
    }

    if (msg.type === "pawside:relay-upload") {
      sendResponse({ accepted: true });
      relayUpload(msg);
      return false;
    }

    if (msg.type === "pawside:relay-abort") {
      inflight.get(msg.requestId)?.abort();
      inflight.delete(msg.requestId);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === "pawside:relay-ping") {
      sendResponse({ ok: true, origin: location.origin });
      return false;
    }
    return false;
  });
}