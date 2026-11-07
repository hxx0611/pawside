# PawSide 0.4.1 — 版本提示 + 弹层里的话不再挡按钮

两件事，都是 0.4.0 遗留的：

1. **用户不知道有新版本。** 手动加载的扩展没有自动更新通道，0.4.0 之前靠读 README 才知道新版。
2. **填表弹层被 toast 盖住。** 点「填表」会先弹一句「找到 3 个字段，正在生成建议…」，
   那句话停在 `bottom: 76px`，正好压在弹层的「取消 / 填入」上，约两秒点不到按钮。

## 改了什么

### `extension/lib/update.js`（新增）

- `checkLatest(force)`：请求 `api.github.com/repos/hxx0611/pawside/releases/latest`，
  取 `tag_name` / `html_url` / 正文前两行；结果写 `chrome.storage.local` 的 `update.checked`，
  **24 小时内不再发请求**（打开设置页零网络）。
- 失败一律静默：断网、被墙、GitHub 限流都只会被记成「试过了」，不弹错误 ——
  版本检查失败不该变成一个用户看不懂的报错。
- `isNewer()` 逐段比数字，`0.4.10 > 0.4.9`，遇到 `-beta` 后缀也不炸。

### `sidepanel.js` / `sidepanel.html` / `sidepanel.css`

- 设置页底部新增一行 `#updRow`（默认 `hidden`）：`v9.9.9 可用（你在 v0.4.1）` + 「去更新」按钮，
  点击 `chrome.tabs.create` 打开 Release 页。文案带「去 Release 页下新的 ZIP，解压覆盖原文件夹」。
- 齿轮按钮上加一个小绿点（`.icon-btn.dot`）—— 不进设置页也能看见有新版本。
- 版本说明下面一行「检查更新」链接，点了强制重新查（绕过 24 小时缓存），
  查完文案变成「已是最新（v0.4.1）」或「v9.9.9 可用 · 再看一次」。

### 弹层遮挡

- `.toast` 层级 30 → 50；`openSheet` / `closeSheet` 给 `body` 加/去 `.sheet-open`；
  `body.sheet-open .toast { top: 10px }` 把 toast 从底部挪到顶部。
  弹层在场时顶部那一条（标题栏）本来就被遮罩盖住、点不了，让 toast 去那里不挡任何可用按钮。

## 为什么不做「自动更新」

`chrome.runtime.requestUpdateCheck()` 对手动加载（unpacked）的扩展永远返回
`no_update` —— 那条通道只对商店安装的版本生效；扩展也没有权限覆盖自己磁盘上的文件。
所以能做到的上限就是「发现 → 提示 → 你点一下去 Release」。README 里也这么写，不吹。

## 验证

`spike/test_v5.py`（新增，13 项，全绿）：

| 检查 | 结果 |
|---|---|
| 发现新版本（route 返回 v9.9.9） | ✅ 标题 `v9.9.9 可用（你在 v0.4.1）` |
| 「去更新」按钮文案 | ✅ |
| 齿轮小点出现 / 已是最新时消失 | ✅ / ✅ |
| 点「去更新」打开 Release 页 | ✅ `https://github.com/hxx0611/pawside/releases/tag/v9.9.9` |
| 已是最新时不出现提示行 | ✅ 链接文案 `已是最新（v0.4.1）` |
| 弹层在场时 `body.sheet-open` | ✅ |
| toast 移到顶部 | ✅ `top = 10` |
| 「填入」按钮命中测试 | ✅ `elementFromPoint` 落在按钮上 |
| 填表仍然真的写入 | ✅ `input[name=name] = 张三` |
| 关掉弹层后 class 清干净 | ✅ |
| 页面零报错 | ✅ |

回归：`spike/test_v4.py` 22 项全过（0 失败）。

**真网再验一次**（不拦截 `api.github.com`，让扩展自己 fetch）：
点「检查更新」→ 链接变成 `已是最新（v0.4.1）`，`update.checked.latest = "0.4.1"`，页面零报错。
也就是说 GitHub releases 接口的 `access-control-allow-origin: *` 确实够用，
**不需要为此加任何 host permission**（装的时候不会多一条「读取你在 github.com 上的数据」）。
Release 正文里的 `**加粗**` 会在纯文本界面里变成一排星号，所以 notes 落地前先剥掉 `*` 和反引号。

打包校验：`dist/pawside-0.4.1.zip`（21 文件 / 568,729 B）解压到 `/tmp/pkgtest2` 后
两套测试重跑，`v5 exit=0`（13/13）、`v4 exit=0`（22/22）。

## 留着的坑

- `test_v5.py` 里「点填表」那一步偶发一次超时：`#backBtn` 回到空态时视图还在过渡，
  紧接着点 `#formQuick` 会点空。已加 `scrollIntoView` + 90 s 等待缓解，属于测试脚本的时序问题，
  不是扩展的行为问题。
- 版本号 `0.4.10` 这类两位数补丁号只在 `isNewer` 的逐段比较里正确处理；
  Release tag 请保持 `vX.Y.Z` 形式。