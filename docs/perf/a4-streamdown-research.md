# A4: Streamdown vs Direct DOM Research

## Recommendation
**Keep Streamdown.** Do not switch the streaming tail to a direct DOM `textContent` path.

## Confidence
**Medium-High.** The library guidance and architectural reasoning are unanimous and align with how Helmor already uses Streamdown (block-memoized, lazy-loaded, behind a single `memo`'d `AssistantText` component, flushed via rAF coalescing). What is **thin** is a Helmor-specific micro-benchmark proving the gap is small in our actual WKWebView. If A1/A3 micro-benches show the streaming tail is a real hot spot, escalate to a Phase 2 controlled bench.

## Evidence

### Tauri v2 official guidance
Tauri v2's perf docs talk about IPC throughput (Channel API, custom-protocol IPC replacing the v1 stringified bridge) and bundle/startup, **not** about bypassing the framework renderer in the webview. There is no Tauri guidance recommending direct DOM mutation for streaming text; the canonical streaming pattern is "Rust `Channel<T>` -> frontend handler -> framework state". Helmor already follows this in `workspace-conversation-container.tsx` (rAF-coalesced `setLiveMessagesByContext`).
- https://v2.tauri.app/reference/webview-versions/
- https://github.com/tauri-apps/tauri-docs/blob/v2/src/content/docs/develop/calling-frontend.mdx (Channel pattern)
- https://v2.tauri.app/concept/architecture/

### Streamdown library guidance
Streamdown is **explicitly designed** to make per-token React re-renders cheap. Block-level memoization + `React.memo` on the root + Shiki token cache + module-level plugin arrays mean only the tail block re-parses on each chunk; completed blocks are stable. v2.x added an LRU cache and removed regexes for the same reason. This is the recommended pattern in the official memoization doc; the ai-sdk cookbook recipe is identical.
- https://streamdown.ai/docs/memoization
- https://vercel.com/changelog/streamdown-1-6-is-now-available-to-run-faster-and-ship-less-code
- https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization

### assistant-ui guidance
assistant-ui ships its own `@assistant-ui/react-streamdown` wrapper and the `StreamdownTextPrimitive`. Their custom external-store streaming example does exactly what Helmor does: rebuild the assistant `text` part on each chunk via `setMessages` and let the memoized Streamdown subtree absorb the diff. They do **not** recommend imperative DOM writes anywhere.
- https://github.com/assistant-ui/assistant-ui/blob/main/packages/react-streamdown/README.md
- https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/content/docs/runtimes/custom/external-store.mdx

### Community benchmarks
No quantitative head-to-head numbers exist. The closest data points: SitePoint's streaming-React article notes "5-15ms commits in a simple app, 50ms+ in real trees" for unbuffered token streams, and reports that **DOM size** (not React reconciliation) dominates once you have thousands of nodes. Both points argue for memoization + virtualization, **not** for bypassing React.
- https://www.sitepoint.com/streaming-backends-react-controlling-re-render-chaos/

### How Helmor currently uses Streamdown
- One call site: `LazyStreamdown` inside `AssistantText` (`src/components/workspace-panel.tsx:1569-1599`).
- `AssistantText` is wrapped in `React.memo`; `STREAMING_ANIMATED` is module-level (no per-render object); table overrides are imported once in `streamdown-components.tsx`.
- Loaded via `lazy()` + `Suspense`, with idle preload (`preloadStreamdown`).
- Streaming pipeline (`workspace-conversation-container.tsx:303-345`) buffers `streamingPartial` events into `pendingPartial` and flushes through `requestAnimationFrame` -> at most one React commit per frame, regardless of chunk rate.

## Cost/benefit analysis

### If we switch to direct DOM
**Pros**
- Theoretically zero React reconciliation on the tail node.
- Could shave a small constant per chunk in WKWebView.

**Cons**
- Lose markdown parsing (headers, code fences, links, tables, images, KaTeX) — would need to re-implement Streamdown's incremental "remend" handling for partial syntax.
- Lose Shiki syntax highlighting on the streaming block.
- Breaks accessibility (assistant-ui ARIA), `prose` styling, `data-streamdown="table-wrapper"` selectors, and the `blurIn` animation.
- Refs into a `memo`'d React subtree are fragile: any parent re-mount or session switch wipes the imperative state.
- Re-finalize handoff (streaming -> static commit) would need a custom diff to avoid flicker.
- Goes against every cited authority (Tauri, Streamdown, assistant-ui, ai-sdk).

**Estimated effort:** L (3-6 days incl. regression coverage).
**Risk:** High (markdown correctness, a11y, animation, finalize handoff).

### If we keep Streamdown
**Pros:** Markdown/code/tables/KaTeX intact; matches all four upstream recommendations; rAF coalescing already caps the React commit rate at one per frame; existing perf tests assume this shape.
**Cons:** Whatever residual cost Streamdown still has on each frame in WKWebView — unmeasured.

## Final answer
**Keep Streamdown.** Every authority points the same way: the right lever for streaming markdown perf is *block-level memoization + commit coalescing*, both of which Helmor already has. Direct-DOM `textContent` is only worth doing for plain-text high-frequency updates (price tickers, log tails) where you can throw away markdown semantics; that is not the chat tail. Given the team's prior 21 iterations and the calibration note that the real hot spots are in sidebar Radix/Lucide and the dev/release gap, A4 should not justify this rewrite. **If A1/A3 benches show the streaming tail is still meaningful, do a Phase 2 micro-bench (replace `LazyStreamdown` with `<pre>{text}</pre>` behind a feature flag, measure FPS in Tauri release, decide from numbers).** Until then, this is hand-waving territory and Streamdown stays.
