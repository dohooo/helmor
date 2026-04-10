# Phase 3 — Visual Stability Investigation

**Status**: User reported 4 issues post-Phase-2. Compiled here so analysis survives context compression.

## The four user-reported issues

### Issue 1: Scrollbar flickers up/down on every session switch
> Every time I switch sessions, the scrollbar on the right side flickers up and down — I really dislike this

The right-side scrollbar visibly moves/flickers on every session switch. User strongly dislikes this.

### Issue 2: Tauri first-load: low FPS + content area rapid jitter
> When I first open the Tauri client and load the page, the FPS is very low — I don't know why / During first-load rendering, the content area rapidly jitters and flashes up and down

When opening the Tauri client for the first time:
- FPS is very low during initial load (Tauri-only, not in dev:vite/Chromium)
- The content area rapidly jitters/flashes up and down during initial render

### Issue 3: Long-session switch shows scroll-from-top-to-bottom animation
> When I open a session, the list is still moving — it scrolls from top to bottom with a slow scrolling animation. I don't want this animation at all

When switching to a long session, the list visibly animates: it starts somewhere up top and slowly scrolls to the bottom. User wants:
- First frame is at the actual bottom of the visible content
- Every subsequent frame is the SAME (frozen) until user interacts
- "clean, snappy" (no residual animation)

### Issue 4: cambridge-v3 (and similar) — code blocks hydrate one-by-one + scroll cascades wrongly
> When I select a workspace from the archive on the left, the flickering becomes even more noticeable / It looks like code blocks are rendered one by one / The way it flickers is that it keeps jumping to the bottom / When first entering, none of the code blocks are rendered, and our position measurements are inaccurate

User attached 4 screenshots showing the cambridge-v3 archived workspace switch sequence:
- Frame 1: messages visible, code blocks NOT rendered yet (Streamdown lazy)
- Frame 2: code block #1 appears
- Frame 3: code block #2 appears
- Frame 4-N: more code blocks appear
- Final: scroll has "flickered to the bottom"

User explicitly notes: "the measurement positions are inaccurate" — initial layout is wrong because Streamdown content hasn't loaded yet.

## Common root cause hypothesis

**Content height instability after mount**, specifically from Streamdown's async code block / markdown hydration. Phase 2 Goal #1/#2/#3 work optimized layout/style cost but assumed row heights stabilize after `MeasuredConversationRow`'s first measurement. They DON'T — Streamdown is `lazy()`-imported (workspace-panel.tsx:112) and its inner content (Shiki code highlighting, KaTeX, table rendering) loads asynchronously **after** the row mounts. Each async load grows the row's height, which:

1. Triggers `pendingScrollAdjustment` if the row is above the viewport
2. Each adjustment writes `scrollTop` → visible scrollbar movement
3. The cumulative effect: list "animates" from estimator-based scroll to actual bottom over many frames
4. WKWebView (Tauri) is slower than Chromium, so the cascade is more visible there

This single root cause explains all 4 issues:
- **Issue 1 (scrollbar flicker)**: thumb position shifts as `scrollHeight` grows from Streamdown loads
- **Issue 2 (Tauri jitter + low FPS)**: WKWebView is slower, so the cascade compresses into a denser visible window of jitter; first-mount also has cold caches (font, code highlighters)
- **Issue 3 (top-to-bottom animation)**: this is the cascade of `pendingScrollAdjustment` writes, perceived as smooth scrolling
- **Issue 4 (cambridge-v3 cascade)**: cambridge-v3 sessions have many code blocks. Each Streamdown lazy hydration causes another scroll write. The user sees "code block appears → scroll moves → code block appears → scroll moves" repeating

## Why Phase 2 changes made this WORSE (probably)

Pre-Phase-2:
- `<ScrollArea key={sessionId}>` was remounted on every session switch (commit before iter 8 / `09df3fd`)
- Each remount ran `useStickToBottom({ initial: "instant" })` afresh
- The remount reset everything, possibly hiding the cascade
- The scrollbar fade-in animation in `App.css:59` was keyed off the remount and fired per session switch

Post-Phase-2:
- `<ScrollArea>` stays mounted across session switches (iter 8 removed `key=`)
- `useStickToBottom`'s initial scroll only fires ONCE per app load
- The scrollbar fade-in animation only fires ONCE per app load (wrong now — comment in CSS is stale)
- `pendingScrollAdjustment` is now the primary scroll-keeper-at-bottom mechanism, but it fires synchronously per height correction → visible movement

Phase 2 made the panel **faster** but exposed the **continuous-content-loading flicker** that the remount was masking.

## Specific suspects (with file paths + line numbers)

### 1. Scrollbar fade-in animation no longer per-session
**File**: `src/App.css:59-71`
```css
.conversation-scroll-area [data-slot="scroll-area-scrollbar"] {
  animation: conversation-scrollbar-fade-in 300ms ease-out 400ms both;
}
```
Comment says "re-fires on every session switch because <ScrollArea> itself is keyed by sessionId" — **comment is stale**. After iter 8 (commit `09df3fd`), the `<ScrollArea>` is no longer keyed. Animation now fires only once per page load.

**Fix candidate**: re-trigger this animation on session switch via a key on the inner viewport, or via a dynamic class toggle, or via direct `getAnimations()` API. Or replace with JS-driven opacity toggle.

### 2. ChatThread snap-to-bottom uses scrollHeight read
**File**: `src/components/workspace-panel.tsx:759-775`
```ts
useLayoutEffect(() => {
  // ...
  scrollParent.scrollTop = scrollParent.scrollHeight;
}, [sessionId]);
```
This snaps to bottom ONCE on session change, using the `scrollHeight` at that moment. Streamdown content not yet loaded → wrong scrollHeight → wrong snap target.

**Fix candidate**: re-snap repeatedly until `scrollHeight` is stable for >N ms. Or use `useStickToBottom`'s `scrollToBottom("instant")` and rely on the library to maintain bottom-pin. Or pre-compute a target from `totalContentHeight` (React state) which uses estimator predictions.

### 3. pendingScrollAdjustment fires per height correction
**File**: `src/components/workspace-panel.tsx` (around line 1234-1260, the `useLayoutEffect` for `pendingScrollAdjustmentRef`)

Each Streamdown async load → `MeasuredConversationRow` resize observation → `handleHeightChange` → if row is above viewport, `pendingScrollAdjustmentRef.current += delta` → next render's layoutEffect writes `scrollParent.scrollTop += delta`.

This is the cascade that causes visible "scroll-to-bottom animation".

**Fix candidate**: batch multiple height corrections into a single scroll adjustment, debounced over a short window (e.g., 100ms). Or use a different approach entirely: hide the scrollbar + content opacity until heights settle, then reveal.

### 4. content-visibility: auto + lazy Streamdown
**File**: `src/components/workspace-panel.tsx:1409-1440` (`measuredRowIsolationStyle` + `MeasuredConversationRow`)

`content-visibility: auto` means rows entering the viewport via scroll are layout/style/painted lazily. If Streamdown ALSO lazy-hydrates inside a row, that's two layers of async content, possibly compounding the flicker.

**Fix candidate**: only use `content-visibility: auto` for rows known to be measured + stable. Or skip it for rows containing code blocks (which have variable height).

### 5. Tauri-specific: WKWebView differences
- WKWebView has imperfect support for `content-visibility: auto`
- WKWebView's `requestAnimationFrame` scheduling is more conservative than Chromium
- Streamdown's lazy chunk import has cold-cache cost on first app load

**Fix candidate**: pre-warm Streamdown on app boot (before any session is shown). Already partially done via `preloadStreamdown` in workspace-panel.tsx:141 — verify it actually fires before the first session render.

### 6. The `useEffect [sessionId]` snap-to-bottom and `useStickToBottom` may both fire
Both ChatThread's `useLayoutEffect [sessionId]` AND `useStickToBottom`'s internal logic may try to manage scroll position. If they disagree (e.g., useStickToBottom sees `isAtBottom = false` because of estimator/measurement gap), one might fight the other.

## Hard contracts (from user)

1. **Session switch → first frame is at the actual bottom, no animation visible**
2. **While user doesn't interact, every frame is identical** (frozen state)
3. **No scrollbar flicker** between session switches
4. **No content area jitter/flash** during first load (Tauri or dev)
5. **Tauri release mode must work** (not just dev:vite)
6. **No remount** (preserved from Phase 2 work)
7. **No regression on Phase 2 wins** (long-frame sumMs, jitter, distFromBottom, vitest perf metrics)

## Phase 3 autoresearch loop setup

### Goal
```
Goal:   Eliminate visible content/scroll jitter on session switch and on
        Tauri first-load. Specifically: kill the scrollbar flicker, the
        scroll-from-top-to-bottom animation, and the cambridge-v3-style
        code-block hydration cascade. Achieve "first frame = bottom,
        every subsequent frame identical until user interacts".

Scope:  src/components/workspace-panel.tsx
        src/components/workspace-panel-container.tsx
        src/App.css (scrollbar animation, possibly visibility helpers)
        Possibly: pre-warm Streamdown earlier in the app boot lifecycle

Metric:  Three independent metrics (jitter detector for each issue):

  M1 — scroll position stability after session switch:
       Click into a session, sample scrollTop every rAF for 3 seconds.
       Count distinct scrollTop values seen. Target: ≤ 2 (initial + final).
       Baseline: TBD (probably 5-15 distinct values for cambridge-v3).

  M2 — scrollHeight stability after session switch:
       Same scenario, sample scrollHeight per rAF. Count distinct values.
       Target: ≤ 2 (wait until Streamdown settles, then accept). 
       Baseline: TBD (probably 10+ for sessions with code blocks).

  M3 — long-frame sumMs on cambridge-v3 specifically:
       New scenario: navigate hamburg → cambridge-v3 (a long session
       with many code blocks). Measure for 4s post-click.
       Baseline: TBD. Target: ≤ Phase 2 baseline 457 ms.

Verify: chrome-devtools MCP scenario captures all 3 metrics in one run.
        Visual contracts: distFromBottom = 1 px, scrollTop never moves
        upward without user input, total scrollHeight stable for ≥ 1s
        before declaring "done".

Guard: pnpm tsc --noEmit && pnpm vitest run && pnpm run build
```

### Verification scenario script (chrome-devtools MCP)

```js
async () => {
  // Setup
  await waitForReady();
  expandArchivedSection();

  // Test 1: scrollbar flicker on session switch
  // Click into a small session, sample scrollTop + scrollHeight per frame
  await clickWorkspace(SMALL_WORKSPACE);
  const small = await sampleStability({ ms: 3000, framesPerSample: 1 });

  // Test 2: cambridge-v3 cascade
  await clickWorkspace(CAMBRIDGE_V3);
  const cv3 = await sampleStability({ ms: 4000, framesPerSample: 1 });

  // Test 3: long-session top-to-bottom animation
  await clickWorkspace(REVIEW_AND_REPORT_298_MSG);
  const long = await sampleStability({ ms: 4000, framesPerSample: 1 });

  return { small, cv3, long };
}

function sampleStability({ ms, framesPerSample }) {
  // Returns { scrollTopValues: Set, scrollHeightValues: Set,
  //           longFrameCount, longFrameSumMs, finalDistFromBottom }
}
```

### Known relevant code paths to inspect first

1. `src/App.css:42-71` — scrollbar fade-in CSS (stale comment about ScrollArea key)
2. `src/components/workspace-panel.tsx:112-130` — `LazyStreamdown` lazy import wrapper
3. `src/components/workspace-panel.tsx:141-146` — `preloadStreamdown` (idle callback)
4. `src/components/workspace-panel.tsx:735-775` — ChatThread useStickToBottom + snap-to-bottom layoutEffect
5. `src/components/workspace-panel.tsx:1217-1232` — ProgressiveConversationViewport initial-scroll layoutEffect (clientHeight cache from Goal #3b)
6. `src/components/workspace-panel.tsx:1234-1260` — pendingScrollAdjustment layoutEffect (gated by hasUserScrolledRef from Goal #1.5)
7. `src/components/workspace-panel.tsx:1262-1284` — handleHeightChange (where pendingScrollAdjustment accumulates)
8. `src/components/workspace-panel.tsx:1409-1440` — measuredRowIsolationStyle + MeasuredConversationRow style application
9. `src/components/workspace-panel-container.tsx:265-360` — A1' state machine + mergedMessages slicing

## Investigation hypotheses to test (in priority order)

1. **H1**: The scrollbar fade-in CSS comment is stale; the animation only fires once per app load, not per session switch. Fix: re-trigger on session change.
   - **Test**: open dev tools, watch the scrollbar element's `animationStartTime` between session switches. Should change. If not, H1 confirmed.

2. **H2**: Streamdown's lazy chunk imports cause progressive scrollHeight growth over 500-2000 ms post-switch. The pendingScrollAdjustment cascade is the user-visible "animation".
   - **Test**: log scrollHeight per rAF from session click for 3 seconds. Plot. Expect stairsteps.

3. **H3**: useStickToBottom and our manual snap-to-bottom are double-firing/conflicting.
   - **Test**: temporarily comment out one or the other, verify behaviour.

4. **H4**: `content-visibility: auto` causes rows to "appear" abruptly when entering the viewport mid-cascade, contributing to the perceived flicker.
   - **Test**: temporarily disable content-visibility, see if cambridge-v3 still cascades.

5. **H5**: Tauri WKWebView's first-frame slowness comes from cold lazy chunk imports + initial mount of Lexical/Streamdown deps. Pre-warming earlier helps.
   - **Test**: cold-start Tauri (`pnpm tauri build` then run), measure first-mount FPS. Add aggressive preload, re-measure.

## Possible solutions to try (iter ideas)

### iter 1 candidates (cheapest, highest signal)
- **A**: Re-fire scrollbar fade-in on session switch (CSS animation key bump)
- **B**: Hide content (opacity 0 on inner viewport) until scrollHeight has been stable for 200ms, then snap-to-bottom + fade in
- **C**: Disable `pendingScrollAdjustment` entirely while `hasUserScrolledRef === false`, instead use a single re-snap-to-bottom debounced over 200ms

### iter 2+ candidates (architectural)
- **D**: Pre-render Streamdown content off-screen, fade in when ready
- **E**: Replace pretext.layout estimator with actual measurement of fully-rendered Streamdown content (cached server-side or in IndexedDB)
- **F**: Render in two phases: skeleton (no Streamdown) → snap to bottom → swap to real content

### Tauri-specific
- **G**: Force-import streamdown + shiki on app boot before any session is shown
- **H**: WKWebView feature detection — disable `content-visibility: auto` if not well-supported

## Current branch state at time of doc

```
5a3cc5e perf(panel): goal #3 — A1' skip threshold + content-visibility + clientHeight cache
3c1b2f7 perf(panel): A1' progressive deferred hydration in startTransition
5a670a9 docs(perf): phase 1 bottleneck report + a4 research + samply baseline
594f493 feat(perf): phase 1 measurement infra + phase 2 panel perf wins
```

Branch: `caspian/better-perf` (pushed to remote, has open PR template URL)

## Files to read first in the next session

1. This file: `docs/perf/phase3-flicker-analysis.md`
2. `docs/perf/phase1-bottleneck-report.md` — overall context + perf history
3. `src/components/workspace-panel.tsx` — main file, most changes are here
4. `src/components/workspace-panel-container.tsx` — A1' + mergedMessages
5. `src/App.css:42-90` — scrollbar / animation styles
6. `autoresearch-results.tsv` (gitignored, local) — every iteration's verdict

## Verify-first protocol (before writing any code)

1. **Reproduce all 4 issues in chrome-devtools MCP**, recording per-rAF scrollTop/scrollHeight + the long-frame sum + CLS.
2. **Establish baselines** for M1/M2/M3 with current code.
3. **Identify the dominant signal** — which of H1-H5 produces the most user-visible cost.
4. **Pick a fix candidate**, apply, measure all 3 metrics + visual contract checks.
5. **Strict keep/discard** based on metric movement AND visual contract.
6. **Iterate** until all 4 user issues are subjectively gone (verify by manual screenshot diff if needed).
