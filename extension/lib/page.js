// Everything the panel does inside a real web page: read it, check/ask for
// access, and (conservatively) fill a form.

export const UNSCRIPTABLE =
  /^(chrome|edge|about|devtools|chrome-extension|chrome-search|view-source|file):/i;

export const isWebUrl = (url) => /^https?:/i.test(url || "");

export function originPattern(url) {
  try {
    return new URL(url).origin + "/*";
  } catch {
    return null;
  }
}

/** Does the extension already hold a host permission for this page? */
export async function hasSiteAccess(url) {
  const origin = originPattern(url);
  if (!origin) return false;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Ask for one site. Must run close to the click that triggered it, otherwise
 * Chrome drops the user gesture and silently refuses to show the prompt.
 */
export async function requestSiteAccess(url) {
  const origin = originPattern(url);
  if (!origin) return false;
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function grantedOrigins() {
  try {
    const all = await chrome.permissions.getAll();
    return (all.origins || []).filter((o) => o !== "<all_urls>");
  } catch {
    return [];
  }
}

/** The tab the user is looking at; falls back to the last web tab we saw.
 *  Never returns a chrome:// or extension page — callers must treat null as
 *  "nothing readable right now" instead of reading the panel's own document. */
export async function pickTab() {
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && !UNSCRIPTABLE.test(active.url || "")) return active;
  const { lastTabId } = await chrome.storage.local.get("lastTabId");
  if (lastTabId) {
    try {
      const tab = await chrome.tabs.get(lastTabId);
      if (tab && !UNSCRIPTABLE.test(tab.url || "")) return tab;
    } catch {
      /* closed */
    }
  }
  return null;
}

/* ------------------------------ extraction ------------------------------ */

// Injected into the page: must be self-contained (no closure over module scope).
function extractInPage() {
  const drop = "script,style,noscript,svg,canvas,iframe,nav,footer,aside,form";
  const clone = document.body?.cloneNode(true);
  const title = document.title || "";
  const url = location.href;
  let selection = "";
  try {
    selection = (window.getSelection()?.toString() || "").trim().slice(0, 600);
  } catch {
    /* ignore */
  }
  if (!clone) return { title, url, text: "", paragraphs: 0, selection, description: "" };
  clone.querySelectorAll(drop).forEach((n) => n.remove());
  const root = clone.querySelector("article") || clone.querySelector("main") || clone;
  const text = (root.innerText || root.textContent || "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const meta = document.querySelector('meta[name="description"]');
  return {
    title,
    url,
    text: text.slice(0, 14000),
    paragraphs: text ? text.split(/\n{2,}/).length : 0,
    selection,
    description: (meta?.content || "").slice(0, 300),
  };
}

export async function readPage(tabId) {
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractInPage,
    });
    const page = out?.result;
    if (!page?.text) {
      return { ok: false, reason: "empty", message: "这个页面没有可读正文" };
    }
    return { ok: true, page };
  } catch (err) {
    const msg = String(err?.message || err);
    const needPermission = /cannot access|missing host permission|not allowed|permission/i.test(msg);
    return {
      ok: false,
      reason: needPermission ? "permission" : "error",
      message: needPermission ? "还没有读取这个网站的权限" : `无法读取此页面：${msg.slice(0, 80)}`,
    };
  }
}

/* ------------------------------ forms ------------------------------ */

function scanFormInPage(mark = true) {
  const skipTypes = new Set([
    "hidden", "password", "file", "submit", "button", "reset", "image",
    "checkbox", "radio", "range", "color", "search",
  ]);
  const textTypes = new Set(["text", "email", "tel", "url", "number", "date", "datetime-local", "month", "week", "time"]);

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const labelFor = (node) => {
    const bits = [];
    try {
      const labels = node.labels ? [...node.labels].map((l) => l.innerText) : [];
      bits.push(...labels);
    } catch {
      /* ignore */
    }
    bits.push(node.getAttribute("aria-label") || "");
    const byId = node.getAttribute("aria-labelledby");
    if (byId) {
      bits.push(
        byId
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.innerText || "")
          .join(" ")
      );
    }
    bits.push(node.getAttribute("placeholder") || "");
    const fieldset = node.closest("fieldset");
    if (fieldset) bits.push(fieldset.querySelector("legend")?.innerText || "");
    // The text right before the field is often the only label a form gives.
    const prev = node.previousElementSibling;
    if (prev && prev.textContent && prev.textContent.length < 60) bits.push(prev.textContent);
    const parentText = node.parentElement?.innerText || "";
    if (parentText.length < 60) bits.push(parentText);
    const clean1 = clean(bits.find((b) => clean(b).length > 0));
    if (clean1) return clean1.slice(0, 80);
    const name = node.getAttribute("name") || node.id || "";
    return name ? name.replace(/[_-]+/g, " ").slice(0, 60) : "未命名字段";
  };

  const fields = [];
  const nodes = [...document.querySelectorAll("input, textarea, select")];
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    const type = (node.getAttribute("type") || "").toLowerCase();
    if (node.disabled || node.readOnly) continue;
    if (tag === "input" && (skipTypes.has(type) || (type && !textTypes.has(type)))) continue;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    if (rect.width < 4 || rect.height < 4) continue;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
    const idx = fields.length;
    if (mark) node.setAttribute("data-pawside-ff", String(idx));
    fields.push({
      idx,
      label: labelFor(node),
      tag,
      type: tag === "input" ? type || "text" : tag,
      required: !!node.required,
      value: String(node.value || "").slice(0, 200),
      options: tag === "select" ? [...node.options].map((o) => o.text.trim()).slice(0, 40) : null,
      maxLength: node.maxLength > 0 ? node.maxLength : 0,
    });
  }
  return {
    fields: fields.slice(0, 24),
    title: document.title || "",
    url: location.href,
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 6000),
  };
}

export async function scanForm(tabId, { mark = true } = {}) {
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      func: scanFormInPage,
      args: [mark],
    });
    return out?.result || { fields: [] };
  } catch (err) {
    return { fields: [], error: String(err?.message || err) };
  }
}

// Injected: writes values only. Never submits, never touches passwords.
function fillFormInPage(values) {
  let filled = 0;
  for (const item of values) {
    const node = document.querySelector(`[data-pawside-ff="${item.idx}"]`);
    if (!node || item.value == null) continue;
    const value = String(item.value);
    if (node.tagName === "SELECT") {
      const opts = [...node.options];
      const hit =
        opts.find((o) => o.value === value) ||
        opts.find((o) => o.text.trim() === value.trim()) ||
        opts.find((o) => o.text.trim().includes(value.trim()) && value.trim().length > 1);
      if (!hit) continue;
      node.value = hit.value;
    } else {
      const proto =
        node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(node, value);
      else node.value = value;
    }
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
    node.dispatchEvent(new Event("blur", { bubbles: true }));
    filled++;
  }
  document.querySelectorAll("[data-pawside-ff]").forEach((n) => n.removeAttribute("data-pawside-ff"));
  return filled;
}

export async function fillForm(tabId, values) {
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillFormInPage,
      args: [values],
    });
    return out?.result || 0;
  } catch {
    return 0;
  }
}

/** Prompt that asks the agent for a strict, checkable field mapping. */
export function formPrompt(scan, userHint = "") {
  const fields = scan.fields.map((f) => ({
    idx: f.idx,
    label: f.label,
    type: f.type,
    required: f.required,
    current: f.value || undefined,
    options: f.options || undefined,
  }));
  return [
    "【表单填写建议】只根据下面的页面内容推断能确定的字段。不要编造用户没有提供的信息（手机号、邮箱、身份证、地址、密码一律留空）。",
    "输出要求：只输出一个 JSON 数组，不要任何解释、不要 markdown 代码块。",
    '每项格式：{"idx": 数字, "value": "要填的内容", "why": "一句话依据"}',
    "无法确定的字段直接省略，不要猜。",
    "",
    `页面：${scan.title}`,
    `链接：${scan.url}`,
    userHint ? `用户补充：${userHint}` : "",
    "",
    "字段列表：",
    JSON.stringify(fields, null, 1),
    "",
    "页面正文：",
    scan.text,
  ]
    .filter(Boolean)
    .join("\n");
}