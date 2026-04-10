# SDK Message Coverage Audit Report

> Investigation date: 2026-04-08
> Scope: `@anthropic-ai/claude-agent-sdk` v0.2.92 + `@openai/codex-sdk` v0.118.0
> Focus: sidecar → Rust pipeline → frontend components end-to-end coverage

---

## TL;DR

**Overall conclusion**: Helmor's pipeline has strong constraints on **known** event types (drop-guard + snapshot tests), but compared to the SDK's `.d.ts` ground truth, **Claude Agent SDK has ~13 top-level/subtypes not explicitly handled**, and **Codex SDK has 1 item type + 1 top-level event unhandled**. On the frontend, the `tool-call` renderer uses **fallback handling for unknown tool names** (gray circle icon + tool name text), and **unknown content-part types are silently discarded** (return null).

| Dimension | Claude Agent SDK | Codex SDK |
|---|---|---|
| Total top-level events (.d.ts) | 23 | 8 |
| Rust explicitly handled | 9 + partial system subtypes | 7 |
| Completely unhandled (falls into fallthrough/drop-guard) | **~10** | **2** |
| Handled but silently swallowed | 2 | 0 |
| Total content block types (.d.ts) | 15 | 8 (item) |
| Rust explicitly handled | 8 + 6 server-tool result | 7 |
| Content blocks unhandled | **2** (mcp_tool_use, mcp_tool_result, container_upload, compaction) | **1** (ErrorItem) |
| Frontend tool name specialization | 13 | Same as left |

**Most critical gaps** (ranked by real-world risk):

1. **Claude `mcp_tool_use` / `mcp_tool_result` content blocks**: When users have MCP servers installed, model calls to MCP tools use these two block types, but **Rust adapter silently drops them at `blocks.rs:136`**. Result: "model says it's using an MCP tool, but the UI shows nothing".
2. **Claude `compaction` content block**: During context compaction, `stop_reason: 'compaction'` paired with this block presents a compaction summary — currently **the entire block is dropped**, so users can't see why the conversation suddenly got shorter.
3. **Claude `container_upload` content block**: The file_id when the model uploads files to a container is currently **dropped**.
4. **Claude new system subtypes**: `api_retry`, `hook_started/progress/response`, `session_state_changed`, `files_persisted`, `elicitation_complete` — these 6 subtypes added in v0.2.92 all fall through to the generic `"System: {subtype}"` fallback (`labels.rs:151-152`), showing a raw string instead of a structured notification.
5. **Claude `auth_status`, `tool_use_summary` top-level events**: The dispatch match has **no branches for these** — they enter `dropped_event_types` triggering build failure (the drop-guard protects, but means the entire test suite fails whenever these events appear).
6. **Codex `ErrorItem` (`item.type === "error"`)**: The item dispatch fallthrough also enters the drop-guard, causing build failure.
7. **Codex `ThreadErrorEvent` (top-level `type === "error"`)**: Shares the dispatch branch with Claude's `error`, but Claude's error doesn't have the nested `error.message` field, so the shape may mismatch — the render layer shows "Error: <fallback>".
8. **During frontend streaming partial, tool call JSON is mid-flight**: tool_name is `"unknown"` (streaming.rs:109), so for about a second the UI shows a gray circle icon + "unknown", until `content_block_stop` finalizes it.
9. **`SDKAssistantMessageError` (`message.error`)**: Claude SDK in v0.2.92 added an `error` field to assistant messages indicating turn-level failure reason (e.g. `'rate_limit'`/`'max_output_tokens'`), but **the adapter doesn't read this field at all**, so users can't see why an assistant message was interrupted.

Detailed breakdown follows below.

---

## Part 1: Claude Agent SDK v0.2.92 — Top-level Events

The full set of `SDKMessage` comes from `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2389`, totaling **23 variants**.

### A. Full Coverage Matrix

| `type` | `subtype` | SDK Class | Rust Handler | Frontend Rendering | Status |
|---|---|---|---|---|---|
| `assistant` | — | `SDKAssistantMessage` | `accumulator/mod.rs:196-199` → `handle_assistant` | `ChatAssistantMessage` (workspace-panel.tsx:1455) | ✅ HANDLED |
| `user` | — | `SDKUserMessage` | `accumulator/mod.rs:200-202` → `handle_user` | `ChatUserMessage` or merge into preceding assistant's tool_result | ✅ HANDLED |
| `user` | — | `SDKUserMessageReplay` (`isReplay: true`) | Same `user` branch | Same as above, but `isReplay` / `file_attachments` fields not read | ⚠️ PARTIAL — `isReplay` flag ignored, attachments not rendered |
| `result` | `success` | `SDKResultSuccess` | `accumulator/mod.rs:204-206` → `handle_result` | `make_system(... build_result_label)` → SystemNotice text | ✅ HANDLED — Only renders cost/duration/tokens; `structured_output`, `deferred_tool_use`, `stop_reason`, `permission_denials`, `terminal_reason`, `fast_mode_state` **all read then discarded** |
| `result` | `error_during_execution` | `SDKResultError` | Same as above | Same as above, rendered as "Done - <fields>" | ⚠️ PARTIAL — `errors: string[]` **not rendered**, user can't distinguish between "max_turns / max_budget_usd / max_structured_output_retries" |
| `result` | `error_max_turns` | Same as above | Same as above | Same as above | ⚠️ PARTIAL |
| `result` | `error_max_budget_usd` | Same as above | Same as above | Same as above | ⚠️ PARTIAL |
| `result` | `error_max_structured_output_retries` | Same as above | Same as above | Same as above | ⚠️ PARTIAL |
| `system` | `init` | `SDKSystemMessage` | `adapter/mod.rs:418-419` | **Silently dropped** (comment: model selector already displayed) | ✅ INTENTIONAL DROP |
| `system` | `compact_boundary` | `SDKCompactBoundaryMessage` | `labels.rs:151-152` fallback | Rendered as `"System: compact_boundary"` string | ❌ FALLTHROUGH — `compact_metadata.{trigger, pre_tokens, preserved_segment}` info **lost**, user can't see why conversation was compacted |
| `system` | `status` | `SDKStatusMessage` | Fallback | `"System: status"` | ❌ FALLTHROUGH — `status: 'compacting' \| null` should show a spinner |
| `system` | `api_retry` | `SDKAPIRetryMessage` | Fallback | `"System: api_retry"` | ❌ FALLTHROUGH — `attempt`/`max_retries`/`retry_delay_ms`/`error` fields all lost, important "retrying attempt N" info invisible |
| `system` | `local_command_output` | `SDKLocalCommandOutputMessage` | `adapter/mod.rs:423-436` | Info SystemNotice + body is `content` | ✅ HANDLED |
| `system` | `hook_started` | `SDKHookStartedMessage` | Fallback | `"System: hook_started"` | ❌ FALLTHROUGH |
| `system` | `hook_progress` | `SDKHookProgressMessage` | Fallback | `"System: hook_progress"` | ❌ FALLTHROUGH — `stdout`/`stderr` real-time output **lost** |
| `system` | `hook_response` | `SDKHookResponseMessage` | Fallback | `"System: hook_response"` | ❌ FALLTHROUGH — `outcome`/`exit_code`/`output` all invisible |
| `system` | `task_started` | `SDKTaskStartedMessage` | `labels.rs:107-111` → `build_subagent_notice` | Info SystemNotice "Subagent started" + body is `description` | ✅ HANDLED |
| `system` | `task_progress` | `SDKTaskProgressMessage` | `labels.rs:112-116` | Info SystemNotice "Subagent progress" + body is `summary \|\| description` | ✅ HANDLED — but `usage.{total_tokens, tool_uses, duration_ms}` / `last_tool_name` fields **not rendered** |
| `system` | `task_completed` | (This subtype **does not exist** in .d.ts) | `labels.rs:117-121` | "Subagent completed" | ⚠️ DEAD CODE — pipeline listens for a subtype the SDK never sends |
| `system` | `task_notification` | `SDKTaskNotificationMessage` | `labels.rs:122-134` | Info/Error/Warning notice based on `status` in {completed,failed,cancelled} | ✅ HANDLED |
| `system` | `session_state_changed` | `SDKSessionStateChangedMessage` | Fallback | `"System: session_state_changed"` | ❌ FALLTHROUGH — `state: 'idle' \| 'running' \| 'requires_action'` is the **authoritative turn-over signal**, currently completely unused. If used, could replace sidecar's own `end` frame |
| `system` | `files_persisted` | `SDKFilesPersistedEvent` | Fallback | `"System: files_persisted"` | ❌ FALLTHROUGH — `files`/`failed` arrays lost |
| `system` | `elicitation_complete` | `SDKElicitationCompleteMessage` | Fallback | `"System: elicitation_complete"` | ❌ FALLTHROUGH — MCP elicitation completed, UI could dismiss waiting state |
| `stream_event` | — | `SDKPartialAssistantMessage` | `accumulator/mod.rs:186-188` → `streaming::handle_stream_event` | Streaming partial injected into `blocks` state, frontend uses `streamingPartial` | ✅ HANDLED — but only when sidecar sets `includePartialMessages: true`; see Part 3 |
| `tool_progress` | — | `SDKToolProgressMessage` | `accumulator/mod.rs:190-192` → `streaming::handle_tool_progress` | Sets corresponding ToolUse block's `streaming_status` to "running" | ✅ HANDLED — but `elapsed_time_seconds`/`task_id` fields ignored |
| `tool_use_summary` | — | `SDKToolUseSummaryMessage` | **No dispatch branch** | — | 🚨 **DROP-GUARD FAIL** — appearance causes build failure |
| `auth_status` | — | `SDKAuthStatusMessage` | **No dispatch branch** (type literal is `'auth_status'`, not `'system'`) | — | 🚨 **DROP-GUARD FAIL** |
| `rate_limit_event` | — | `SDKRateLimitEvent` | `accumulator/mod.rs:212-214` → `handle_rate_limit_event` → `adapter/mod.rs:112-115` → `convert_rate_limit_msg` | Only rendered as `Warning` SystemNotice when `status != "allowed"`. Comment explains: every user turn emits `allowed` status, which is noise. | ✅ HANDLED |
| `prompt_suggestion` | — | `SDKPromptSuggestionMessage` | `accumulator/mod.rs:216-218` → `handle_prompt_suggestion` → `adapter/mod.rs:120-140` | `PromptSuggestion` part → `<button>` injected into input box | ✅ HANDLED |

### B. Visible Consequences of System Subtype Gaps

`labels.rs:139-153`'s `build_system_label` is:

```rust
match sub {
    Some("init") => format!("Session initialized — {m}"),  // but unreachable, already dropped above
    Some(s) => format!("System: {s}"),                     // ← all "unknown" subtypes go here
    None => "System".to_string(),
}
```

This means all `compact_boundary`, `status`, `api_retry`, `hook_*`, `session_state_changed`, `files_persisted`, `elicitation_complete` show up on the user's screen as a single raw string:

> System: api_retry

While the actual fields (retry count, error code, reset time) are all buried in the raw JSON with nobody reading them.

### C. Actual Drop-guard Trigger Points

`accumulator/mod.rs:283-294` fallthrough:

```rust
other => {
    let label = other.unwrap_or("<missing-type>").to_string();
    if !self.dropped_event_types.contains(&label) {
        self.dropped_event_types.push(label);
    }
    PushOutcome::NoOp
}
```

`pipeline_streams.rs` asserts `dropped_event_types().is_empty()` in tests, so **any top-level type without a dispatch branch will fail the build once it appears**. Currently triggerable:

- `tool_use_summary`
- `auth_status`
- Codex `error` (top-level `ThreadErrorEvent`, shares the same `error` literal as Claude but has a different shape)

> Note: Does Claude also have a top-level `error` event? Answer: **The SDKMessage union has no `type: 'error'` variant**. The `error` in .d.ts are all fields (`SDKAssistantMessage.error`, `SDKAPIRetryMessage.error`), not message types. So `accumulator/mod.rs:208-210`'s `Some("error") =>` actually only serves two sources:
> 1. Codex `ThreadErrorEvent` (top-level `{ type: "error", message }`)
> 2. Sidecar's own synthesized error frames

This means ThreadErrorEvent is handled — but Codex also has an **`ErrorItem`** (item.type === "error", inside item.completed/started/updated) that goes through `codex.rs:94-98`'s fallthrough, triggering the drop-guard. See Part 2.

### D. `SDKAssistantMessage.error` Field (Important Omission)

Full definition at `sdk.d.ts:1895`:

```typescript
{
  type: 'assistant';
  message: BetaMessage;
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;        // ← here
  uuid: UUID;
  session_id: string;
}

type SDKAssistantMessageError =
  | 'authentication_failed' | 'billing_error' | 'rate_limit'
  | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';
```

`accumulator/mod.rs:436-497`'s `handle_assistant` doesn't read this field at all. So when a model turn is interrupted mid-way due to token limit/billing error, **the frontend only shows truncated assistant text with no error explanation**.

### E. `BetaMessage.stop_reason` Field (Also Unread)

`stop_reason` values (`messages.d.ts:1312`):

```
'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
| 'pause_turn' | 'compaction' | 'refusal' | 'model_context_window_exceeded'
```

`pause_turn`, `refusal`, `model_context_window_exceeded`, `max_tokens` are all states users should be aware of ("model refused", "context exceeded"), but are currently all ignored. `adapter/mod.rs:215-216` hardcodes `reason: Some("stop")` for all assistant messages, regardless of the actual stop_reason.

---

## Part 2: Claude Content Blocks (assistant.message.content[])

The `BetaContentBlock` union (`messages.d.ts:592`) has **15 variants**.

### A. Coverage Matrix

| Block `type` | SDK Type | Rust Handler | Output MessagePart | Frontend Component | Status |
|---|---|---|---|---|---|
| `text` | `BetaTextBlock` | `blocks.rs:55-60` | `Text { text }` | `AssistantText` (1757-1787) → `LazyStreamdown` | ✅ HANDLED — `citations` field **not read** |
| `thinking` | `BetaThinkingBlock` | `blocks.rs:37-47` | `Reasoning { text, streaming }` | `Reasoning` collapsible panel (ai/reasoning.tsx) | ✅ HANDLED — `signature` field not read (no visual impact) |
| `redacted_thinking` | `BetaRedactedThinkingBlock` | `blocks.rs:49-54` | `Reasoning { text: "[Thinking redacted]" }` | Same as above | ✅ HANDLED |
| `tool_use` | `BetaToolUseBlock` | `blocks.rs:89-135` | `ToolCall { tool_call_id, tool_name, args, ... }`, merged into `TodoList` when `tool_name == "TodoWrite"` | `AssistantToolCall` routed to `getToolInfo()` (2588-2731) | ✅ HANDLED — `caller` field not read |
| `server_tool_use` | `BetaServerToolUseBlock` | `blocks.rs:89-135` same branch | Same as above | Same as above | ✅ HANDLED — `name in {web_search, web_fetch, code_execution, bash_code_execution, text_editor_code_execution, tool_search_tool_regex, tool_search_tool_bm25}` all hit frontend fallthrough (gray circle icon) |
| `web_search_tool_result` | `BetaWebSearchToolResultBlock` | `blocks.rs:81-87` → `attach_server_tool_result` | Entire JSON block attached as `result` to matching ToolCall | Tool card expandable output panel (frontend renders entire JSON as string) | ⚠️ PARTIAL — `BetaWebSearchResultBlock` (with title/url/page_age) and `BetaWebSearchToolResultError` structured info are serialized as JSON string into `<pre>`, **no structured display** (link list, error code badge) |
| `web_fetch_tool_result` | `BetaWebFetchToolResultBlock` | Same as above | Same as above | Same as above | ⚠️ PARTIAL — Same as above |
| `code_execution_tool_result` | `BetaCodeExecutionToolResultBlock` | Same as above | Same as above | Same as above | ⚠️ PARTIAL — `BetaCodeExecutionResultBlock { return_code, stdout, stderr, content: BetaCodeExecutionOutputBlock[] }` and `BetaEncryptedCodeExecutionResultBlock` are both stringified, stdout/stderr/exit code have no dedicated UI |
| `bash_code_execution_tool_result` | `BetaBashCodeExecutionToolResultBlock` | Same as above | Same as above | Same as above | ⚠️ PARTIAL |
| `text_editor_code_execution_tool_result` | `BetaTextEditorCodeExecutionToolResultBlock` | Same as above | Same as above | Same as above | ⚠️ PARTIAL — view/create/str_replace three result types (with lines diff info) have no dedicated display |
| `tool_search_tool_result` | `BetaToolSearchToolResultBlock` | Same as above | Same as above | Same as above | ⚠️ PARTIAL |
| `mcp_tool_use` | `BetaMCPToolUseBlock` | **`blocks.rs:136` silently dropped** | None | None | 🚨 **MISSING** — User's MCP tool calls are **completely invisible** |
| `mcp_tool_result` | `BetaMCPToolResultBlock` | **Silently dropped** | None | None | 🚨 **MISSING** — `is_error: boolean` + content (string or BetaTextBlock[]) lost |
| `container_upload` | `BetaContainerUploadBlock` | **Silently dropped** | None | None | 🚨 **MISSING** — `file_id: string`, model file upload to container event lost |
| `compaction` | `BetaCompactionBlock` | **Silently dropped** | None | None | 🚨 **MISSING** — Context compaction summary text (`content: string \| null`) lost. This block combined with the system `compact_boundary` above constitutes the "why the conversation got shorter" explanation, which has no UI at all |

### B. `image` and `document` Content Blocks

In theory, the Anthropic SDK lists `image`/`document` as members of `MessageParam.content` (**user-side**), not in `BetaContentBlock` (assistant-side). But Helmor's adapter (`blocks.rs:62-70`) **also matches** `"image"` and `"document"` when parsing assistant content:

- `parse_image_block` (327-351): Only recognizes `source.type in {base64, url}`, **ignores** `file` source (`BetaFileImageSource` — `type: 'file', file_id: string`). When model replies contain file references uploaded to a container, the image won't display.
- `parse_document_block` (281-292): Takes the `data` field when `source.type === 'text'`; `base64` or others fall back to "[Document attached]". The Anthropic SDK actually defines `PlainTextSource` / `Base64PDFSource` / `ContentBlockSource` / `URLPDFSource` / `FilePDFSource` multiple document sources, with `url` / `file` / `content` all hitting the fallback.

### C. `tool_result` Reverse Path (user → merged into assistant)

`blocks.rs:160-200`'s `extract_tool_results`:

| Accepted content shape | Parsing behavior |
|---|---|
| `string` | Used as-is for result |
| `[{type:"text", text}, ...]` | Text blocks joined with `\n` |
| `[{type:"image"}, ...]` | Skipped; image blocks in the array **don't block** all_tool_result, but image data is discarded by `extract_tool_result_content` |
| `[{type:"file"}, ...]` | Same as above, skipped |
| `[{type:"search_result"}, ...]` | **All non-text/image/file types set `all_tool_result = false`**, causing the entire message to be rejected for merging |
| `[{type:"document"}, ...]` | Same as above, merge rejected |
| `[{type:"tool_reference"}, ...]` | Same as above, merge rejected |

Consequence: When a tool returns content containing a `search_result` block (which is the native return shape for Anthropic's search tool), **the entire user message is identified as "not pure tool_result", merge is cancelled**, and the user sees the assistant's tool_use as a standalone card + a detached system message (because downstream logic renders it as an unknown event).

### D. content_block_start During Streaming

`streaming.rs:79-118` only accepts `text` / `thinking` / `tool_use` as content block start events; all other 12 types fall through to `_ => {}`. **During streaming, server-tool / mcp / compaction block start events are dropped** — only after the block ends, when the complete assistant message arrives as a `type: 'assistant'` full frame, does `blocks.rs` get a chance to see it (and by then it's in the full parsing path, not streaming rendering).

### E. content_block_delta During Streaming

`streaming.rs:121-164` handles three delta types: `text_delta` / `thinking_delta` / `input_json_delta`. The `.d.ts` also defines:

- `citations_delta` — streaming append of citations for text blocks, **unhandled** (citations invisible during streaming, must wait for full frame)
- `signature_delta` — streaming append of thinking block signature, **unhandled** (no visual impact)
- `compaction_delta` — streaming append of compaction block content, **unhandled**

---

## Part 3: Claude Streaming Toggle

`sdk.d.ts:1089` defines the `Options.includePartialMessages` option, **default false**. Helmor's sidecar in `claude-session-manager.ts` doesn't explicitly enable it. This means:

- The pipeline's `streaming.rs` machinery is actually **only useful for sessions with `includePartialMessages: true`**
- By default, the SDK emits each finalized content block as a separate `SDKAssistantMessage` event (same `message.id`, content array appended block by block), handled by `accumulator/mod.rs:464-487`'s "delta-style append" logic. This is Helmor's actual operating mode.
- Since partial isn't enabled, the entire `streaming.rs` (including drops of unknown content_block types) only has coverage in test fixtures. **The production path uses `handle_assistant`**

Action needed: Confirm whether sidecar intends to enable partial. If not, half of streaming.rs code can be deleted along with corresponding fixtures; if yes, all delta types from Part 2 Section E need to be implemented.

---

## Part 4: Codex SDK v0.118.0 — Top-level Events

The `ThreadEvent` union (`dist/index.d.ts:161-162`) has **8 variants**.

### A. Coverage Matrix

| `type` | SDK Type | Rust Handler | Status |
|---|---|---|---|
| `thread.started` | `ThreadStartedEvent` | `accumulator/mod.rs:266-270` only updates `session_id` | ✅ HANDLED (no-op) |
| `turn.started` | `TurnStartedEvent` | `accumulator/mod.rs:263` no-op | ✅ HANDLED (no-op) — comment explains why |
| `turn.completed` | `TurnCompletedEvent` | `accumulator/mod.rs:249-251` → `handle_turn_completed` | ✅ HANDLED — `usage.cached_input_tokens` field not read, but input/output are read |
| `turn.failed` | `TurnFailedEvent` | `accumulator/mod.rs:253-255` → `handle_codex_turn_failed`, reshaped into Claude `error` form | ✅ HANDLED |
| `item.started` | `ItemStartedEvent` | `accumulator/mod.rs:245-247` → `handle_item_snapshot(persist=false)` | ✅ HANDLED |
| `item.updated` | `ItemUpdatedEvent` | Same as above | ✅ HANDLED |
| `item.completed` | `ItemCompletedEvent` | `accumulator/mod.rs:241-243` → `handle_item_completed` | ✅ HANDLED |
| `error` | `ThreadErrorEvent` | `accumulator/mod.rs:208-210` → `handle_error` reuses Claude error path | ⚠️ PARTIAL — Codex shape is `{ type:"error", message }`, but `build_error_label` first tries `parsed.content`, then `parsed.message`, which picks up `message`. **No issue, handled** |

> Note: `thread.resumed` is also recognized at `accumulator/mod.rs:266`, but Codex SDK v0.118.0's .d.ts **does not have** a `thread.resumed` event — this is a dead branch, likely a historical artifact.

### B. ThreadEvents Not Entering Dispatch
**No omissions**. All 8 top-level events are covered.

---

## Part 5: Codex Item Types (item.started/updated/completed.item)

The `ThreadItem` union (`dist/index.d.ts:102-103`) has **8 variants**.

### A. Coverage Matrix

| item `type` | SDK Type | Rust Handler (`codex.rs`) | Synthesized Claude Form | Historical Replay (`codex_items.rs`) | Final Frontend Rendering | Status |
|---|---|---|---|---|---|---|
| `agent_message` | `AgentMessageItem` | `codex.rs:40-60` `handle_agent_message` | `assistant.message.content = [{type:"text", text}]` | `codex_items.rs:36-51` | `AssistantText` (Streamdown) | ✅ HANDLED |
| `reasoning` | `ReasoningItem` | `codex.rs:68-70` `handle_reasoning` | `assistant.message.content = [{type:"thinking", thinking}]` | `codex_items.rs:122-140` | `Reasoning` collapsible panel | ✅ HANDLED |
| `command_execution` | `CommandExecutionItem` | `codex.rs:88-90` `handle_command_execution` | `tool_use { name:"Bash", input:{command} }` + subsequent user tool_result | `codex_items.rs:63-103` | `AssistantToolCall` Bash card | ✅ HANDLED |
| `file_change` | `FileChangeItem` | `codex.rs:73-75` `handle_file_change` | `tool_use { name:"apply_patch", input:{changes} }` | `codex_items.rs:143-181` | Generic ToolCall gray circle icon ("apply_patch" not in `getToolInfo` list!) | ⚠️ PARTIAL — Rust synthesis is correct, but **frontend `getToolInfo` has no `apply_patch` branch**, falls into fallthrough, file changes display as gray circle + "apply_patch" string, no add/delete/update badge |
| `mcp_tool_call` | `McpToolCallItem` | `codex.rs:83-85` `handle_mcp_tool_call` | `tool_use { name:"mcp__{server}__{tool}", input:arguments }` | `codex_items.rs:209-252` | Same fallthrough gray circle icon | ⚠️ PARTIAL — Frontend has no `mcp__*` pattern specialization, all MCP tools display as full tool name string |
| `web_search` | `WebSearchItem` | `codex.rs:78-80` `handle_web_search` | `tool_use { name:"WebSearch", input:{query} }` | `codex_items.rs:184-206` | `AssistantToolCall` WebSearch card | ✅ HANDLED |
| `todo_list` | `TodoListItem` | `codex.rs:63-65` `handle_todo_list` | `tool_use { name:"TodoWrite", input:{todos:[...]} }` then collapsed into `TodoList` part by `parse_claude_todowrite_items` | `codex_items.rs:106-119` | `TodoList` (1616-1657) | ✅ HANDLED |
| `error` | `ErrorItem` | **`codex.rs:94-98` falls through** → `dropped_event_types.push("error")` | — | — | — | 🚨 **DROP-GUARD FAIL** — appearance causes build failure |

### B. Codex Item Field Gaps

| item | Unread fields | Impact |
|---|---|---|
| `command_execution` | `aggregated_output` is actually read in `handle_command_execution`, but the `status` field ("in_progress"/"completed"/"failed") is currently inferred from `exit_code is null` — when SDK ground truth disagrees (e.g. "failed" but has exit_code), inference is wrong | Command failure status may be incorrectly labeled as "running" |
| `file_change` | `changes[].kind in {add, delete, update}` is passed through to args, but frontend doesn't consume it | UI can't distinguish between add vs. modify |
| `mcp_tool_call` | `result.content` (from `@modelcontextprotocol/sdk`'s `ContentBlock` union, containing text/image/audio/resource/resource_link) is stuffed into result as a JSON string | image/audio/resource won't display, only raw JSON |
| `web_search` | The item itself only exposes `query`, no results field (SDK limitation) — can't improve | — |
| `todo_list` | Codex only has `completed: bool`, no in_progress state. `blocks.rs:384-410`'s `parse_codex_todolist_items` only maps `Completed`/`Pending`, **never produces InProgress** | Visual consistency with Claude TodoWrite lost (Codex never has "in progress" items) |

### C. Why Does `item.completed` Enter the `convert_flat` Main Loop?

This is a curious design point: the `accumulator` synthesizes Codex item.* into Claude form (`{type:"assistant", message:...}`), then downstream adapter directly takes the Claude path — but simultaneously `convert_flat` also has a `Some("item.completed")` branch (`adapter/mod.rs:279-283`) going through `codex_items::render_item_completed`.

After reading the implementation: the **accumulator path** is for streaming (synthesize then collect), the **adapter path** is for historical replay (DB stores raw `item.completed` JSON directly, without going through the accumulator). The two paths maintain two separate item type → rendering mappings that must stay in sync.

Risk: When adding a new item type, **both places must be updated**. Currently both are missing the `error` branch — when adding it, both must be updated together.

---

## Part 6: Frontend Rendering Layer

### A. content-part Type → Component

File: `src/components/workspace-panel.tsx`, type definitions: `src/lib/api.ts:1364-1390`.

| MessagePart `type` | Type Guard | Rendering Component | Line |
|---|---|---|---|
| `text` | `isTextPart` (2495) | `AssistantText` (memo) | 1757-1787 |
| `reasoning` | `isReasoningPart` (2501) | `Reasoning` collapsible panel | 1481-1492 |
| `tool-call` | `isToolCallPart` (2509) | `AssistantToolCall` (memo) | 1502-1512 |
| `collapsed-group` | `isCollapsedGroupPart` (2520) | `CollapsedToolGroup` | 1494-1500 |
| `todo-list` | `isTodoListPart` (2537) | `TodoList` | 1514-1515 |
| `image` | `isImagePart` (2541) | `ImageBlock` | 1517-1518 |
| `system-notice` | `isSystemNoticePart` (2526) | System role only | 1554-1576 |
| `prompt-suggestion` | `isPromptSuggestionPart` (2545) | System role only | 1578-1600 |
| **Unknown** | — | **`return null` silently discarded** | 1520 |

Note: The previous explore report stated "frontend doesn't use @assistant-ui/react". After reading the entry point, this is confirmed — routing is in the custom `ChatThread`, no `ExternalStoreRuntime`. The assistant-ui description in CLAUDE.md doesn't match the actual code; this is documentation drift (worth a separate PR to fix, but not this audit's scope).

### B. Tool Name → Component Routing (`getToolInfo` at 2588-2731)

| tool name | Rendering details |
|---|---|
| `Edit` | Pencil icon + filename + diff count (reads `old_string`/`new_string`) |
| `Read` | FileText icon + filename (+ line limit) |
| `Write` | FilePlus icon + filename |
| `Bash` | Terminal icon + truncated command (80 chars) |
| `Grep` | Search icon + pattern |
| `Glob` | FolderSearch icon + pattern |
| `WebFetch` | Globe icon + URL (truncated 60) |
| `WebSearch` | Globe icon + query (truncated 50) |
| `ToolSearch` | Search icon + query |
| `Agent`, `Task` | Bot icon + `subagent_type` or prompt (with `AgentChildrenBlock` child tool preview) |
| `Prompt` | MessageSquareText icon (folders into parent Task's children) |
| **Other** | **Gray circle + tool name string** (line 2730 fallthrough) |

### C. Consequence: Tools Not in `getToolInfo` List Get an Ugly Fallback

Tools synthesized from SDK shapes but lacking dedicated frontend rendering:

- `apply_patch` (Codex file_change) — should have a patch diff UI
- `mcp__{server}__{tool}` pattern — should have MCP server name prefix + tool name + server icon
- Claude server tools' built-in names (`web_search` lowercase, `web_fetch`, `code_execution`, `bash_code_execution`, `text_editor_code_execution`, `tool_search_tool_regex`, `tool_search_tool_bm25`) — these are the literal values of `BetaServerToolUseBlock.name`, but the frontend only recognizes uppercase `WebSearch`/`WebFetch`, so server-tool calls hit the fallthrough
- Any user-defined MCP tools

### D. Blind Spot of content-part Silent Discard

`workspace-panel.tsx:1520`'s `return null` is a **safety net**, not a bug — the Rust side theoretically shouldn't emit unknown part types. In practice, the Rust `MessagePart` enum goes through type system checks before serde serialization, so this branch is almost never hit.

The only scenario where it could be hit: the `ExtendedMessagePart::Basic(MessagePart::*)` type field gets serialized to camelCase, and the frontend type guard has a string typo. After reading `src-tauri/src/pipeline/types.rs` serde tags and `api.ts` string unions, the names match up.

---

## Part 7: Risk/Priority

### P0 — Fix Immediately
1. **Codex `ErrorItem` triggers drop-guard fail**: Any Codex non-fatal error causes the test suite to fail. Add an `"error" =>` branch in `accumulator/codex.rs:94-98`, synthesize as `system` error notification.
2. **Claude `auth_status` / `tool_use_summary` triggers drop-guard fail**: Triggered when user OAuth reconnects or SDK upgrades. Add branches before `accumulator/mod.rs:282` match.

### P1 — Critical Data Loss
3. **`mcp_tool_use` / `mcp_tool_result` / `container_upload` / `compaction` content blocks silently dropped**: The most direct experience regression for MCP users. Add four branches before `blocks.rs:136`:
   - `mcp_tool_use` → Reuse `tool_use` parsing path, add `server_name` field; add `mcp__*` pattern routing on frontend
   - `mcp_tool_result` → Reuse `attach_server_tool_result` but result content is `string \| BetaTextBlock[]`, not entire JSON block
   - `container_upload` → New `ContainerUpload` MessagePart or synthesize as `Image` part (using file_id)
   - `compaction` → New `SystemNotice` "Context compacted" + body is content field
4. **`SDKAssistantMessage.error` field unread**: Users get no indication when an assistant turn is interrupted due to token limits. Read the `error` field in `accumulator/mod.rs:436`'s `handle_assistant`, synthesize a SystemNotice following the assistant message.
5. **`BetaMessage.stop_reason` not passed through**: `adapter/mod.rs:215` hardcodes `"stop"`, should pass through `pause_turn`/`refusal`/`max_tokens`/`model_context_window_exceeded` to the frontend status display.

### P2 — UX Degradation
6. **Claude `system` subtypes hit fallback**: 6 new subtypes (`compact_boundary`, `status`, `api_retry`, `hook_started/progress/response`, `session_state_changed`, `files_persisted`, `elicitation_complete`) need corresponding `build_*_notice` functions. `api_retry` and `compact_boundary` are the two most user-visible.
7. **Server-tool results lack structured UI**: `web_search_tool_result` should render as a link list, `code_execution_tool_result` should render as stdout/stderr/exit code sections. Currently stuffing entire JSON blocks into `<pre>`.
8. **Frontend `apply_patch` not specialized**: Codex file changes only show a gray circle. Add an `apply_patch` branch in `getToolInfo`.
9. **Frontend `mcp__{server}__{tool}` has no pattern matching**: Add an `if (toolName.startsWith("mcp__"))` branch in `getToolInfo`.

### P3 — Minor Field Gaps
10. `SDKResultError.errors[]`, `SDKResultSuccess.permission_denials`, `SDKResultSuccess.terminal_reason` not displayed in result label
11. `SDKToolProgressMessage.elapsed_time_seconds` not rendered (could be added to ToolCall card's right-side timestamp)
12. `SDKTaskProgressMessage.usage` not read (subagent token/tool use counts could be shown in notification body)
13. `Usage.cached_input_tokens` (Codex turn.completed) not read (frontend token stats should show cached separately)
14. `BetaTextBlock.citations` not read (used to display citation links for web search / web fetch results)
15. `parse_image_block` doesn't recognize `BetaFileImageSource` (`type: 'file', file_id`)
16. `parse_document_block` doesn't recognize `url`/`file`/`content` source types
17. `extract_tool_results` rejects user messages containing `search_result` / `document` / `tool_reference` blocks, causing entire merge to fail

### P4 — Dead Code
18. `labels.rs:117-121` listens for `task_completed` subtype, but SDK never sends it — dead branch
19. `accumulator/mod.rs:266` listens for Codex `thread.resumed`, SDK doesn't send it
20. `streaming.rs` entire machinery is only useful with `includePartialMessages: true`, sidecar doesn't enable by default — either enable or delete

---

## Part 8: Appendix — Key Source Code References

### Rust Entry Points
| File | Key Lines | Purpose |
|---|---|---|
| `src-tauri/src/agents.rs` | `send_agent_message_stream` | sidecar events → pipeline → IPC channel |
| `src-tauri/src/pipeline/accumulator/mod.rs:161-295` | `push_event` | Top-level dispatch (drop-guard at 283-294) |
| `src-tauri/src/pipeline/accumulator/streaming.rs:35-202` | `handle_stream_event` etc. | Claude content_block_* streaming |
| `src-tauri/src/pipeline/accumulator/codex.rs:22-99` | `handle_item_snapshot` | Codex item dispatch (drop-guard at 94-98) |
| `src-tauri/src/pipeline/adapter/mod.rs:81-320` | `convert_flat` | IntermediateMessage → ThreadMessageLike |
| `src-tauri/src/pipeline/adapter/blocks.rs:15-141` | `parse_assistant_parts` | content block → MessagePart (drop at 136) |
| `src-tauri/src/pipeline/adapter/blocks.rs:160-271` | `extract_tool_results` etc. | user tool_result merge |
| `src-tauri/src/pipeline/adapter/labels.rs:91-153` | `build_subagent_notice`/`build_system_label` | system subtype → notice/label |
| `src-tauri/src/pipeline/adapter/codex_items.rs:24-252` | `render_item_completed` | Historical replay of Codex items |

### Frontend Entry Points
| File | Key Lines | Purpose |
|---|---|---|
| `src/lib/api.ts:1317-1424` | Type definitions | `ThreadMessageLike` / `MessagePart` / `ExtendedMessagePart` |
| `src/components/workspace-panel.tsx:1395` | `ConversationMessage` | Route by role |
| `src/components/workspace-panel.tsx:1455-1523` | `ChatAssistantMessage` | content-part dispatch (drop at 1520) |
| `src/components/workspace-panel.tsx:2588-2731` | `getToolInfo` | tool name → icon/label/detail |
| `src/components/workspace-panel.tsx:1859-2057` | `AssistantToolCall` | Generic tool card |
| `src/components/workspace-panel.tsx:1616-1657` | `TodoList` | Plan UI |
| `src/components/workspace-panel.tsx:1602-1614` | `ImageBlock` | Image rendering |
| `src/components/ai/reasoning.tsx` | `Reasoning` collapsible panel | Thinking block |
| `src/components/streamdown-components.tsx` | Table component | Markdown table override |

### SDK Source-of-truth Files
| SDK | Key File |
|---|---|
| Claude Agent SDK top-level | `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (4405 lines) |
| Claude content blocks | `sidecar/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` (2965 lines) |
| Claude user content blocks | `sidecar/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:677,439-...` |
| Codex SDK (all) | `sidecar/node_modules/@openai/codex-sdk/dist/index.d.ts` (273 lines) |
| MCP ContentBlock (for Codex mcp_tool_call.result.content) | `sidecar/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:1918-2033,8079` |

### Drop-guard Tests
- `src-tauri/tests/pipeline_streams.rs` asserts `accumulator.dropped_event_types().is_empty()`
- Adding new SDK types without dispatch branches causes this test to fail, serving as a safety net

---

## Part 9: Suggested Next Steps

To close all gaps, the recommended order is:

1. **Fix the two P0 drop-guard failures first** (10 lines of code): Prevent the test suite from breaking on a new SDK event.
2. **Add fixture coverage for existing dead-letter paths**: Add a set of fixtures in `tests/fixtures/streams/`, each containing one type of "unhandled" event that the SDK actually emits (compaction, mcp_tool_use, auth_status, files_persisted, api_retry — one each). Let the drop-guard tests **fail first**, then decide how to render each. This is the key step to turning "unknown unknowns" into "known unknowns".
3. **Then close P1 content block gaps**: MCP users are the largest group, start with mcp_tool_use/result.
4. **P2 system subtypes**: Write a set of `build_*_notice` functions, mapping from .d.ts fields.
5. **P3 minor field gaps**: Do them together in a single PR, each change is small.
6. **P4 dead code cleanup**: Merge with any of the above PRs.

This report itself is step 1 — you can now decide whether P0 should be fixed in the current sprint, and prioritize the rest as you see fit.
