// PawSide side panel — v0.4
//
// Three ideas drive this file:
//   1. capabilities come first  — the empty state shows what can be done with
//      the page you are on, not a blank chat box;
//   2. permissions are visible  — the page card says what was read, the header
//      says whether the instance is actually reachable;
//   3. nothing is silent         — every action ends in a bubble, a toast or a
//      sheet the user can back out of.

import {
  DEFAULTS,
  diagnose,
  getSettings,
  loginForToken,
  saveSettings,
} from "./lib/agent.js";
import { chatStream } from "./lib/transport.js";
import { extractJson, renderMarkdown, escapeHtml } from "./lib/md.js";
import {
  $,
  $$,
  closeSheet,
  confirmSheet,
  el,
  fmtShort,
  fmtWhen,
  hostOf,
  letterOf,
  favColor,
  ic,
  openSheet,
  toast,
  truncate,
} from "./lib/ui.js";
import * as store from "./lib/store.js";
import * as pageApi from "./lib/page.js";

const S = {
  settings: null,
  diag: null,
  tab: null,
  page: null,
  pageError: "",
  view: "empty",
  backTo: "empty",
  thread: null,
  busy: false,
  abort: null,
  theme: "auto",
  lastAnswer: "",
  clips: [],
  sites: [],
  formScan: null,
  formCount: 0,
};

const SUMMARY_ASK = "帮我把这个网页总结一下：先给一句话结论，再列 3-5 个要点。";
const TRANSLATE_ASK =
  "把下面这个网页的正文完整翻译一遍。如果正文已经是中文，就翻译成英文；保留小标题和列表结构，不要总结。";

const PREAMBLE =
  "你是 PawSide——浏览器侧栏里的助手。只围绕下面这个页面和用户的问题回答；" +
  "不要引用无关的历史对话，也不要假装看过没有提供的内容。回答简洁、具体，用中文。";

/* ================================ boot ================================ */

async function boot() {
  S.settings = await getSettings();
  S.theme = await store.getTheme();
  applyTheme();
  bindChromeEvents();
  bindUi();
  renderSettings();
  paintAttach();

  await Promise.all([refreshSites(), refreshClips()]);
  refreshStatus();
  await refreshPage();
  setView("empty");

  $("#versionNote").textContent = `PawSide v${chrome.runtime.getManifest().version} · 第三方工具，与 QwenPaw 官方无隶属关系。历史只存在本机。`;
}

function bindUi() {
  $("#btnHistory").onclick = () => showHistory();
  $("#btnBook").onclick = () => showBookmarks();
  $("#btnSettings").onclick = () => setView("settings");
  $("#btnNew").onclick = () => newThread(true);
  $("#backBtn").onclick = () => setView(S.backTo || "empty");
  $("#pill").onclick = () => setView("settings");
  $("#openPerms").onclick = () => setView("perms", { from: S.view });
  $("#managePerms").onclick = () => setView("perms", { from: "settings" });
  $("#pageHead").onclick = () => openPageSheet();

  $("#allowBtn").onclick = () => allowCurrentSite();
  $("#formQuick").onclick = () => startFormFill();
  $("#addSite").onclick = () => addSiteSheet();

  for (const node of $$("[data-act]")) node.onclick = () => runAction(node.dataset.act);
  for (const node of $$("[data-sug]")) node.onclick = () => send(node.dataset.sug);

  $("#send").onclick = () => (S.busy ? S.abort?.abort() : send($("#input").value));
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send($("#input").value);
    }
  });
  $("#input").addEventListener("input", autoGrow);

  $("#attachToggle").onchange = async (e) => {
    const on = e.target.checked;
    S.settings = await saveSettings({ sendContext: on });
    toast(on ? "发送时会带上页面正文" : "只发问题，不带页面");
  };

  $("#retest").onclick = () => refreshStatus(true);
  $("#saveConn").onclick = () => saveConnection();
  $("#setBase").addEventListener("input", () => {
    $("#setBaseHint").textContent = "填 QwenPaw 网页后台的地址，不带尾部斜杠。";
  });
  $("#grabToken").onclick = () => grabToken();
  $("#getToken").onclick = () => tokenFromAccount();
  $("#themeSeg").onclick = (e) => {
    const btn = e.target.closest("[data-theme]");
    if (btn) pickTheme(btn.dataset.theme);
  };
  $("#optSelection").onchange = (e) => toggleSelection(e.target.checked);
  $("#optAttach").onchange = async (e) => {
    S.settings = await saveSettings({ sendContext: e.target.checked });
    $("#attachToggle").checked = e.target.checked;
    paintAttach();
  };
  $("#clearHistory").onclick = async () => {
    const yes = await confirmSheet({
      title: "清空本机历史？",
      body: "只会删掉这个浏览器里的对话记录，agent 那边的工作区不受影响。",
      ok: "清空",
      danger: true,
    });
    if (!yes) return;
    await store.clearThreads();
    S.thread = null;
    $("#msgs").textContent = "";
    toast("历史已清空");
    setView("empty");
  };

  $("#sheetBd").onclick = () => closeSheet();
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const sheet = $("#sheet");
    if (!sheet.hidden) closeSheet();
    else if (["history", "bookmarks", "settings", "perms"].includes(S.view)) setView(S.backTo || "empty");
  });
}

function bindChromeEvents() {
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => refreshPage(), 350);
  };
  chrome.tabs.onActivated.addListener(later);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === "complete" || info.url) later();
  });
  chrome.permissions.onAdded.addListener(() => {
    refreshSites();
    refreshPage();
  });
  chrome.permissions.onRemoved.addListener(() => {
    refreshSites();
    refreshPage();
  });
}

/* ================================ views ================================ */

const VIEW_TITLE = {
  history: "历史",
  bookmarks: "收藏夹",
  settings: "设置",
  perms: "网站权限",
};

function setView(view, { from = "" } = {}) {
  if (view !== S.view) {
    if (from) S.backTo = from;
    else if (["history", "bookmarks", "settings", "perms"].includes(S.view)) {
      // a nav icon from a sub-view returns to the conversation surface
      S.backTo = S.thread?.messages.length ? "thread" : "empty";
    } else {
      S.backTo = S.view;
    }
    S.view = view;
  }

  for (const node of $$(".view")) node.classList.toggle("on", node.id === `v-${view}`);

  const isSub = !!VIEW_TITLE[view];
  $("#barMain").hidden = isSub;
  $("#barSub").hidden = !isSub;
  if (isSub) $("#subTitle").textContent = VIEW_TITLE[view];

  for (const id of ["btnHistory", "btnNew", "btnBook", "btnSettings"]) {
    const btn = $(`#${id}`);
    if (btn) btn.classList.toggle(
      "on",
      (id === "btnHistory" && view === "history") ||
        (id === "btnBook" && view === "bookmarks") ||
        (id === "btnSettings" && (view === "settings" || view === "perms"))
    );
  }

  $("#dock").classList.toggle("hide", !["empty", "thread"].includes(view));
  $("#toolbar").hidden = view !== "thread" || !S.thread?.messages.length;

  if (view === "history") renderHistory();
  if (view === "bookmarks") renderBookList();
  if (view === "settings") renderSettings();
  if (view === "perms") renderSites();

  if (view === "thread") scrollToEnd(false);
}

/* ================================ page ================================ */

async function refreshPage() {
  const tab = await pageApi.pickTab();
  S.tab = tab || null;
  S.page = null;
  S.pageError = "";

  if (!tab) {
    S.pageError = "没有可读的标签页";
    paintPage();
    return;
  }
  if (pageApi.isWebUrl(tab.url)) {
    await chrome.storage.local.set({ lastTabId: tab.id }).catch(() => {});
  }

  if (!pageApi.isWebUrl(tab.url)) {
    S.pageError = tab.url ? "这类页面浏览器不允许读取" : "这个标签页还没有读取权限";
    paintPage();
    return;
  }

  const res = await pageApi.readPage(tab.id);
  if (res.ok) S.page = res.page;
  else S.pageError = res.message;
  paintPage();
  detectForm();
}

function paintPage() {
  const title = S.page?.title || S.tab?.title || "当前标签页";
  const url = S.page?.url || S.tab?.url || "";
  const host = hostOf(url);

  $("#pageTitle").textContent = title || "当前标签页";
  $("#pageDomain").textContent = S.page
    ? host
    : S.pageError || "—";
  $("#pageFav").textContent = url ? letterOf(url) : "?";
  $("#pageFav").style.background = url ? favColor(url) : "var(--faint)";

  const meta = $("#pageMeta");
  if (S.page) {
    meta.hidden = false;
    $("#metaChars").textContent = S.page.text.length.toLocaleString();
    $("#metaParas").textContent = S.page.paragraphs;
    $("#metaSel").textContent = S.page.selection
      ? `选区 ${S.page.selection.length} 字`
      : "无选区";
  } else {
    meta.hidden = true;
  }

  const canRead = !!S.page;
  for (const tile of $$(".tile")) {
    tile.disabled = !canRead && ["summary", "translate"].includes(tile.dataset.act);
  }
  $("#allowBtn").hidden = canRead;

  paintAttach();
  paintPermStat();
}

/** Capability hint: if the page has fillable fields, offer filling right away. */
async function detectForm() {
  S.formCount = 0;
  if (!S.page || !S.tab) {
    paintFormQuick();
    return;
  }
  const scan = await pageApi.scanForm(S.tab.id, { mark: false });
  S.formCount = scan.fields?.length || 0;
  paintFormQuick();
}

function paintFormQuick() {
  const btn = $("#formQuick");
  btn.hidden = !S.formCount;
  btn.innerHTML = `${ic("form")}识别到 <b>${S.formCount}</b> 个可填字段 · 点这里填`;
}

function paintAttach() {
  const title = S.page?.title || S.tab?.title || "";
  $("#attTitle").textContent = S.page
    ? truncate(title || hostOf(S.page.url), 34)
    : S.pageError || "未连接页面";
  $("#attFav").textContent = S.page ? letterOf(S.page.url) : "?";
  $("#attFav").style.background = S.page ? favColor(S.page.url) : "var(--faint)";
  $("#attLab").textContent = S.page ? "附带" : "仅对话";
  $("#attachToggle").checked = !!S.settings?.sendContext;
  $("#attachToggle").disabled = !S.page;
}

function openPageSheet() {
  if (!S.page) {
    openSheet({
      html: `<h3>读不到这个页面</h3>
        <p>${escapeHtml(S.pageError || "这个页面没有可读正文")}</p>
        <p>如果这是普通网站，点下面的按钮授权；如果是 <span class="k">chrome://</span> 或商店页面，浏览器不允许任何扩展读取。</p>
        <div class="sheet-actions"><button class="btn ghost" data-x="ok">知道了</button></div>`,
      actions: { ok: () => true },
    });
    return;
  }
  const p = S.page;
  openSheet({
    html: `<h3>这一页的上下文</h3>
      <div class="kv"><b>标题</b><span>${escapeHtml(p.title || "—")}</span></div>
      <div class="kv"><b>链接</b><span>${escapeHtml(p.url)}</span></div>
      <div class="kv"><b>正文</b><span>${p.text.length.toLocaleString()} 字 · ${p.paragraphs} 段</span></div>
      <div class="kv"><b>选区</b><span>${p.selection ? escapeHtml(truncate(p.selection, 120)) : "无"}</span></div>
      ${p.description ? `<p style="margin-top:10px">${escapeHtml(p.description)}</p>` : ""}
      <div class="sheet-actions">
        <button class="btn ghost" data-x="copy">复制链接</button>
        <button class="btn ghost" data-x="open">打开</button>
      </div>
      <div class="sheet-actions"><button class="btn primary" data-x="ok">关闭</button></div>`,
    actions: {
      copy: () => {
        navigator.clipboard.writeText(p.url).then(() => toast("链接已复制"), () => toast("复制失败"));
        return false;
      },
      open: () => {
        if (S.tab?.id) chrome.tabs.update(S.tab.id, { active: true });
        return false;
      },
      ok: () => true,
    },
  });
}

async function allowCurrentSite() {
  const url = S.tab?.url || S.page?.url;
  if (!url || !pageApi.isWebUrl(url)) {
    openSheet({
      html: `<h3>允许读取哪个网站？</h3>
        <p>浏览器没把当前标签页的地址交给扩展，手动填一次域名即可。</p>
        <label class="field"><span>网址</span><input id="ffUrl" type="text" placeholder="https://example.com/article" /></label>
        <div class="sheet-actions">
          <button class="btn ghost" data-x="no">取消</button>
          <button class="btn primary" data-x="yes">授权</button>
        </div>`,
      actions: {
        yes: async () => {
          const raw = $("#ffUrl")?.value.trim();
          if (!raw) return "keep";
          const ok = await pageApi.requestSiteAccess(raw);
          toast(ok ? "已允许读取这个网站" : "没有授权");
          await refreshSites();
          await refreshPage();
        },
        no: () => true,
      },
    });
    return;
  }
  const ok = await pageApi.requestSiteAccess(url);
  toast(ok ? "已允许读取这个网站" : "没有授权");
  await refreshSites();
  await refreshPage();
}

/* ================================ status ================================ */

async function refreshStatus(verbose = false) {
  paintPill("busy", "检测中");
  const d = await diagnose(S.settings);
  S.diag = d;
  paintPill(...pillFor(d));
  paintConn(d);
  paintPermStat();

  if (d.state === "ok" && d.agents?.length) {
    const sel = $("#setAgent");
    const current = S.settings.agentId || "default";
    sel.innerHTML = d.agents
      .map(
        (a) =>
          `<option value="${escapeHtml(a.id)}"${a.id === current ? " selected" : ""}>${escapeHtml(a.name)}（${escapeHtml(a.id)}）</option>`
      )
      .join("");
    if (!d.agents.some((a) => a.id === current)) sel.value = d.agents[0].id;
  } else if (d.state === "needs-token") {
    $("#setAgent").innerHTML = `<option value="${escapeHtml(S.settings.agentId || "default")}">${escapeHtml(S.settings.agentId || "default")}</option>`;
  }
  if (verbose) toast(d.state === "ok" ? `连接正常 · ${d.ms}ms` : d.message);
}

function pillFor(d) {
  if (!d) return ["warn", "检测中"];
  if (d.state === "ok") return ["ok", "在线"];
  if (d.state === "needs-token") return ["warn", "需要令牌"];
  if (d.state === "unreachable") return ["bad", "未连接"];
  return ["bad", "连接异常"];
}

function paintPill(cls, text) {
  const pill = $("#pill");
  pill.className = `pill ${cls}`;
  $("#pillText").textContent = text;
}

function paintConn(d) {
  const dot = $("#connDot");
  const title = $("#connTitle");
  const sub = $("#connSub");
  if (!d) {
    dot.className = "sdot";
    title.textContent = "未检测";
    sub.textContent = "—";
    return;
  }
  dot.className = `sdot ${d.state === "ok" ? "ok" : d.state === "needs-token" ? "warn" : "bad"}`;
  title.textContent =
    d.state === "ok" ? "已连接" : d.state === "needs-token" ? "需要授权" : "连不上";
  const agentName = S.diag?.agents?.find((a) => a.id === S.settings.agentId)?.name;
  sub.textContent = `${S.settings.baseUrl} · ${d.state === "ok" ? `${d.ms}ms` : d.message}${agentName ? ` · ${agentName}` : ""}`;
}

/* ================================ permissions ================================ */

/** The instance host is already covered by host_permissions; it is not a
 *  "site the user granted", so keep it out of the visible list. */
function isAgentSite(origin) {
  try {
    const norm = (h) => (h === "localhost" ? "127.0.0.1" : h);
    const host = new URL(origin.replace(/\/\*$/, "")).hostname;
    const agent = new URL(S.settings.baseUrl).hostname;
    return norm(host) === norm(agent);
  } catch {
    return false;
  }
}

async function refreshSites() {
  const origins = await pageApi.grantedOrigins();
  S.sites = origins.filter((o) => o !== "<all_urls>" && !isAgentSite(o));
  paintPermStat();
  if (S.view === "perms") renderSites();
}

function paintPermStat() {
  $("#permCount").textContent = S.sites.length;
  $("#permCount2").textContent = S.sites.length;
  $("#permDot").classList.toggle("on", S.sites.length > 0);
  const d = S.diag;
  $("#permConn").textContent =
    d?.state === "ok" ? "已连接 agent" : d?.state === "needs-token" ? "需要令牌" : "未连接";
}

function renderSites() {
  const list = $("#siteList");
  list.textContent = "";
  if (!S.sites.length) {
    list.append(
      el("div", { class: "empty-hint" }, el("b", { text: "还没有授权的网站" }), "点开面板时浏览器会临时授权当前标签页；要长期读取就加一个。")
    );
    return;
  }
  for (const origin of S.sites) {
    const host = origin.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
    const row = el("div", { class: "site-item" });
    const label = el("div", { class: "site-host", text: host });
    const tag = el("span", { class: "site-tag", text: "已授权" });
    const sw = el("label", { class: "switch sm" });
    const input = el("input", { type: "checkbox", checked: true });
    input.onchange = async () => {
      const removed = await chrome.permissions.remove({ origins: [origin] });
      toast(removed ? `已撤销 ${host}` : "撤销失败");
      await refreshSites();
      await refreshPage();
    };
    sw.append(input, el("i"));
    row.append(label, tag, sw);
    list.append(row);
  }
}

function addSiteSheet() {
  openSheet({
    html: `<h3>添加网站</h3>
      <p>只给这一个站点读取权限，不碰其它页面。</p>
      <label class="field"><span>网址</span><input id="ffSite" type="text" placeholder="https://example.com" /></label>
      <div class="sheet-actions">
        <button class="btn ghost" data-x="no">取消</button>
        <button class="btn primary" data-x="yes">添加</button>
      </div>`,
    actions: {
      yes: async () => {
        const raw = $("#ffSite")?.value.trim();
        if (!raw) return "keep";
        let url = raw;
        if (!/^https?:/i.test(url)) url = `https://${url}`;
        const ok = await pageApi.requestSiteAccess(url);
        toast(ok ? "已添加" : "没有授权");
        await refreshSites();
        await refreshPage();
      },
      no: () => true,
    },
  });
}

/* ================================ thread ================================ */

function newThread(showToast = false) {
  S.thread = store.makeThread(S.page);
  S.lastAnswer = "";
  $("#msgs").textContent = "";
  setView("empty");
  if (showToast) toast("新对话");
}

function ensureThread() {
  if (!S.thread) S.thread = store.makeThread(S.page);
  return S.thread;
}

function buildPrompt(userText) {
  const parts = [PREAMBLE, ""];
  if (S.settings.sendContext && S.page) {
    parts.push(
      `【当前页面】\n标题：${S.page.title}\n链接：${S.page.url}` +
        (S.page.selection ? `\n用户选中了：${S.page.selection}` : "") +
        `\n\n正文：\n${S.page.text.slice(0, 9000)}`
    );
    parts.push("");
  }
  parts.push(`【用户】\n${userText}`);
  return parts.join("\n");
}

async function send(text, { promptText = null, label = null } = {}) {
  const q = String(text || "").trim();
  if (!q || S.busy) return;

  const thread = ensureThread();
  const shown = label || q;
  thread.messages.push({ role: "user", text: shown, at: new Date().toISOString() });
  const aiMsg = { role: "ai", text: "", pending: true, at: new Date().toISOString() };
  thread.messages.push(aiMsg);
  S.lastAnswer = "";

  $("#input").value = "";
  autoGrow();
  setView("thread");
  renderThread();
  setBusy(true);

  const body = $("#msgs").lastElementChild?.querySelector(".ai");
  let raf = 0;
  const paint = () => {
    raf = 0;
    if (body) body.innerHTML = renderMarkdown(aiMsg.text);
    scrollToEnd();
  };
  const onDelta = (delta) => {
    aiMsg.text += delta;
    if (!raf) raf = requestAnimationFrame(paint);
  };

  const controller = new AbortController();
  S.abort = controller;
  try {
    const answer = await chatStream(S.settings, promptText || buildPrompt(q), thread.sid, {
      onDelta,
      signal: controller.signal,
      onRelay: () => toast("实例网关拦了直连，已改为页内中转"),
    });
    cancelAnimationFrame(raf);
    aiMsg.text = answer || aiMsg.text;
    aiMsg.pending = false;
    S.lastAnswer = aiMsg.text;
    renderThread();
  } catch (err) {
    cancelAnimationFrame(raf);
    aiMsg.pending = false;
    if (err?.name === "AbortError") {
      aiMsg.error = "已停止";
    } else {
      aiMsg.error = String(err?.message || err);
      aiMsg.text = aiMsg.text || "";
    }
    renderThread();
    if (err?.name !== "AbortError") toast(aiMsg.error.slice(0, 60));
  } finally {
    setBusy(false);
    S.abort = null;
    await store.saveThread(thread);
    await store.setActiveThreadId(thread.id);
    paintClipsBadge();
  }
}

function setBusy(on) {
  S.busy = on;
  const btn = $("#send");
  btn.classList.toggle("stop", on);
  btn.title = on ? "停止" : "发送";
  btn.innerHTML = on ? '<span style="font-size:11px">■</span>' : ic("up");
  for (const tool of $$(".tool")) tool.disabled = on;
  if (on) paintPill("busy", "思考中");
  else paintPill(...pillFor(S.diag));
}

function renderThread() {
  const box = $("#msgs");
  box.textContent = "";
  if (!S.thread?.messages.length) return;
  S.thread.messages.forEach((msg, idx) => box.append(msgNode(msg, idx)));
  $("#toolbar").hidden = false;
  scrollToEnd(false);
}

function msgNode(msg, idx) {
  if (msg.role === "user") {
    return el("div", { class: "msg user" }, el("div", { class: "bubble", text: msg.text }));
  }
  const wrap = el("div", { class: "msg ai", "data-idx": String(idx) });
  const body = el("div", { class: "ai" });
  if (msg.pending) {
    body.innerHTML = '<span class="pending"><i></i><i></i><i></i></span>';
  } else if (msg.error) {
    body.innerHTML = `<div class="notice err">${escapeHtml(msg.error)}</div>` +
      (msg.text ? renderMarkdown(msg.text) : "");
  } else {
    body.innerHTML = renderMarkdown(msg.text || "");
  }
  wrap.append(body);
  if (!msg.pending && (msg.text || msg.error)) wrap.append(msgActions(msg));
  return wrap;
}

function msgActions(msg) {
  const bar = el("div", { class: "msg-actions" });
  const copy = el("button", { class: "mini-act", html: `${ic("copy")}复制` });
  copy.onclick = () => navigator.clipboard.writeText(msg.text || "").then(
    () => toast("已复制"),
    () => toast("复制失败")
  );
  const save = el("button", { class: "mini-act", html: `${ic("bookmark")}收藏` });
  save.onclick = () =>
    clipAnswer(msg.text).then(() => {
      save.innerHTML = `${ic("bookmark")}已收藏`;
      save.disabled = true;
    });
  bar.append(copy, save);
  return bar;
}

function scrollToEnd(smooth = true) {
  const view = $("#v-thread");
  if (!view) return;
  view.scrollTo({ top: view.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function autoGrow() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 116) + "px";
}

/* ================================ actions ================================ */

async function runAction(act) {
  if (S.busy) return toast("等这一轮答完");
  if (act === "clip") return clipPage();
  if (act === "form") return startFormFill();
  if (act === "fanti") return openHanMenu();

  if (act === "summary") {
    if (!S.page) return needPageToast();
    return send(SUMMARY_ASK, { label: "总结本页", promptText: buildPrompt(SUMMARY_ASK) });
  }
  if (act === "translate") {
    if (!S.page) return needPageToast();
    return send(TRANSLATE_ASK, { label: "全文翻译", promptText: buildPrompt(TRANSLATE_ASK) });
  }
}

function needPageToast() {
  toast("先授权读取这个页面");
}

async function clipPage() {
  if (!S.page) return needPageToast();
  const clip = {
    title: S.page.title,
    url: S.page.url,
    quote: S.page.selection || S.page.description || truncate(S.page.text, 300),
    note: "来自侧栏收藏",
  };
  const res = await chrome.runtime.sendMessage({ type: "clip", clip });
  if (res?.ok) toast(`已收藏 · 工作区第 ${res.count} 条`);
  else toast(res?.message || "已存本机，但没写进工作区");
  await refreshClips();
  return res;
}

async function clipAnswer(text) {
  const clip = {
    title: S.page?.title || S.thread?.pageTitle || "对话摘录",
    url: S.page?.url || S.thread?.pageUrl || "",
    quote: String(text || "").slice(0, 600),
    note: "来自对话",
  };
  const res = await chrome.runtime.sendMessage({ type: "clip", clip });
  if (res?.ok) toast("已收藏这条回答");
  else toast(res?.message || "收藏到本机，工作区同步失败");
  await refreshClips();
}

/* ------------------------------ 繁 / 简 ------------------------------ */

let hanModules = null;
const hanCache = new Map();

async function loadHan() {
  if (!hanModules) {
    const [cn2t, t2cn] = await Promise.all([
      import("../vendor/opencc/cn2t.js"),
      import("../vendor/opencc/t2cn.js"),
    ]);
    hanModules = { cn2t, t2cn };
  }
  return hanModules;
}

async function converter(target) {
  if (hanCache.has(target)) return hanCache.get(target);
  const mod = await loadHan();
  const opts =
    target === "cn" ? { from: "tw", to: "cn" } : target === "hk" ? { from: "cn", to: "hk" } : { from: "cn", to: "tw" };
  const fn = (target === "cn" ? mod.t2cn : mod.cn2t).Converter(opts);
  hanCache.set(target, fn);
  return fn;
}

function openHanMenu() {
  const text = S.lastAnswer || lastAiText();
  if (!text) return toast("先问一句，再来转换");
  openSheet({
    html: `<h3>繁简转换</h3>
      <p>转换这一轮的回答，原文仍保留在历史里。</p>
      <button class="menu-item" data-x="tw">${ic("swap")}转繁体（台湾）<span class="sub2">OpenCC</span></button>
      <button class="menu-item" data-x="hk">${ic("swap")}转繁体（香港）<span class="sub2">OpenCC</span></button>
      <button class="menu-item" data-x="cn">${ic("swap")}转简体<span class="sub2">OpenCC</span></button>`,
    actions: {
      tw: () => convertAnswer("tw"),
      hk: () => convertAnswer("hk"),
      cn: () => convertAnswer("cn"),
    },
  });
}

function lastAiText() {
  const list = S.thread?.messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "ai" && list[i].text) return list[i].text;
  }
  return "";
}

async function convertAnswer(target) {
  const list = S.thread?.messages || [];
  let idx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === "ai" && list[i].text) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return toast("没有可转换的回答");
  try {
    const fn = await converter(target);
    const before = list[idx].text;
    const after = fn(before);
    if (after === before) return toast("看起来已经是目标字形");
    list[idx].text = after;
    S.lastAnswer = after;
    renderThread();
    await store.saveThread(S.thread);
    toast(target === "cn" ? "已转为简体" : `已转为繁体（${target === "hk" ? "香港" : "台湾"}）`);
  } catch (err) {
    toast(`转换失败：${String(err?.message || err).slice(0, 40)}`);
  }
}

/* ------------------------------ form fill ------------------------------ */

async function startFormFill() {
  if (!S.tab || !pageApi.isWebUrl(S.tab.url)) return toast("这个页面不能填");
  if (!S.page) {
    const ok = await pageApi.requestSiteAccess(S.tab.url);
    if (!ok) return toast("要先授权读取这个网站");
    await refreshPage();
  }

  const scan = await pageApi.scanForm(S.tab.id, { mark: true });
  if (scan.error) return toast("读不到这个页面的表单");
  if (!scan.fields?.length) return toast("这一页没有可填的表单");
  S.formScan = scan;
  toast(`找到 ${scan.fields.length} 个字段，正在生成建议…`);

  let raw = "";
  try {
    raw = await chatStream(
      S.settings,
      pageApi.formPrompt(scan),
      `pawside-form-${S.thread?.id || S.tab.id}`,
      { timeoutMs: 90000 }
    );
  } catch (err) {
    return toast(`生成建议失败：${String(err?.message || err).slice(0, 50)}`);
  }

  const parsed = extractJson(raw);
  const list = Array.isArray(parsed) ? parsed : parsed?.fields;
  if (!Array.isArray(list) || !list.length) {
    return toast("模型没给出可用的填写建议");
  }

  const byIdx = new Map(scan.fields.map((f) => [f.idx, f]));
  const rows = list
    .map((item) => ({ ...item, field: byIdx.get(Number(item.idx)) }))
    .filter((item) => item.field && item.value != null && String(item.value).trim() !== "");
  if (!rows.length) return toast("模型认为这些字段都没法确定");

  openFormSheet(rows);
}

function openFormSheet(rows) {
  const html = `
    <h3>确认要填的内容</h3>
    <p>只会填入下面勾选的 ${rows.length} 项，不会点提交。提交前请自己再检查一遍。</p>
    ${rows
      .map(
        (r, i) => `<label class="ff-row">
          <input class="ff-check" type="checkbox" data-i="${i}" checked />
          <span class="ff-main">
            <span class="ff-label">${escapeHtml(r.field.label)}${r.field.required ? " · 必填" : ""}</span>
            <span class="ff-value">${escapeHtml(String(r.value))}</span>
            ${r.why ? `<span class="ff-why">${escapeHtml(String(r.why))}</span>` : ""}
          </span>
        </label>`
      )
      .join("")}
    <div class="sheet-actions">
      <button class="btn ghost" data-x="no">取消</button>
      <button class="btn primary" data-x="yes">填入</button>
    </div>`;

  openSheet({
    html,
    actions: {
      yes: async () => {
        const picked = [];
        for (const box of $$(".ff-check")) {
          if (!box.checked) continue;
          const row = rows[Number(box.dataset.i)];
          picked.push({ idx: row.field.idx, value: String(row.value) });
        }
        if (!picked.length) {
          toast("一项都没勾");
          return "keep";
        }
        const n = await pageApi.fillForm(S.tab.id, picked);
        toast(n ? `已填入 ${n} 项，未提交表单` : "没有字段被写入，可能页面结构变了");
        await refreshPage();
      },
      no: () => true,
    },
  });
}

/* ================================ history ================================ */

async function showHistory() {
  setView("history");
  renderHistory();
}

async function renderHistory() {
  const list = $("#historyList");
  list.textContent = "";
  const threads = await store.listThreads();
  if (!threads.length) {
    list.append(
      el("div", { class: "empty-hint" }, el("b", { text: "还没有历史" }), "问过的问题会留在这台电脑上，不上传。")
    );
    return;
  }
  for (const t of threads) {
    const row = el("div", { class: "thread-item", role: "button", tabindex: "0" });
    const main = el("div", { class: "thread-main" });
    main.append(
      el("div", { class: "thread-title", text: t.title || "未命名对话" }),
      el("div", {
        class: "thread-sub",
        text: `${fmtShort(t.updatedAt)} · ${t.messages.filter((m) => m.role === "user").length} 问 · ${hostOf(t.pageUrl) || "无页面"}`,
      })
    );
    const del = el("button", { class: "thread-del", text: "删除" });
    del.onclick = async (e) => {
      e.stopPropagation();
      await store.deleteThread(t.id);
      if (S.thread?.id === t.id) newThread();
      renderHistory();
      toast("已删除");
    };
    row.append(el("span", { class: "fav", html: '<svg style="width:12px;height:12px;fill:currentColor"><use href="#i-clock"/></svg>' }), main, del);
    row.onclick = () => openThread(t);
    list.append(row);
  }
}

async function openThread(t) {
  S.thread = t;
  S.lastAnswer = lastAiText();
  setView("thread");
  renderThread();
  await store.setActiveThreadId(t.id);
}

/* ================================ bookmarks ================================ */

async function refreshClips() {
  S.clips = await store.listClips();
  paintClipsBadge();
  if (S.view === "bookmarks") renderBookList();
}

function paintClipsBadge() {
  const badge = $("#bookBadge");
  const n = S.clips.length;
  badge.hidden = n === 0;
  badge.textContent = n > 99 ? "99+" : String(n);
}

function showBookmarks() {
  setView("bookmarks");
  renderBookList();
}

function renderBookList() {
  const list = $("#bookList");
  list.textContent = "";
  if (!S.clips.length) {
    list.append(
      el("div", { class: "empty-hint" }, el("b", { text: "收藏夹是空的" }), "用「收藏本页」把网页存进 agent 的工作区。")
    );
    return;
  }
  for (const c of S.clips) {
    const key = store.clipKey(c);
    const row = el("div", { class: "book-item", role: "button", tabindex: "0" });
    const main = el("div", { class: "book-main" });
    main.append(
      el("div", { class: "book-title", text: c.title || hostOf(c.url) || "未命名" }),
      el("div", { class: "book-sub", text: `${hostOf(c.url)} · ${fmtWhen(c.savedAt)}` })
    );
    const del = el("button", { class: "book-del", text: "删除" });
    del.onclick = async (e) => {
      e.stopPropagation();
      const res = await chrome.runtime.sendMessage({ type: "clipDelete", key });
      S.clips = await store.listClips();
      paintClipsBadge();
      renderBookList();
      toast(res?.synced === false ? "已从本机删除，工作区稍后同步" : "已删除收藏");
    };
    const fav = el("span", { class: "fav", text: letterOf(c.url) });
    fav.style.background = favColor(c.url);
    row.append(fav, main, del);
    row.onclick = () => openClipSheet(c);
    list.append(row);
  }
}

function openClipSheet(c) {
  openSheet({
    html: `<h3>${escapeHtml(c.title || "收藏")}</h3>
      <p>${escapeHtml(hostOf(c.url))} · ${escapeHtml(fmtWhen(c.savedAt))}</p>
      ${c.quote ? `<div class="notice">${escapeHtml(truncate(c.quote, 260))}</div>` : ""}
      <div class="sheet-actions">
        <button class="btn ghost" data-x="copy">复制链接</button>
        <button class="btn primary" data-x="open">打开网页</button>
      </div>`,
    actions: {
      copy: () => {
        navigator.clipboard.writeText(c.url || "").then(() => toast("已复制"), () => toast("复制失败"));
        return false;
      },
      open: () => {
        if (c.url) chrome.tabs.create({ url: c.url });
      },
    },
  });
}

/* ================================ settings ================================ */

function renderSettings() {
  $("#setBase").value = S.settings.baseUrl;
  $("#setToken").value = S.settings.token || "";
  $("#optSelection").checked = !!S.settings.selectionEnabled;
  $("#optAttach").checked = !!S.settings.sendContext;
  for (const btn of $$("#themeSeg button")) btn.classList.toggle("on", btn.dataset.theme === S.theme);
  $("#connSub").textContent = S.settings.baseUrl;
  if (S.diag) paintConn(S.diag);
  paintPermStat();
}

async function saveConnection() {
  const baseUrl = ($("#setBase").value.trim() || DEFAULTS.baseUrl).replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) {
    $("#setBaseHint").textContent = "地址要以 http:// 或 https:// 开头";
    return;
  }
  const token = $("#setToken").value.trim();
  const agentId = $("#setAgent").value || S.settings.agentId || "default";
  S.settings = await saveSettings({ baseUrl, token, agentId, relayFor: "" });
  toast("已保存，检测中…");
  await refreshStatus(true);
  await refreshPage();
}

function pickTheme(theme) {
  S.theme = theme;
  store.setTheme(theme);
  applyTheme();
  renderSettings();
}

function applyTheme() {
  const dark =
    S.theme === "dark" ||
    (S.theme === "auto" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", !!dark);
}

window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (S.theme === "auto") applyTheme();
});

/* ------------------------------ token paths ------------------------------ */

function isLocalUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(url);
}

async function ensureAgentHost(baseUrl) {
  if (isLocalUrl(baseUrl)) return true;
  try {
    const origin = new URL(baseUrl).origin + "/*";
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

async function grabToken() {
  const baseUrl = ($("#setBase").value.trim() || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const msg = $("#grabMsg");
  msg.className = "probe";
  msg.textContent = "";

  if (!(await ensureAgentHost(baseUrl))) {
    msg.className = "probe err";
    msg.textContent = "没拿到这个域名的访问权限";
    return;
  }

  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    msg.className = "probe err";
    msg.textContent = "地址格式不对，要 http(s):// 开头";
    return;
  }

  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((t) => (t.url || "").startsWith(origin));
  if (!tab) {
    msg.className = "probe warn";
    msg.textContent = "没找到这个地址的后台标签页，已帮你打开 —— 登录完回来再点一次";
    await chrome.tabs.create({ url: baseUrl });
    return;
  }

  msg.textContent = "读取中…";
  let found;
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        let token = "";
        let agent = "";
        try {
          token = localStorage.getItem("qwenpaw_auth_token") || "";
        } catch {}
        try {
          agent = localStorage.getItem("qwenpaw-last-used-agent") || "";
        } catch {}
        if (!agent) {
          try {
            const raw = sessionStorage.getItem("qwenpaw-agent-storage");
            agent = JSON.parse(raw)?.state?.selectedAgent || "";
          } catch {}
        }
        return { token, agent };
      },
    });
    found = out?.result;
  } catch {
    msg.className = "probe err";
    msg.textContent = "读不到这个标签页，刷新一下后台页面再点";
    return;
  }

  if (!found?.token) {
    msg.className = "probe err";
    msg.textContent = "这个页面还没登录，先在后台里登录一次，再回来点这里";
    return;
  }

  $("#setToken").value = found.token;
  if (found.agent) {
    $("#setAgent").innerHTML = `<option value="${escapeHtml(found.agent)}">${escapeHtml(found.agent)}</option>`;
  }
  msg.className = "probe ok";
  msg.textContent = "已读取登录令牌，记得点「保存并检测」";
}

async function tokenFromAccount() {
  const baseUrl = ($("#setBase").value.trim() || DEFAULTS.baseUrl).replace(/\/+$/, "");
  const username = $("#loginUser").value.trim();
  const password = $("#loginPass").value;
  const msg = $("#loginMsg");
  msg.className = "probe";
  if (!username || !password) {
    msg.className = "probe err";
    msg.textContent = "填一下用户名和密码";
    return;
  }
  if (!(await ensureAgentHost(baseUrl))) {
    msg.className = "probe err";
    msg.textContent = "没拿到这个域名的访问权限";
    return;
  }
  msg.textContent = "换令牌中…";
  const r = await loginForToken(baseUrl, username, password);
  if (!r.ok) {
    msg.className = "probe err";
    msg.textContent = r.message;
    return;
  }
  $("#setToken").value = r.token;
  $("#loginPass").value = "";
  msg.className = "probe ok";
  msg.textContent = "已换到长期令牌（密码没有保存）";
}

/* ------------------------------ selection ------------------------------ */

async function toggleSelection(on) {
  if (on) {
    const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
    if (!granted) {
      $("#optSelection").checked = false;
      toast("需要「读取所有网站」才能划词");
      return;
    }
  }
  S.settings = await saveSettings({ selectionEnabled: on });
  const res = await chrome.runtime.sendMessage({ type: "syncSelection" });
  toast(res?.enabled ? "划词翻译已开启" : "划词翻译已关闭");
}

/* ------------------------------ agent select ------------------------------ */

$("#setAgent")?.addEventListener("change", async (e) => {
  S.settings = await saveSettings({ agentId: e.target.value });
  refreshStatus();
});

/* ================================ start ================================ */

boot().catch((err) => {
  console.error(err);
  toast(`面板启动失败：${String(err?.message || err).slice(0, 60)}`);
});