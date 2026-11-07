# PawSide 0.3.0 — 连接向导改版记录

日期：2026-11-07 ｜ 起因：用户在托管实例上问「我到底该填什么才能获取访问令牌」

## 一、现场证据（来自用户截图）

| 事实 | 说明 |
|---|---|
| 服务地址 `https://019f9beb-…qwenpaw.platform` | 托管平台，租户子域名 |
| `测试连接` = 已连接 · 118ms | **假绿灯**：旧版只探 `/api/config/theme`（公开接口），地址通 ≠ 授权通 |
| `获取令牌` = HTTP 403 + Apache HTML 报错页 | 请求被平台网关拦下，根本没到 QwenPaw；界面把整页 HTML 原文糊了出来 |
| Agent ID `snooze` | 手填的，实例其实自己知道有哪些 agent |

结论：不是用户填错，是**登录接口对托管实例不可用**，而界面没有把这件事说清楚，还把最原始的 403 HTML 展示给用户。

## 二、四处产品问题

1. **三个技术字段并列**（地址/Agent ID/令牌），用户不知道哪个必须填、令牌去哪拿。
2. **「账号密码换令牌」被当成主路径**，但它只适用于自建且开了鉴权的实例；托管平台走不通。
3. **假绿灯**：探公开接口，给用户「地址没问题，只差令牌」的错误暗示。
4. **错误原文直出**：HTTP 状态码 + HTML 正文，既看不懂也不体面。

## 三、改版方案

### 结构：三步向导，每步只问一件事

```
① 你的 QwenPaw 在哪    输入地址 → 实时诊断卡（四种状态）
② 怎么证明是你         主按钮：从已登录的后台读取令牌
                       折叠：粘贴令牌 / 账号密码换
③ 用哪个 agent         连上后自动列出，下拉选
```

### 关键技术点：读取后台已登录的会话

QwenPaw 网页后台登录后把 JWT 存在 `localStorage["qwenpaw_auth_token"]`，当前 agent 存在
`localStorage["qwenpaw-last-used-agent"]` / `sessionStorage["qwenpaw-agent-storage"].state.selectedAgent`。

插件在用户点击时用 `chrome.scripting.executeScript` 到该域名的标签页里读这几个键，自动填令牌与 agent。
于是「令牌」这个概念对用户消失了 —— 只要他登录过网页后台，一步到位。

### 诊断状态机

| 状态 | 触发 | 文案 | 指示灯 |
|---|---|---|---|
| ok | `/api/config/theme` 200 且 `/api/agents` 200 | 已连接 · 12ms · 小蜗 | 绿 |
| needs-token | theme 200，agents 401/403 | 能连上 · 12ms · 需要授权 | 黄 |
| unreachable | fetch 抛错 / 超时 | 连不上 / 连接超时 + 按地址给原因 | 红 |
| error | 其它状态码 | 翻译后的人话 | 红 |

### 错误翻译表（`describeHttp`）

| 原始 | 给用户看 |
|---|---|
| 401 | 需要授权：令牌无效或已过期 |
| 403 + HTML（网关） | 被网关挡住了（403）。托管平台的登录接口通常只对自己的网页开放，请改用「从已登录的后台读取令牌」。 |
| 403 + JSON | 实例拒绝了请求（403）：这个令牌可能无权访问该 agent |
| 404 + HTML | 这个地址上没有 QwenPaw 接口（404），确认填的是后台首页地址 |
| 5xx | 服务端出错（5xx），看下服务日志 |

HTML 正文一律不进 UI（测试里显式断言页面文本不含 `DOCTYPE` / `<html`）。

### 一致性修复

- 地址改了但没保存时，agent 下拉会清空并提示「连上后自动列出这台实例的 agent」，避免把上一个实例的列表当作这个实例的。
- 指示灯、诊断卡、底部状态三处由同一个 `paint()` 输出，不再各自为政。

## 四、验证

新增 `spike/test_wizard.py`：起一个本地 mock 网关，**复刻用户遇到的现场** ——
`GET /api/config/theme` 200、`GET /api/agents` 401、`POST /api/auth/login` 返回 Apache 风格 HTML 403。

| 用例 | 断言 | 结果 |
|---|---|---|
| 第 1 步诊断 | 文案含「需要授权」，指示灯 `warn` | ✅ |
| 账号密码换令牌遇到网关 403 | 文案含「网关」，页面无 `DOCTYPE` / `<html>` | ✅ |
| 从已登录标签页读令牌 | `#token === tok-live-42`，agent 自动选中 `snooze`，探测转绿 | ✅ |
| 没有已登录标签页 | 提示「先帮你打开」，并真的打开一个标签页 | ✅ |
| 稳定性 | 连跑 3 次全绿 | ✅ |

回归：`spike/test_v2.py`（真实本机实例，总结/翻译/收藏/划词）exit 0、`pageErrors: []`；
`spike/test_login.py`（空值/错密码/未开鉴权/成功）PASS。

## 五、仍未做

- 令牌过期（默认 7 天）后不会自动续期；目前靠重新点一次「读取令牌」。
- 读写 `localStorage` 依赖后台把令牌放在这个 key 上；QwenPaw 改 key 名会失效（已在 README 标注来源）。
- 多账号/多 agent 云实例的切换仍靠下拉，没有「工作区」概念。
## v0.3.1 — 托管实例 403（网关只放行同源请求）

现象：向导「已连接 ·115ms」，但发消息/总结本页返回 `403 <!DOCTYPE HTML PUBLIC ...>Apache/2.4.41`。

根因：实例前面的网关对**非自己页面发起的 POST** 一律返回 403 HTML
（GET `/api/config/theme`、`/api/agents` 放行，因此体检是假绿）。

修复：`content/relay.js` + 后台派发。直连被判定为网关拦截时，改在实例自己的
origin 的标签页里发同源 POST（与网页后台同一条路径，带 cookie），SSE 字节经
`chrome.runtime.sendMessage` 流回侧栏；成功后记 `relayFor=<baseUrl>`，下一轮直接
走中转，换地址即失效。

验证：`spike/test_relay.py`（mock 网关只接受 `Sec-Fetch-Site: same-origin`）
— 直连 403 → 中转拿全文、中转标签页不可见、第二轮省掉必败直连、收藏上传走中转、
零 pageError；`test_v2.py` / `test_wizard.py` 无回归；打好的 zip 解压重跑同一测试通过。
