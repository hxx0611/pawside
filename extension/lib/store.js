// Local persistence: conversation threads, theme, bookmark helpers.
//
// Everything here stays in chrome.storage.local. The panel never uploads a
// thread; only the two things the user explicitly asks for (a page, a bookmark
// note) ever leave the browser.

const MAX_THREADS = 40;

export function makeThread(page) {
  const id = (crypto.randomUUID && crypto.randomUUID()) || `t-${Date.now()}`;
  const now = new Date().toISOString();
  return {
    id,
    title: "",
    createdAt: now,
    updatedAt: now,
    sid: `pawside-${id}`,
    pageUrl: page?.url || "",
    pageTitle: page?.title || "",
    messages: [],
  };
}

export async function listThreads() {
  const { threads = [] } = await chrome.storage.local.get("threads");
  return [...threads].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getThread(id) {
  const threads = await listThreads();
  return threads.find((t) => t.id === id) || null;
}

export async function saveThread(thread) {
  const threads = await listThreads();
  const idx = threads.findIndex((t) => t.id === thread.id);
  thread.updatedAt = new Date().toISOString();
  if (!thread.title) {
    const firstUser = thread.messages.find((m) => m.role === "user");
    thread.title = (firstUser?.text || thread.pageTitle || "新对话").replace(/\s+/g, " ").slice(0, 48);
  }
  if (idx >= 0) threads[idx] = thread;
  else threads.unshift(thread);
  const kept = threads
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, MAX_THREADS);
  await chrome.storage.local.set({ threads: kept });
  return thread;
}

export async function deleteThread(id) {
  const threads = await listThreads();
  await chrome.storage.local.set({ threads: threads.filter((t) => t.id !== id) });
}

export async function clearThreads() {
  await chrome.storage.local.set({ threads: [] });
}

export async function getActiveThreadId() {
  const { activeThreadId } = await chrome.storage.local.get("activeThreadId");
  return activeThreadId || null;
}

export async function setActiveThreadId(id) {
  await chrome.storage.local.set({ activeThreadId: id || "" });
}

/* ------------------------------ theme ------------------------------ */

export async function getTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  return ["light", "dark", "auto"].includes(theme) ? theme : "auto";
}

export async function setTheme(theme) {
  await chrome.storage.local.set({ theme });
}

/* ------------------------------ clips ------------------------------ */

export const clipKey = (c) => `${c.savedAt || ""}|${c.url || ""}`;

export async function listClips() {
  const { clips = [] } = await chrome.storage.local.get("clips");
  return clips;
}

export async function deleteClip(key) {
  const clips = await listClips();
  const kept = clips.filter((c) => clipKey(c) !== key);
  await chrome.storage.local.set({ clips: kept });
  return kept;
}