// 版本检查：只问一句「GitHub 上最新的是哪个版本」。
//
// 为什么不做得更「自动」：
//   1. 手动加载（unpacked）的扩展调 chrome.runtime.requestUpdateCheck() 永远返回
//      no_update，那条通道只对从 Chrome 商店安装的版本有效；
//   2. 扩展也没有权限覆盖自己磁盘上的文件，所以「下载并替换」做不到。
// 能做到的上限就是这里的样子：发现新版本 → 摆在设置页 → 你点一下去 Release 页。
//
// 另外 GitHub 的 releases 接口带 access-control-allow-origin: *，
// 所以直接 fetch 不需要任何额外 host permission，装的时候不会多一条授权警告。

const ENDPOINT = "https://api.github.com/repos/hxx0611/pawside/releases/latest";
const STORE_KEY = "update.checked";
const EVERY = 24 * 60 * 60 * 1000; // 一天最多问一次，不打扰

const clean = (v) => String(v || "").trim().replace(/^v/i, "");

/** 只比较数字段，遇到 "0.4.0-beta" 这种也能用。 */
export function isNewer(latest, current) {
  const a = clean(latest).split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const b = clean(current).split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function remember(rec) {
  return chrome.storage.local.set({ [STORE_KEY]: rec }).catch(() => {}).then(() => rec);
}

/**
 * 返回 { latest, url, notes, at, error? }。
 * force=false 且 24 小时内查过，直接给缓存 —— 打开设置页是零网络开销。
 */
export async function checkLatest(force = false) {
  const got = await chrome.storage.local.get(STORE_KEY).catch(() => ({}));
  const cached = got?.[STORE_KEY];
  if (!force && cached && Date.now() - (cached.at || 0) < EVERY) return cached;

  try {
    const res = await fetch(ENDPOINT, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // 只取「一句话摘要」：跳过 markdown 标题和空行，否则界面上会只剩个「改了什么」
    const notes = String(data.body || "")
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      // 去掉 markdown 记号：页面里是纯文本，留着 ** 会变成一排星号
      .map((l) => l.replace(/^[*\-\s]+/, "").replace(/[*`]/g, "").trim())
      .filter((l) => l && !l.startsWith("在线演示") && !l.startsWith("需要 Chrome"))
      .slice(0, 2);
    return remember({
      at: Date.now(),
      latest: clean(data.tag_name),
      url: data.html_url || "https://github.com/hxx0611/pawside/releases",
      notes,
    });
  } catch (err) {
    // 断网、被墙、限流都走这里。静默：只记下「试过了」，不弹任何错误。
    return remember({ at: Date.now(), latest: "", url: "", notes: [], error: String(err?.message || err) });
  }
}