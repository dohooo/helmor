# Mobile Browser Companion — 设计与实现计划

> **状态**:设计草案(investigation 已完成,代码未动)
> **分支**:`claude/dreamy-gauss-qtHT2`
> **一句话**:不做独立移动端 App,而是把桌面端那套已做过响应式的前端**原样**透传到手机浏览器,手机通过一个公网地址直接操作家里那台电脑上的 Helmor 后端。

---

## 0. 与既有提案文档的关系(重要事实校正)

仓库里曾流传一份《Helmor Mobile Companion 架构设计》文档,描述了 `src-tauri/src/companion/`、axum、cloudflared、`paired_devices` 表、`apps/app`(Vercel 后端)、`apps/mobile`(Expo RN)等"P0+P1 已完成"的基础设施。

**经核实,这些代码在当前仓库中一行都不存在**:

- `src-tauri/src/companion/` 不存在
- `src-tauri/Cargo.toml` 无 axum / tower-http / cloudflared
- 无 `paired_devices` 相关代码
- `apps/` 下只有 `marketing`(无 `app`、无 `mobile`)

结论:那份文档是**提案**,不是已落地代码。本计划在**干净的 greenfield** 上推进,并且**用浏览器复用方案取代该提案中的 Expo RN 路线**——`apps/mobile` 不再需要。

隧道层(cloudflared 出向 QUIC + helmor.ai CNAME 写入)的设计仍然有效,可作为本方案的"公网可达层"后置复用。

---

## 1. 目标

- G1:手机浏览器通过一个公网地址访问家里电脑上运行的 Helmor 后端,跨 NAT/CGNAT 成立。
- G2:**复用同一套前端**(桌面已做响应式),手机端不重写界面、不出独立 App。
- G3:对现有代码**改动最小**;`api.ts`(4500 行)除 import 行外不动。
- G4:local-first 不变——用户数据只在本机;公网层只搬运密文流量,Helmor 自身不持有用户数据。

非目标(本阶段不做):端到端加密 mTLS/Noise、推送通知、离线缓存、多用户协作、手机原生模块。

---

## 2. 三路调查结论(事实基础)

### 2.1 前端 IPC 耦合面

- `src/lib/api.ts`:**48 个不同 `invoke()` 命令、约 166 处调用**,**无统一包装**,每个函数各自直接调用。
- 但通信只来自三个原语,即天然收口点:
  - `invoke` / `Channel`(`@tauri-apps/api/core`)
  - `listen`(`@tauri-apps/api/event`)
- **`Channel<T>` 流式共 10 处**,关键:
  - `send_agent_message_stream`(`AgentStreamEvent`,主流式路径)
  - `subscribe_ui_mutations`(`UiMutationEvent`,状态同步骨架)
  - 其余:脚本执行、终端、本地 LLM 下载、Slack 进度等。
- **`listen()` 事件**:`app-update-status`、`git-branch-changed`、`git-refs-changed`、`archive-execution-*`,以及 `helmor://` 窗口生命周期事件。
- **运行环境探测已存在**:`src/lib/platform.ts` 的 `isTauriRuntime()`(查 `window.__TAURI__` / `__TAURI_INTERNALS__`)——这是分叉点,无需新造。
- **插件依赖**(浏览器需降级):`@tauri-apps/plugin-dialog`(文件选择,5 文件)、`@tauri-apps/plugin-opener`(`openUrl`,14 文件)、`@tauri-apps/plugin-notification`(通知)、窗口/webview(zoom、关闭、dock badge)。

### 2.2 后端可复用性

- 当前**无任何 HTTP 服务器**(无 axum/tower、无 ServeDir、无 auth 中间件)——干净起点。
- 约 **219 个 `#[tauri::command]`**,但 ~80% 零 Tauri 耦合;`service.rs` 本就是"为非 Tauri 消费者设计的门面",re-export 了大量纯域函数。
- 流式核心(`agents/streaming/`)**业务无关**,只负责 emit 事件;`service::send_message(params, &mut on_event)` **本就收回调而非 Channel**。
- `AgentStreamEvent` 等枚举已 `#[derive(Serialize)]`,直接可 JSON 化为 SSE。
- 对 Tauri 机制的强耦合仅三类,且都可处理:`Channel`(→回调/SSE)、`AppHandle`(可选 UI 副作用)、`State`(依赖注入)。

### 2.3 前端可服务性

- `vite.config.ts` **无固定 base path、无硬编码 host**,`dist/` 可在任意隧道域名下托管。
- Monaco 由 Vite 打包(`?worker`),不依赖 CDN,浏览器可用。
- 响应式**部分完成**:`src/hooks/use-mobile.ts`(768px)、移动端侧栏抽屉存在;但**核心三栏布局尚未做手机竖向重排**。功能复用立即成立,手机观感需一轮布局收尾。

---

## 3. 核心设计:三个决策

### 决策一:前端只 shim 三个原语,不碰 166 处调用

新建 `src/lib/ipc.ts`,导出同名 `invoke / Channel / listen`,内部按 `isTauriRuntime()` 分叉:

- **Tauri 环境** → 原样 re-export 真 Tauri 原语(行为零变化)。
- **浏览器环境** → 自实现:
  - `invoke(cmd, args)` → `fetch('/rpc/'+cmd, {POST, body:args, Bearer})` → JSON。
  - `Channel` → 带 `onmessage` 的类。`invoke` 扫描 args 是否含 Channel 实例;含则改打 `/rpc-stream/'+cmd`,把 SSE/NDJSON 逐帧解析后调 `onmessage`,流结束时 resolve。**忠实复刻 Tauri Channel 语义**。
  - `listen(event, cb)` → 复用一条全局 `/events` SSE,按事件名分发。

随后把 `api.ts` 的相关 import 由 `@tauri-apps/*` 改为 `@/lib/ipc`。**api.ts 除 import 行外一行不改。**

### 决策二:axum 跑在同一进程,后端命令"原样"复用

companion axum server 由 Tauri app 自身 spawn,**可在 router state 里持有真实 `AppHandle` 与 managed `State`**。于是 HTTP 路由用**真 AppHandle/State** 调用**与桌面相同的命令函数**:

- ~80% 命令零耦合,直接复用。
- UI sync 事件照常 publish → **手机操作时桌面 UI 也实时同步**(同一 `ui_sync` 广播,附带收益)。
- 唯一 HTTP 不存在的是 `Channel`;而流式核心本就收回调,只需把回调接到 SSE sink。

后端只需新增:

1. `POST /rpc/:cmd` —— 通用 dispatcher,对前端用到的非流式命令 `match`,带真 AppHandle/State 调底层函数。
2. `POST /rpc-stream/:cmd` —— 流式命令(`send_agent_message_stream`、脚本、下载等)接 SSE。
3. `GET /events` —— `subscribe_ui_mutations` + 各 `listen()` 事件合并为一条 SSE。
4. `ServeDir` —— 托管同一份 `dist/`。
5. Bearer PAT 中间件。

### 决策三:浏览器同源,配对无需原生 App

SPA 与 API 同源(同一隧道 host),shim 用相对路径,**零 CORS**。配对:

> 桌面弹 QR,编码 `https://remote-xxx.helmor.ai/#pat=hlm_xxx` → 手机相机扫码开浏览器 → SPA 读 `location.hash` 写 `localStorage` 并抹掉 hash → shim 自动注入 Bearer。

URL fragment 不发往服务器、不进访问日志(仅落浏览器历史;可用一次性 pairing code 换 PAT 加固)。

---

## 4. 实际改动清单

| 层 | 改动 | 体量 |
| --- | --- | --- |
| 前端核心 | 新增 `src/lib/ipc.ts`(transport shim);`api.ts` 改 import | 小,但是心脏 |
| 前端降级 | 新增 `src/lib/platform-bridge.ts` 包住插件调用:`openUrl`→`window.open`、文件选择器→`<input type=file>` 或隐藏、通知→Web Notifications | ~20 处,机械;多数已 gate `isTauriRuntime()` |
| 后端 | 新增 `src-tauri/src/companion/`:server + `/rpc` dispatch + `/rpc-stream` SSE + `/events` SSE + ServeDir + auth | 中,路由是薄壳 |
| 公网层 | cloudflared 出向隧道 spawn + helmor.ai CNAME(即旧提案隧道层) | 独立,可后置 |
| 布局 | 三栏 → 手机竖向重排(`useIsMobile` 768px 已有,主壳未真重排) | 独立 UI 收尾 |

---

## 5. 必须正视的尖角

1. **Channel→SSE 是技术核心风险**(但语义可完整复刻)。建议第一个做 PoC:跑通一条 `send_agent_message_stream` 即证明全盘可行。abort 用 `AbortController` 或沿用既有独立 abort 命令。
2. **会话级安全边界**:HTTP 路由带真 AppHandle/State,等于把整台桌面能力暴露给持 PAT 者。"view-only / drive 角色 + 工具白名单"必须在 `/rpc` dispatcher 这层落地,而非事后补。
3. **真正会破的少数功能**:`gh auth login` 终端登录、原生窗口模式、另存为/在 Finder 显示 —— 手机端隐藏或给降级路径;尤其 onboarding 登录不能挡住主流程。
4. **响应式部分完成**:功能复用立即成立,手机观感需一轮布局收尾。
5. **流式并发扇出**:多端订阅同一 session 需 `tokio::sync::broadcast` 总线,SSE 才能同时扇给桌面 UI + N 部手机。

---

## 6. 建议分阶段

### Slice 0 — 核心假设验证(先证明)

- 进程内起裸 axum(`127.0.0.1`)。
- `/rpc/:cmd` 只通 `list_workspace_groups` 一个命令 + 浏览器版 `invoke` shim → 本机浏览器开 `dist/` 能拉到工作区列表。
- `/rpc-stream` 打通一条 `send_agent_message_stream`。
- **验收**:两步绿 → 方案从"设计"变"确定可行",其余皆体力活。

### Slice 1 — 全量 RPC + 事件 + 静态托管

- `/rpc` dispatcher 覆盖 48 个前端命令;`/events` 合并 UI 同步与 listen 事件;ServeDir 托管 `dist/`;Bearer PAT 中间件 + `paired_devices`。
- `platform-bridge.ts` 收掉插件降级。

### Slice 2 — 公网可达

- cloudflared 出向隧道 + helmor.ai CNAME(复用旧提案隧道层);桌面 Settings → Experimental 增加"手机连接"配对面板(QR)。

### Slice 3 — 手机布局收尾 + 安全加固

- 三栏竖向重排;角色/工具白名单在 dispatcher 落地;`broadcast` 总线接 pipeline;(可选)mTLS/Noise。

---

## 7. 待用户进一步输入

- 公网层凭证(若走 helmor.ai 默认路径):Cloudflare API token(`Zone:DNS:Edit`,限 helmor.ai)+ Zone ID;以及 device/限流存储(可先内存版本地 dev)。
- 安全策略默认值:首版手机端是 view-only 还是 full-drive。
