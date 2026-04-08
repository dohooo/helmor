# Helmor Phase 1 — 瓶颈分布定量报告

**生成时间**: 2026-04-08
**前置背景**: 21 轮 `HELMOR_PERF_CLICK_MS` autoresearch 没能压缩任何 metric。Phase 1 的目标是**先测量、再优化**——把测量层和诊断工具建好，然后用真实数据找出真正的瓶颈所在，避免再次盲目地在错误的层做 surgical fix。

## TL;DR — 三个被证实的事实

1. **以前 21 轮挑的所有"优化目标"都不是瓶颈**。
   `shareMessages`、`mergedMessages`、`viewport:rows`、`viewport:visible-rows`、`container:share-messages` —— Phase 1 的 perf 标记 (`?perfMarks=1`) 在真实 workspace 切换场景下显示**全部都是亚毫秒级别**。21 轮迭代抓不到信号是因为这些代码本来就不是热点。

2. **真正的 250–300ms 长帧由两件事造成**:
   - **`MeasuredConversationRow.reportHeight` 强制 reflow** — 5 次 workspace 切换里累计 **286 ms** 的 forced layout flush。每个可见 row 的 `useLayoutEffect` 都同步读取 `node.offsetHeight`，每读一次就触发一次完整的 layout 计算 → O(n) 串联 reflow。
   - **样式重算 (Style Recalc) 影响 700–930 个元素** — 单次切换里有 124 ms 的样式重算波及 930 个元素 (整个 1423 节点 DOM 的 65%)。强烈怀疑是 panel 根附近某个 className 在切换时改变，导致 CSS 级联失效广播给整棵子树。

3. **JS 层唯一可见的成本是 estimator** —— `estimator:thread-heights` 平均 6.4 ms，最大 20 ms。值得做 (Phase 2 A2 web worker)，但**单它一个治不好长帧**——300 ms 的长帧只有约 150 ms 是 JS，其余是 layout + style。

> 一句话: **Phase 2 的优化应该把矛头从 JS 数据结构转向 layout / style / DOM containment**。

---

## 测量基础设施 (Phase 1 deliverables)

| 工具 | 文件 | 触发方式 | 状态 |
|---|---|---|---|
| **E3 perf marks** | `src/lib/perf-marks.ts` | `?perfMarks=1` | ✅ |
| **M1 长帧 / FPS HUD** | `src/lib/dev-long-frames.ts` | `?perfHud=1` | ✅ |
| **M3 React Profiler** | `src/lib/dev-react-profiler.tsx` | `?profile=1` | ✅ |
| **dev-render-debug** (已有) | `src/lib/dev-render-debug.ts` | `?debugRenderCounts=1` | ✅ (复用) |
| **S2 streaming fixture** | `src/test/perf/streaming-replay.perf.test.tsx` + `fixtures/streaming-tool-use.jsonl` (777 行真实 Claude SDK 流数据) | vitest run | ✅ |
| **M2 Chrome trace 流程** | `docs/perf/phase1-trace-workspace-switch.json` + `phase1-trace-summary.json` | chrome-devtools MCP | ✅ |
| **E1 cargo flamegraph** | (instructions only — needs sudo) | `docs/perf/e1-flamegraph-instructions.md` | 📋 instructions ready |
| **E2 samply** | `docs/perf/samply-dev-server-symbols.json.gz` (665 samples × ~3s active CPU window @ 4 kHz) | `samply load docs/perf/samply-dev-server-symbols.json.gz` 即可 in-browser 看 | ✅ |
| **A4 streamdown 调研** | `docs/perf/a4-streamdown-research.md` | — | ✅ 结论: **保留 Streamdown** |

四个 query flag 现在都可以独立打开，互不干扰:

```
http://localhost:1420/?perfMarks=1&perfHud=1&profile=1&debugRenderCounts=1
```

打开后 `window` 上会出现:

- `__HELMOR_PERF_MARKS__` — `.aggregate()` 返回所有 helmor:* measure 的 count + total + avg + max
- `__HELMOR_LONG_FRAMES__` — `.get()` 返回所有 long-frame 条目 (rAF + LoAF), `.dumpJson()`/`.downloadJson()` 导出
- `__HELMOR_PROFILER__` — `.summary()` 返回 React Profiler 的 actual/base 累计
- `__HELMOR_DEV_RENDER_STATS__` — 渲染计数器 (现有)

---

## M2 实测数据 (5 次 workspace 切换 / dev:vite + dev:api)

**场景**: 通过 chrome-devtools MCP 在 hamburg-v2 + simplify-success-page + fix-auth-redirect-url + greeting 之间共 5 次切换 (含 archived workspace 第 2、第 3 项的冷热路径) 。

### 长帧分布 (LoAF + rAF)

```
count: 31 frames > 50ms
max:   303.6 ms
p95:   297.6 ms
p50:    97.3 ms
sum:  4545 ms across ~5 seconds wall clock
```

**Top 3 长帧**:

| 来源 | duration | blocking | scriptDuration | forcedStyleAndLayoutDuration | invoker |
|---|---|---|---|---|---|
| LoAF | **303.6 ms** | 245.4 | 293 | **120** | `MessagePort.onmessage` (React 19 scheduler) |
| LoAF | **284.9 ms** | 232.1 | 280 | **126** | `MessagePort.onmessage` |
| LoAF | **256.6 ms** | 202.3 | 250 | **127** | `MessagePort.onmessage` |

**结论**: 每个长帧大致 50/50 split — 一半 JS (React 调和 + 组件 render)、一半 forced style + layout (browser 在 layout 已经被 invalidated 后被迫做同步 layout)。

### perfMarks 聚合 (helmor:* 的 5 次切换全部累计)

| measure | count | totalMs | avgMs | maxMs |
|---|---:|---:|---:|---:|
| **estimator:thread-heights** | 6 | **38.3** | **6.38** | **20.0** |
| container:merged-messages | 12 | 0.4 | 0.03 | 0.1 |
| container:share-messages | 12 | 0.2 | 0.02 | 0.1 |
| viewport:visible-rows | 31 | 0.1 | 0.003 | 0.1 |
| viewport:rows | 17 | 0.0 | 0.0 | 0.0 |

**结论**: estimator 是 JS 层唯一可见的成本 (≤20 ms / 次)。**其它 4 项全部加起来不到 1 ms**——21 轮 autoresearch 都在攻击它们，注定测不到信号。

### React Profiler

| 组件 | updates | totalActualMs | totalBaseMs | maxActualMs | maxBaseMs |
|---|---:|---:|---:|---:|---:|
| **WorkspacePanel** | 61 | 725.7 | 3715.3 | **131.7** | 125.7 |
| **ChatThread** | 60 | 613.8 | 3108.6 | **122.9** | 117.4 |

最大单次 commit 的 actual time **131.7 ms** 与最大长帧 (303 ms) 的 JS 半段对得上 (~150 ms JS)。

### dev-render-debug 计数器

```
totalMessageRenders:  124   (5 switches × ~25 messages × ~1 commit each)
totalComposerRenders:  10
totalSidebarRenders:   10   (4 unique workspace rows × ~2.5 commits)
```

**Sidebar 在 workspace 切换场景下不是热点** —— 4 个 row 总共只有 10 次 render，完全是 selectedWorkspaceId memo bail-out 在工作。这印证了 `project_perf_metric_blindspots.md` 里的「盲区 1」: 之前的 metric 看不到 sidebar，是因为 scenario 设计本身就让 sidebar 不参与。

### Chrome DevTools Forced Reflow Insight

```
totalReflowMs: 387 (across 5 switches)

Top 4 stacks:
  1. workspace-panel.tsx:1114  reportHeight                       — 286 ms 🔥
  2. workspace-panel.tsx:714   ChatThread useLayoutEffect (snap)  — 101 ms 🔥
  3. lexical.js:5753           updateDOMSelection                 —   1 ms
  4. auto-resize-plugin.tsx    (composer)                         —   1 ms
```

**两个 smoking gun 都在我们自己的代码里**:

1. `MeasuredConversationRow.reportHeight()` (line 1224 in current source, the insight reports line 1114 from a hot-reload variant):
   ```tsx
   useLayoutEffect(() => {
     // ...
     const reportHeight = () => {
       onHeightChange(rowKey, node.offsetHeight); // ← reads offsetHeight per row
     };
     reportHeight();
     // ResizeObserver also calls reportHeight per resize
   }, [...]);
   ```
   每个可见 row 在 useLayoutEffect 里同步读 `offsetHeight`，每读一次就强制 layout flush。N 个 row → N 次 layout 串联，286 ms 是这条路径累计。

2. `ChatThread` 的 snap-to-bottom (line 770):
   ```tsx
   useLayoutEffect(() => {
     scrollParent.scrollTop = scrollParent.scrollHeight; // ← reads scrollHeight imperatively
   }, [sessionId]);
   ```
   写 scrollTop 之前先读 scrollHeight，又是一次同步 layout。

### Chrome DevTools DOM Size Insight

```
Total elements:  1423
DOM depth:         22
Max children:      24  (div.space-y-0.5)

Large style recalcs (each one is a single recalc event):
  - 124 ms affecting 930 elements
  - 114 ms affecting 782 elements
  -  47 ms affecting 476 elements
  -  47 ms affecting 473 elements
```

**一次 124 ms 的样式重算一口气波及 930 个元素 (DOM 总量的 65%)**。这是 className 改动在级联里炸开的典型现象——可能是 `selectedSessionId` / `selectedWorkspaceId` 触发的 `data-state` 变更没有被任何 CSS containment 截断。

### 浏览器层 vs JS 层成本拆分 (单次 worst-case workspace 切换 ≈ 300 ms)

```
~150 ms  React 调和 + 组件 render          ← JS 层
   20 ms  estimator (pretext.layout)        ← JS 层 (helmor 自有代码)
~125 ms  forced layout from reportHeight   ← Layout 层 (helmor 自有代码)
~120 ms  style recalc (930 elements)       ← Style 层 (CSS 级联问题)
```

注意 layout + style 加起来 (~245 ms) 比 JS (~170 ms) 更多。**这是 21 轮一直没看到的层。**

### E2 samply — Rust 后端确认不是瓶颈

10 秒采样窗口 (4 kHz, 665 个有效采样横跨 17 个线程, 约 3 秒 active CPU):

```
56.4%  libsystem_kernel.dylib   ← 全是 idle wait 系统调用
  - 26.9% __psynch_cvwait       (pthread cond_wait, tokio worker idle)
  - 16.8% kevent                (axum / tokio epoll loop, idle)
  -  4.5% __posix_spawn         (一次性 sidecar 启动开销, 不是 workspace switch 成本)
  -  3.3% pread                 (SQLite 读盘)
  -  2.7% poll
39.4%  helmor-dev-server         ← 实际 Rust 工作 (heavily 不解析的 hex 地址,
                                    binary 缺 dSYM, 但单看分布占比已经够说明问题)
 4.2%  其它系统库                (memmove, memcmp, malloc, pthread)
```

dev_server 用了 **<1 个 core 的算力**, 56% 都在 syscall 里 sleep。**Rust 后端在 workspace 切换路径上的 CPU 成本可以忽略**。30 个 `__posix_spawn` 是一次性的 sidecar 子进程启动 (非 workspace switch), 在切换 scenario 里它甚至不参与。

→ E2 直接证伪了"50-80ms dev:api 是瓶颈"的旧估计 (来自 `project_perf_metric_blindspots.md`)。 实际 dev:api **请求**在切换中的确占用 ~50ms 的 wall-clock, 但这 50ms 大部分是网络栈 + JS Promise 调度 + JSON parse, **不是 Rust 在干活**。

→ **Phase 2 不需要碰 Rust 后端的 perf**。除非未来引入 streaming 大规模并发场景, dev_server 的 perf 都不在关键路径上。

---

## A4 调研结论 (并入 Phase 1)

研究文件: `docs/perf/a4-streamdown-research.md` (727 字)

**结论**: 保留 Streamdown，**不要**切到直接 DOM 更新。

四个权威来源 (Tauri v2 docs、Streamdown 官方 memoization 指南、assistant-ui `react-streamdown` + external-store 范例、Vercel ai-sdk cookbook) 一致指向 block-level memoization + commit 合并的模式，Helmor 已经做到了 (`AssistantText` 是 `memo`、`STREAMING_ANIMATED` 是模块级常量、`workspace-conversation-container.tsx` 用 `requestAnimationFrame` 把多个 streamingPartial 合并成每帧最多一次 commit)。直接 DOM 路径会丢掉 markdown 解析、Shiki 高亮、KaTeX、表格、a11y、streaming→static 切换等大量功能，重写代价 L (3-6 天)，正确性风险高。

→ Phase 2 候选项把 **A4 删除**。

---

## S2 流式 baseline (Phase 2 streaming 类优化的对照)

vitest 跑 `streaming-replay.perf.test.tsx` (回放 777 行真实 JSONL → 701 个 streamingPartial snapshot):

```
HELMOR_PERF_STREAMING_TOTAL=722         (lower is better)
HELMOR_PERF_STREAMING_SNAPSHOTS=701
HELMOR_PERF_STREAMING_FIXTURE_ROWS=777
```

**722 / 701 ≈ 1.03 renders per tick** —— 结构性共享 (`shareMessages` + `MemoConversationMessage` 比对) 在流式路径上几乎完美工作，每个 tick 只重渲染流式尾部的那一条消息，其它 20 条历史消息全部 bail out。

→ **流式 tail 已经接近 floor**。Phase 2 不应该把"流式渲染"作为攻击目标 (A3 fine-grained signals / A4 直接 DOM 都不会有大幅收益)。

---

## Phase 2 优先级 (基于真实数据，不再是猜测)

### High value (推荐 Phase 2 第一批)

| ID | 内容 | 预期收益 | 备注 |
|---|---|---|---|
| **L1** *新* | **MeasuredConversationRow 高度上报批处理化** —— 用单一 `ResizeObserver` 监听整个 rows 容器，一次拿到所有 entry 的 contentRect，写入 `requestAnimationFrame` 队列；干掉每行 `useLayoutEffect` 同步读 `offsetHeight` | 切除 ~286 ms forced reflow / 5 switches | M2 trace 直接证据 |
| **L2** *新* | **ChatThread snap-to-bottom 异步化** —— 把 `scrollTop = scrollHeight` 推到 `requestAnimationFrame` 或微任务里执行；或者用 CSS `overflow-anchor: auto` + 一个 sentinel | 切除 ~101 ms forced reflow | M2 trace 直接证据 |
| **L3** *新* | **CSS containment + content-visibility** —— 给 panel 根 `contain: layout style`、给 `MeasuredConversationRow` 加 `content-visibility: auto` + `contain-intrinsic-size: 0 <估算高度>` | 让 off-screen row 完全跳过 layout/style，治本 | DOM Size Insight 证据: 930 元素 124 ms 一次 |
| **L4** *新* | **style 级联范围审计** —— 找到切换 workspace/session 时哪个 className 改了导致 930 元素重算；可能是 panel 根的某个 `data-state` 或 `theme` class | 减半 style recalc 时间 | DOM Size Insight 证据 |
| **A1'** | **Progressive hydration** —— 首屏只 commit 最近 N 条消息，1-2 秒后微任务里静默渲染剩余。**绝对禁止按钮触发**。需要保证滚动锚定底部不抖动 | 单次切换 React 调和 ~150 ms 减半 | 用户偏好 |

### Medium value

| ID | 内容 | 预期收益 |
|---|---|---|
| **A2** | Estimator 移到 Web Worker (`@chenglou/pretext.layout`) | 切除 6-20 ms 单次主线程时间 |
| **A3** | Fine-grained signals 用于流式尾部 | 已经接近 floor，收益小但代价低 |
| **W3** | WebGPU layout spike — 30 分钟可行性测试，行不行信号都明显 | 不确定 |

### Low value / 可跳过

| ID | 原因 |
|---|---|
| ~~A4~~ | 调研已结论: 保留 Streamdown |
| ~~S1 sidebar 虚拟化~~ | 在 workspace 切换 scenario 下 sidebar 只 render 10 次, memo bail-out 工作正常。除非 workspace 数 > 100 否则不是热点 |
| 任何针对 `shareMessages`/`mergedMessages`/`visible-rows`/`rows` 的优化 | perfMarks 显示全部 ≤ 0.1 ms |

### 仍需做但优先级降低 (基于 E2 实测后)

| ID | 内容 | 备注 |
|---|---|---|
| **E1** | Rust flamegraph | E2 samply 已经独立确认 dev_server 占 <1 个 core 且 56% 在 syscall sleep, flamegraph 只会重复同一结论, 还需要 sudo |
| **W5** | Pre-warm dev:api 缓存 | E2 显示 dev_server 不是瓶颈; 50ms fetch 里大部分是网络栈 + JSON parse 而不是 Rust |

---

## Phase 2 输入参数 (供下一轮 autoresearch 用)

### Goal #1 (推荐先做这个)

```
Goal:   消除 workspace 切换路径上的 forced reflow + style recalc.
        必须保留: 底部锚定、无空白帧、tail 跟踪. 不允许引入新缓存.
Scope:  src/components/workspace-panel.tsx (MeasuredConversationRow + ChatThread useLayoutEffect)
        src/components/workspace-panel.css (新加 containment 规则)
Metric: 在 dev:vite 下用 chrome-devtools MCP 跑 5 次 workspace 切换,
        从 window.__HELMOR_LONG_FRAMES__.get() 拿出 long-frame sumMs 之和,
        比较优化前后. baseline = 4545 ms.
Verify: 在 chrome-devtools MCP 跑 5 次切换后 evaluate window.__HELMOR_LONG_FRAMES__.get() 求 sumMs
Guard:  pnpm vitest run && pnpm tsc --noEmit
```

### Goal #2 (可与 Goal #1 并行)

```
Goal:   渐进式延迟 hydration —— 首屏只渲染最近 N 条消息, RAF + 微任务后台渲染剩余,
        滚动到顶时自动加载更多. 不可见的 hydration. 不可触发任何视觉抖动.
Scope:  src/components/workspace-panel-container.tsx (mergedMessages 切片)
        src/components/workspace-panel.tsx (ProgressiveConversationViewport
        加入 hydration phase 状态)
Metric: HELMOR_PERF_TOTAL (现有的 vitest perf test, baseline=287)
        + window.__HELMOR_PROFILER__.summary() 的 WorkspacePanel.maxActualMs
        (M2 baseline = 131.7 ms)
Verify: pnpm vitest run src/test/perf/conversation-render.perf.test.tsx
Guard:  pnpm vitest run && pnpm tsc --noEmit
```

---

## 结论

Phase 1 的最大收获不是任何一项基础设施本身，而是**它们一起把"问题在哪一层"这个一直猜不准的问题钉死了**:

- 不是 JS 数据结构 (21 轮的目标)
- 不是 sidebar Radix
- 不是 Streamdown
- **是 Helmor 自己的 useLayoutEffect 在每个 row 上同步读 offsetHeight + Helmor 自己的 scrollHeight 同步读 + 一个 className 在切换时让 930 个元素重算样式**

Phase 2 第一批应该攻击 L1/L2/L3/L4，而**不是**继续在 estimator 里钻牛角尖。
