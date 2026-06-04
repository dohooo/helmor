# Mobile Browser Companion — 设计与实现计划

> **状态**:Slice 0a 已实现并验证(见 §13)。设计部分见下文。
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

## 1.5 已锁定决策(与用户确认)

1. **终态走稳定 URL**(Named Tunnel + helmor.ai 子域)。理由:用户需求是"扫一次、以后直接打开手机浏览器就连上",要求 hostname 永久不变,Quick Tunnel 的漂移 URL 不满足。
   - **构建顺序**:本地 + Quick Tunnel 与稳定 URL 共用 ~95% 代码(axum + shim + 配对 + 二维码),差别只在"谁写 CNAME"。先用本地/Quick Tunnel 跑通整个闭环验证(**全程无需任何凭证**),最后补"委派子域 + 写 CNAME 小后端"即升级为永久稳定 URL。
2. **每台桌面一个唯一 hostname**:`<随机>.remote.helmor.ai`,各连各的电脑(海量动态 CNAME,每台一条)。
3. **zone 托管(已定)**:把 `remote.helmor.ai` 建成**独立 CF zone**,API token 只 scope 到该子 zone。
   - 理由:CF API token 最小粒度是 zone 级,无法限定到记录前缀。独立子 zone → 写 CNAME 的 token 即便泄漏/Worker 被攻陷也**碰不到 apex/营销站/邮件 MX**,炸毁半径最小。
   - 代价:hostname 多一层(`xxx.remote.helmor.ai` 而非 `remote-xxx.helmor.ai`),用户扫码无感。
3b. **CNAME-writer 小后端(已定)**:用 **Cloudflare Worker**(配 CF KV 存设备记录 + IP 限流),放进 monorepo **`apps/registry/`**(与 `apps/marketing` 并列)。取代旧提案的 Vercel+Upstash 方案——全在 CF 生态、不引第三方账号、token 不出 CF。职责:收 tunnel UUID → 在 `remote.helmor.ai` 写/删 CNAME → 签发并校验 device secret。
4. **手机端默认 full-drive**:能做全部操作(因为看到的就是响应式桌面前端,功能本应对等)。
   - 推论:`/rpc` dispatcher 首版**不做角色/工具白名单**(简化)。
   - 代价:手机 = 整台电脑完整控制权,因此**凭证安全模型必须首版就做扎实**(见下三条),不能推迟到后期。
5. **首版凭证安全三约束(不可省)**:
   - PAT 绝不外泄:只走 TLS、只存手机 Keychain/localStorage、入库只存 SHA-256 hash。
   - 每设备独立 PAT + 桌面一键 revoke(丢手机时单独踢)。
   - 二维码里放**周转的配对码(pairing code,短 TTL ~60s)而非长期工作 token**(见 §3 决策三)。
6. **环境限制**:开发容器无法真正启动 Tauri app / cloudflared 做端到端验证。代码、单测、类型可全部写绿,但"真机扫码"需在用户本地机器验证。

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

SPA 与 API 同源(同一隧道 host),shim 用相对路径,**零 CORS**。

**配对采用"周转配对码"模型(WhatsApp Web / Tailscale 同款),区分两类凭证:**

- **配对码(pairing code)**:短 TTL(~60s)、桌面端定时周转。二维码里放的是它,**不是**长期 token。
- **设备 PAT(工作 token)**:每设备专属、长期、可单独 revoke,存在手机 localStorage。

流程:

> 桌面 QR 编码 `https://remote-xxx.helmor.ai/#pair=<pairing-code>` → 手机相机扫码开浏览器 → SPA 读 hash 拿到配对码 → 用配对码向桌面握手 → 桌面**当场签发该设备专属长期 PAT** 回传 → SPA 写 localStorage、抹掉 hash → 之后 shim 自动注入 Bearer。

性质:

- 二维码可每 60s 安全周转(只是握手凭证,泄漏旧码很快失效)。
- 已配对手机各持自己的长期 PAT,**不受二维码周转影响**,继续可用。
- 丢手机 → 桌面设备列表单独 revoke 那一台。
- URL fragment 不发往服务器、不进访问日志(仅落浏览器历史;且只含短命配对码,非长期 token)。

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

## 7. 待用户进一步输入(均可延后到公网阶段,前期不阻塞)

- **zone 托管选型**(见 §1.5 决策 3):apex 放 CF 还是委派 `remote.helmor.ai` 子区——取决于 `helmor.ai` 当前 DNS 托管位置与是否愿动主域。
- **公网层凭证**(仅稳定 URL 阶段需要):Cloudflare API token(`Zone:DNS:Edit`,scope 到选定 zone)+ Zone ID;device/限流存储(可先内存版本地 dev)。
- 安全/权限默认值已定:**full-drive**(见 §1.5 决策 4)。

> 注:Slice 0–2(本地 + 局域网 + Quick Tunnel 公网闭环)**无需任何上述凭证**即可开发与验证。

---

## 13. 实现进度

### 13.1 Slice 0a — IPC transport seam + 后端 RPC 骨架(已实现并验证)

落地了"决策一/决策二"的最小可用核心:前端把 `invoke`/`Channel`/`listen` 收口到一个 shim,后端起一个 loopback axum 服务器用相同的域函数回应 RPC。**桌面与测试行为零变化**(分叉走 companion 标记,不是"非 Tauri")。

**新增文件**
- `src/lib/ipc.ts` — transport shim。`isCompanionClient()` 用 `window.__HELMOR_COMPANION__` 标记判定;非 companion 一律委派真/被 mock 的 Tauri 原语,并**保持原始调用 arity**(否则 `toHaveBeenCalledWith("cmd")` 类断言会挂)。companion 分支:`invoke`→`POST /rpc/{cmd}`(检测 `Channel` 参数则转 `/rpc-stream/{cmd}` NDJSON);`listen`→共享 `/v1/stream` SSE,按事件名分发(fetch streaming,非 `EventSource`,以便带 `Authorization` 头)。
- `src-tauri/src/companion/{mod,server,auth,rpc}.rs` — 服务器生命周期 + bearer 鉴权(constant-time)+ `GET /v1/health` + `POST /rpc/{cmd}`(派发 `list_workspace_groups` / `list_repositories` / `get_data_info` 三个纯读命令)+ `GET /v1/stream`(SSE keep-alive 骨架)。错误复用 `CommandError` 的 `{code,message}` 形态,浏览器侧报错与原生 IPC 一致。
- `src-tauri/tests/companion_http.rs` — 进程内集成测试。

**改动文件**
- `src/lib/api.ts` — 仅把 `invoke`/`Channel`/`listen`/`UnlistenFn` 的 import 从 `@tauri-apps/api/*` 改到 `./ipc`(其余 4500 行未动)。
- `src-tauri/src/lib.rs` — `pub mod companion;` + `.manage(CompanionState::new())` + setup 中 `HELMOR_COMPANION` env 门控启动 + `RunEvent::Exit` 优雅关闭。**默认行为不变**(未设 env 即完全不启)。
- `src-tauri/Cargo.toml` — 新增 `axum 0.8`、`tower-http(cors)`、`tokio-stream`、`futures`;tokio 加 `net` feature。

**验证结果**(本容器内实测)
- 前端 `typecheck`:通过。
- 前端测试套件:**1338/1338 通过**(import 调换零回归;曾见 1 例为已知 timing-flaky,重跑全绿)。
- Rust `cargo check`:**0 error**;companion 模块 clippy **零警告**。
- companion `auth` 单测:**5/5**。
- `companion_http` 集成测试:**1/1**(真起服务器,验 `/v1/health` 200、无/错 token 401、未知命令 400 带 `{code,message}`、shutdown 清理)。

> 环境备注:本容器为验证 Rust,临时安装了 Tauri 的 Linux 系统库(webkit2gtk 等),并用 `RUSTC_WRAPPER=""` 绕过未安装的 sccache、用 gitignored 占位文件满足 tauri-build 的 bundle 资源校验。这些都不入库,不影响正常构建。

**本机手测(curl,无需手机)**
1. 正常构建好 sidecar(你机器上的真实构建)。
2. `HELMOR_COMPANION=1 bun run dev`(或 release)。启动后 `{data_dir}/logs/rust.jsonl` 会出现 `companion enabled … listening on loopback`,其中带 `addr` 与 `token`。
3. `curl http://<addr>/v1/health` → `{"status":"ok",...}`。
4. `curl -H "Authorization: Bearer <token>" http://<addr>/rpc/list_workspace_groups` → 工作区分组 JSON(== 桌面侧边栏数据)。
5. 不带/错 token → 401。

### 13.2 Slice 0b — 把同一套 SPA 喂给浏览器(已实现并验证)

让浏览器能真正打开并浏览工作区,严格收敛到"最小可启动",不含 QR/配对码轮转/流式/写命令。

**改动**
- `src-tauri/src/companion/server.rs` — `fallback` 路由用 Tauri `AssetResolver` 托管内嵌 SPA(dev 自动回退读 `frontendDist`),并向 `index.html` 注入 `<script>window.__HELMOR_COMPANION__={}</script>` 标记。HTTP 层不直接持有 `AppHandle`,改持一个**类型擦除的 `AssetLoader` 闭包**(`start<R>` 泛型只在边界捕获 handle)——server 模块对 Tauri runtime 无感,集成测试可用 `tauri::test::mock_app()` 驱动。
- `src-tauri/src/companion/rpc.rs` — `/rpc` 扩到**冷启动首屏必需的读命令**:`get_app_settings`、`list_workspace_groups`、`list_archived_workspaces`、`list_repositories`、`list_agent_model_sections`、`list_provider_capabilities`、`detect_installed_editors`、`read/write/delete_query_cache`、`get_data_info`。直接调用真 `#[tauri::command]` 函数,返回 `Result<Value, CommandError>`(均无 `State`/`Channel`,无需 Tauri 上下文)。
- `src/lib/ipc.ts` — Channel 命令改为 **fire-and-forget**(匹配 Tauri 立即 resolve 语义;未接的 `/rpc-stream` 优雅降级为无事件);首次加载从 URL `#pair=<token>` 落地 token 到 localStorage 并抹掉 hash。
- `src/lib/settings.ts`、`src/lib/query-client.ts` — `invoke` 改走 `./ipc`(原本直连 Tauri,浏览器模式会卡死启动)。

**有意不做(最小化)**:QR、配对码轮转、`paired_devices`、agent 流式、写/变更命令、live UI 同步(`subscribe_ui_mutations` 降级为无操作)、mTLS、隧道。

**验证(本容器实测)**:前端 typecheck + **1338/1338** 测试 ✅(两处 import 调换零回归);Rust companion 单测 **5/5** + 集成测试 **1/1**(泛型 `start` + `mock_app`)✅;companion 模块 clippy 干净 ✅。

**本机手测**:`bun run build`(填充 dist/)后 `HELMOR_COMPANION=1 bun run dev` → 浏览器开 `http://<addr>/#pair=<token>`(token 见日志)→ 应加载真实前端并渲染工作区侧栏。

### 13.3 紧接着的下一刀

- **Slice 1 — 全量 RPC + live 同步 + 鉴权**:`/rpc` 覆盖更多命令(写/变更,按需带 `AppHandle`/`State`);`/rpc-stream` + `/v1/stream` 接 `ui_sync` 广播,让 `subscribe_ui_mutations`/`listen` 真正推送;`paired_devices` 表 + 周转配对码取代内存 dev token;`platform-bridge.ts` 收掉插件降级。
- **Slice 2 — 公网可达**:cloudflared 出向隧道 + `apps/registry`(CF Worker)写 `*.remote.helmor.ai` CNAME;Settings → Experimental 配对面板(QR)。
- **流式生产化**:`send_agent_message_stream` 接 `/rpc-stream` SSE,验证 Channel→SSE 核心假设(本容器跑不了 sidecar,需在你机器上验)。
