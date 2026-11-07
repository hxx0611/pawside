// Shared agent client: settings, health probe, SSE chat, clip upload.

export const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8088",
  agentId: "default",
  token: "",
  sendContext: true,
  selectionEnabled: false,
  targetLang: "auto",
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  next.baseUrl = (next.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  await chrome.storage.local.set(next);
  return next;
}

export function authHeaders(settings) {
  return settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
}

const LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i;

/** Turn a bare network failure into the one thing the user should fix. */
export function networkHint(baseUrl = "") {
  if (LOCAL_RE.test(baseUrl)) return "连不上，确认本机 QwenPaw 已启动";
  if (/^http:\/\//i.test(baseUrl)) {
    return "连不上：公网 http 会被浏览器当混合内容拦掉，请填 https 地址";
  }
  return "连不上：确认地址公网可达、反向代理已放行 /api/";
}

/**
 * Exchange the instance's own account for a long-lived bearer token.
 *
 * The login endpoint is public, so the panel can mint a token without the user
 * opening a terminal — the usual blocker when PawSide talks to a cloud
 * deployment. `expires_in: 0` asks QwenPaw for a permanent token (the default
 * is 7 days, which would silently break the panel a week later).
 */
export async function loginForToken(baseUrl, username, password, { expiresIn = 0 } = {}) {
  const base = (baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "");
  if (!username || !password) {
    return { ok: false, kind: "input", message: "先填用户名和密码" };
  }
  let res;
  try {
    res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, expires_in: expiresIn }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, kind: "network", message: networkHint(base) };
  }

  if (res.status === 401) return { ok: false, kind: "auth", message: "用户名或密码不对" };
  if (res.status === 423) return { ok: false, kind: "locked", message: "试错太多被临时锁定，过一会儿再试" };
  if (res.status === 429) return { ok: false, kind: "rate", message: "请求太频繁，等一分钟" };
  if (res.status === 404) {
    return { ok: false, kind: "http", message: "这个地址没有登录接口，确认是 QwenPaw 服务地址" };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, kind: "http", message: describeHttp(res.status, detail) };
  }

  const data = await res.json().catch(() => ({}));
  if (!data.token) {
    // QwenPaw answers with an empty token when auth is disabled.
    return { ok: false, kind: "no-auth", message: "该实例没开鉴权，令牌留空即可" };
  }
  return { ok: true, token: data.token, username: data.username || username };
}

/**
 * Probe an instance. Distinguishes "unreachable" from "token rejected" so the
 * UI can tell the user which of the two things to fix.
 */
export async function probe(settings) {
  const d = await diagnose(settings);
  return { ok: d.state === "ok", kind: d.state, ms: d.ms, message: d.message };
}

/**
 * Map an HTTP failure onto something a human can act on.
 *
 * Gateways in front of hosted instances answer with an HTML error page — never
 * render that in the panel, it's noise. `html` tells us the reply came from a
 * proxy rather than from QwenPaw itself.
 */
export function describeHttp(status, body = "") {
  const html = /<!doctype|<html|<\s*head/i.test(body);
  if (status === 401) return "需要授权：令牌无效或已过期";
  if (status === 403) {
    return html
      ? "实例前面的网关挡住了这次请求（403）：它只接受自己页面发出的请求。PawSide 会自动改用页面中转。"
      : "实例拒绝了请求（403）：这个令牌可能无权访问该 agent";
  }
  if (status === 404) {
    return html
      ? "这个地址上没有 QwenPaw 接口（404），确认填的是后台首页地址"
      : "接口不存在（404），可能 QwenPaw 版本不匹配";
  }
  if (status === 423) return "试错太多被临时锁定，过一会儿再试";
  if (status === 429) return "请求太频繁，等一分钟";
  if (status >= 500) return `服务端出错（${status}），看下服务日志`;
  return `HTTP ${status}`;
}

/** Agent list doubles as the auth check: it's the first call that needs a token. */
export async function fetchAgents(settings) {
  const base = settings.baseUrl.replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${base}/api/agents`, {
      headers: authHeaders(settings),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, kind: "network", message: networkHint(settings.baseUrl) };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const kind = res.status === 401 || res.status === 403 ? "auth" : "http";
    return { ok: false, kind, status: res.status, message: describeHttp(res.status, body) };
  }
  const data = await res.json().catch(() => ({}));
  const agents = (data.agents || []).map((a) => ({ id: a.id, name: a.name || a.id }));
  return { ok: true, agents };
}

/**
 * Two-phase diagnosis: is the address a live QwenPaw, and does our credential
 * actually get us in. The old probe only hit a public endpoint, so it showed a
 * green light for instances that would reject every real request.
 */
export async function diagnose(settings) {
  const base = settings.baseUrl.replace(/\/+$/, "");
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(`${base}/api/config/theme`, { signal: AbortSignal.timeout(6000) });
  } catch (err) {
    return {
      state: "unreachable",
      ms: Math.round(performance.now() - t0),
      message: err?.name === "TimeoutError" ? "连接超时" : networkHint(settings.baseUrl),
    };
  }
  const ms = Math.round(performance.now() - t0);
  if (!res.ok) {
    return { state: "error", ms, message: describeHttp(res.status, await res.text().catch(() => "")) };
  }

  const who = await fetchAgents(settings);
  if (who.ok) {
    const names = who.agents.map((a) => a.name).slice(0, 3).join("、");
    return {
      state: "ok",
      ms,
      agents: who.agents,
      message: `已连接 · ${ms}ms${who.agents.length ? ` · ${names}` : ""}`,
    };
  }
  if (who.kind === "auth") {
    return { state: "needs-token", ms, message: `能连上 · ${ms}ms · 需要授权` };
  }
  return { state: "error", ms, message: who.message };
}

function toPlainText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (p?.type === "text" ? p.text || "" : "")).join("");
}

/**
 * Incremental SSE consumer for /api/console/chat.
 *
 * Reasoning blocks also arrive as `text` deltas, so their msg_ids are tracked
 * and skipped, and only the announced answer message may reach the UI. Both the
 * direct fetch path and the page-relay path feed this same consumer so the two
 * transports can never drift apart.
 */
export function createSseConsumer({ onDelta } = {}) {
  let buf = "";
  let text = "";
  let finalText = null;
  let answerId = null;
  const reasoningIds = new Set();

  function handle(evt) {
    if (evt.type === "text" && evt.delta && typeof evt.text === "string") {
      if (evt.msg_id && reasoningIds.has(evt.msg_id)) return;
      if (answerId && evt.msg_id && evt.msg_id !== answerId) return;
      text += evt.text;
      onDelta?.(evt.text, text);
    } else if (evt.object === "message" && evt.type === "reasoning" && evt.id) {
      reasoningIds.add(evt.id);
    } else if (evt.object === "message" && evt.type === "message" && evt.id) {
      if (!reasoningIds.has(evt.id)) answerId = evt.id;
    } else if (evt.object === "response" && evt.status === "completed") {
      const out = Array.isArray(evt.output) ? evt.output : [];
      const answer = out
        .filter((m) => m && m.role === "assistant" && m.type !== "reasoning")
        .map((m) => toPlainText(m.content))
        .join("");
      if (answer.trim()) finalText = answer;
    } else if (evt.object === "response" && evt.status === "failed") {
      throw new Error(evt.error?.message || "agent 执行失败");
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(raw);
          } catch {
            continue;
          }
          handle(evt);
        }
      }
    },
    finish() {
      return (finalText ?? text).trim();
    },
  };
}

/** True when a proxy/edge in front of the instance answered instead of it. */
export function isGatewayBlock(status, body = "") {
  return status === 403 && /<!doctype|<html|<\s*head/i.test(body || "");
}

/**
 * Stream one chat turn over plain HTTP. Throws an Error whose message is
 * already human-readable — raw proxy HTML never reaches the panel.
 */
export async function streamChat(settings, prompt, sessionId, { onDelta, signal, timeoutMs = 120000 } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const forward = () => abort.abort();
  if (signal) {
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", forward, { once: true });
  }

  try {
    const res = await fetch(`${settings.baseUrl}/api/console/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": settings.agentId || "default",
        ...authHeaders(settings),
      },
      body: JSON.stringify({
        input: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        session_id: sessionId,
        user_id: "pawside",
        channel: "console",
        stream: true,
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const err = new Error(describeHttp(res.status, detail));
      err.status = res.status;
      err.gatewayBlocked = isGatewayBlock(res.status, detail);
      throw err;
    }
    if (!res.body) throw new Error("服务没有返回流");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const consumer = createSseConsumer({ onDelta });

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      consumer.push(decoder.decode(value, { stream: true }));
    }
    return consumer.finish();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forward);
  }
}

/* ------------------------------ clips ------------------------------ */

function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function renderClips(clips) {
  const byDay = new Map();
  for (const c of clips) {
    const day = (c.savedAt || "").slice(0, 10) || dayKey();
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  const out = ["# PawSide 收藏", "", "> 由浏览器侧栏自动维护，agent 可直接检索这个文件。", ""];
  for (const day of [...byDay.keys()].sort().reverse()) {
    out.push(`## ${day}`, "");
    for (const c of byDay.get(day)) {
      out.push(`### ${c.title || c.url || "未命名"}`, "");
      out.push(`- 链接：${c.url || "—"}`);
      out.push(`- 收藏时间：${(c.savedAt || "").replace("T", " ").slice(0, 16)}`);
      if (c.note) out.push(`- 备注：${c.note}`);
      if (c.quote) out.push("", "> " + c.quote.replace(/\n+/g, " ").slice(0, 600));
      out.push("");
    }
  }
  return out.join("\n");
}

export const CLIP_FILE = "pawside-clips.md";

/**
 * Push the clip markdown into the agent workspace. POST-only, so hosted
 * instances with an origin-locked gateway will reject it; the caller may pass
 * a fallback uploader (page relay) for that case.
 */
export async function uploadClipFile(settings, md) {
  const fd = new FormData();
  fd.append("files", new File([md], CLIP_FILE, { type: "text/markdown" }));
  let res;
  try {
    res = await fetch(
      `${settings.baseUrl}/api/workspace/file-upload?path=&root=project&conflict=overwrite`,
      { method: "POST", headers: authHeaders(settings), body: fd }
    );
  } catch {
    return { ok: false, network: true, message: networkHint(settings.baseUrl) };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: res.status,
      gatewayBlocked: isGatewayBlock(res.status, body),
      message: describeHttp(res.status, body),
    };
  }
  return { ok: true };
}

/**
 * Save a clip locally and mirror the whole collection into the agent workspace.
 * `fallbackUpload(settings, md)` is tried when the direct POST is blocked.
 */
export async function saveClip(settings, clip, fallbackUpload) {
  const { clips = [] } = await chrome.storage.local.get("clips");
  const entry = {
    title: clip.title || "",
    url: clip.url || "",
    quote: clip.quote || "",
    note: clip.note || "",
    savedAt: new Date().toISOString(),
  };
  const next = [entry, ...clips].slice(0, 500);
  await chrome.storage.local.set({ clips: next });

  const md = renderClips(next);
  let res = await uploadClipFile(settings, md);
  if (!res.ok && (res.gatewayBlocked || res.network) && fallbackUpload) {
    res = (await fallbackUpload(md)) || res;
  }
  if (!res.ok) {
    return { ok: false, local: true, status: res.status, message: `本地已存，写入工作区失败：${res.message}` };
  }
  return { ok: true, count: next.length, file: CLIP_FILE, relayed: !!res.relayed };
}

export async function listClips() {
  const { clips = [] } = await chrome.storage.local.get("clips");
  return clips;
}