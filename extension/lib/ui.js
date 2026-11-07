// Panel UI primitives: DOM lookup, toast, bottom sheet, time/site formatting.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const ic = (name, cls = "") =>
  `<svg${cls ? ` class="${cls}"` : ""} aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ------------------------------ toast ------------------------------ */

let toastTimer = null;
export function toast(message, ms = 2100) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("on"), ms);
}

/* ------------------------------ sheet ------------------------------ */

// `openSheet` returns a promise for the chosen key (or null when dismissed).
// Only one sheet can be open at a time; opening a new one resolves the old one
// with null so callers awaiting a choice never hang.
let sheetResolve = null;

export function openSheet({ html, actions = {}, onCancel = null, dismissible = true }) {
  const sheet = $("#sheet");
  const body = $("#sheetBody");
  if (!sheet || !body) return Promise.resolve(null);

  if (sheetResolve) sheetResolve(null);
  sheet.hidden = false;
  body.innerHTML = html;
  sheet.dataset.dismissible = dismissible ? "1" : "0";
  requestAnimationFrame(() => sheet.classList.add("in"));

  return new Promise((resolve) => {
    const finish = (key) => {
      sheetResolve = null;
      body.onclick = null;
      closeSheet();
      if (key === null) onCancel?.();
      resolve(key);
    };
    sheetResolve = finish;
    body.onclick = (e) => {
      const btn = e.target.closest("[data-x]");
      if (!btn) return;
      const key = btn.dataset.x;
      const fn = actions[key];
      if (fn) {
        const out = fn(btn);
        if (out === false) return; // handler keeps the sheet open
        if (out && typeof out.then === "function") {
          out.then((keep) => {
            if (keep !== "keep") finish(key);
          });
          return;
        }
      }
      finish(key);
    };
  });
}

export function closeSheet() {
  const sheet = $("#sheet");
  if (!sheet) return;
  sheet.classList.remove("in");
  setTimeout(() => {
    if (!sheet.classList.contains("in")) sheet.hidden = true;
  }, 200);
}

/** Yes/no sheet. Resolves true only when the explicit confirm button is used. */
export function confirmSheet({ title, body = "", ok = "确定", cancel = "取消", danger = false }) {
  return openSheet({
    html: `
      <h3>${title}</h3>
      ${body ? `<p>${body}</p>` : ""}
      <div class="sheet-actions">
        <button class="btn ghost" data-x="no">${cancel}</button>
        <button class="btn ${danger ? "danger" : "primary"}" data-x="yes">${ok}</button>
      </div>`,
    actions: { yes: () => true, no: () => false },
    onCancel: () => {},
  }).then((key) => key === "yes");
}

/* ------------------------------ formats ------------------------------ */

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function letterOf(url) {
  const host = hostOf(url);
  return (host[0] || "?").toUpperCase();
}

const FAV_COLORS = [
  "#4d6bfe", "#2f7d4b", "#c2410c", "#7c3aed", "#0f766e",
  "#b91c1c", "#a16207", "#1d4ed8", "#be185d", "#475569",
];

export function favColor(url) {
  const host = hostOf(url);
  let h = 0;
  for (const ch of host) h = (h * 31 + ch.codePointAt(0)) % 9973;
  return FAV_COLORS[h % FAV_COLORS.length];
}

export function faviconStyle(url) {
  return `background:${favColor(url)}`;
}

const pad = (n) => String(n).padStart(2, "0");

export function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return `今天 ${hm}`;
  if (d.toDateString() === yest.toDateString()) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    const mins = Math.round((now - d) / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return fmtWhen(iso);
}

export function truncate(text, n = 60) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}