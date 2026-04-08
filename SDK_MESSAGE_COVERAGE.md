# SDK 消息覆盖审计报告

> 调查日期：2026-04-08
> 范围：`@anthropic-ai/claude-agent-sdk` v0.2.92 + `@openai/codex-sdk` v0.118.0
> 关注：sidecar → Rust pipeline → 前端组件 端到端覆盖

---

## TL;DR

**整体结论**：Helmor 的管线对**已知**事件类型有强约束（drop-guard + snapshot 测试），但相对 SDK 的 `.d.ts` 真值，**Claude Agent SDK 有 ~13 种顶层/子类型未被显式处理**，**Codex SDK 有 1 种 item 类型 + 1 种顶层事件未处理**。Frontend 层面，`tool-call` 渲染器对**未知工具名是兜底处理**（灰圆图标 + 工具名文本），**未知 content-part 类型是静默丢弃**（return null）。

| 维度 | Claude Agent SDK | Codex SDK |
|---|---|---|
| 顶层事件总数（.d.ts） | 23 | 8 |
| Rust 显式处理 | 9 + 系统子类型部分 | 7 |
| 完全未处理（落入 fallthrough/drop-guard） | **~10** | **2** |
| 已处理但被静默吃掉 | 2 | 0 |
| 内容块类型总数（.d.ts） | 15 | 8 (item) |
| Rust 显式处理 | 8 + 6 server-tool result | 7 |
| 内容块未处理 | **2**（mcp_tool_use, mcp_tool_result, container_upload, compaction） | **1**（ErrorItem） |
| 前端 tool 名特化 | 13 | 同左 |

**最关键的缺口**（按现实风险排序）：

1. **Claude `mcp_tool_use` / `mcp_tool_result` 内容块**：用户安装了 MCP 服务器后，模型对 MCP 工具的调用走的是这两种块，**Rust adapter 在 `blocks.rs:136` 静默丢弃**。会出现"模型说要用某个 MCP 工具，但 UI 上什么都没有"。
2. **Claude `compaction` 内容块**：上下文压缩时，`stop_reason: 'compaction'` 配合该块呈现压缩摘要——目前**整块被丢弃**，用户看不到为什么对话突然变短。
3. **Claude `container_upload` 内容块**：模型上传文件到容器时的 file_id，目前**被丢弃**。
4. **Claude system 新子类型**：`api_retry`、`hook_started/progress/response`、`session_state_changed`、`files_persisted`、`elicitation_complete` 这 6 个 v0.2.92 加进来的子类型，pipeline 全部走通用 `"System: {subtype}"` 兜底（`labels.rs:151-152`），看到的是裸的字符串而不是结构化通知。
5. **Claude `auth_status`、`tool_use_summary` 顶层事件**：dispatch match 里**没有任何分支**——会进 `dropped_event_types` 触发 build 失败（drop-guard 会保护，但意味着只要这些事件出现，整个测试套件挂掉）。
6. **Codex `ErrorItem`（`item.type === "error"`）**：item 派发的 fallthrough 也会进 drop-guard，build 失败。
7. **Codex `ThreadErrorEvent`（顶层 `type === "error"`）**：与 Claude 的 `error` 共用 dispatch 分支，但 Claude 的 error 不带 `error.message` 嵌套字段，shape 可能不匹配——render 层会显示 "Error: <fallback>"。
8. **前端流式 partial 期间，工具调用流入 JSON 中途**：tool_name 为 `"unknown"`（streaming.rs:109），这一秒 UI 会显示一个灰圆图标 + "unknown"，直到 `content_block_stop` 才转正。
9. **`SDKAssistantMessageError` (`message.error`)**：Claude SDK 在 v0.2.92 给 assistant message 加了 `error` 字段表示 turn-level 失败原因（如 `'rate_limit'`/`'max_output_tokens'`），**adapter 完全没读这个字段**，用户看不到"为什么这条 assistant 消息中断了"。

下文是逐项明细。

---

## 第一部分：Claude Agent SDK v0.2.92 — 顶层事件

`SDKMessage` 的全集来自 `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2389`，共 **23 个变体**。

### A. 完整覆盖矩阵

| `type` | `subtype` | SDK 类名 | Rust 处理位置 | 前端渲染 | 状态 |
|---|---|---|---|---|---|
| `assistant` | — | `SDKAssistantMessage` | `accumulator/mod.rs:196-199` → `handle_assistant` | `ChatAssistantMessage` (workspace-panel.tsx:1455) | ✅ HANDLED |
| `user` | — | `SDKUserMessage` | `accumulator/mod.rs:200-202` → `handle_user` | `ChatUserMessage` 或 merge 进前置 assistant 的 tool_result | ✅ HANDLED |
| `user` | — | `SDKUserMessageReplay` (`isReplay: true`) | 走 `user` 同一个分支 | 同上，但 `isReplay` / `file_attachments` 字段未读取 | ⚠️ PARTIAL — `isReplay` 标志被忽略，attachments 未渲染 |
| `result` | `success` | `SDKResultSuccess` | `accumulator/mod.rs:204-206` → `handle_result` | `make_system(... build_result_label)` → SystemNotice 文本 | ✅ HANDLED — 仅渲染 cost/duration/tokens；`structured_output`、`deferred_tool_use`、`stop_reason`、`permission_denials`、`terminal_reason`、`fast_mode_state` **全部读取后丢弃** |
| `result` | `error_during_execution` | `SDKResultError` | 同上 | 同上，渲染为 "Done • <fields>" | ⚠️ PARTIAL — `errors: string[]` **未渲染**，用户看不到 "max_turns / max_budget_usd / max_structured_output_retries" 之间的区别 |
| `result` | `error_max_turns` | 同上 | 同上 | 同上 | ⚠️ PARTIAL |
| `result` | `error_max_budget_usd` | 同上 | 同上 | 同上 | ⚠️ PARTIAL |
| `result` | `error_max_structured_output_retries` | 同上 | 同上 | 同上 | ⚠️ PARTIAL |
| `system` | `init` | `SDKSystemMessage` | `adapter/mod.rs:418-419` | **静默 drop**（注释：模型选择器已显示） | ✅ INTENTIONAL DROP |
| `system` | `compact_boundary` | `SDKCompactBoundaryMessage` | `labels.rs:151-152` 兜底 | 渲染为 `"System: compact_boundary"` 字符串 | ❌ FALLTHROUGH — 有 `compact_metadata.{trigger, pre_tokens, preserved_segment}` 信息**丢失**，用户看不到为什么对话被压缩 |
| `system` | `status` | `SDKStatusMessage` | 兜底 | `"System: status"` | ❌ FALLTHROUGH — `status: 'compacting' \| null` 应该出现 spinner |
| `system` | `api_retry` | `SDKAPIRetryMessage` | 兜底 | `"System: api_retry"` | ❌ FALLTHROUGH — `attempt`/`max_retries`/`retry_delay_ms`/`error` 字段全丢，重要的"正在第 N 次重试"信息看不到 |
| `system` | `local_command_output` | `SDKLocalCommandOutputMessage` | `adapter/mod.rs:423-436` | Info SystemNotice + body 是 `content` | ✅ HANDLED |
| `system` | `hook_started` | `SDKHookStartedMessage` | 兜底 | `"System: hook_started"` | ❌ FALLTHROUGH |
| `system` | `hook_progress` | `SDKHookProgressMessage` | 兜底 | `"System: hook_progress"` | ❌ FALLTHROUGH — `stdout`/`stderr` 实时输出**丢失** |
| `system` | `hook_response` | `SDKHookResponseMessage` | 兜底 | `"System: hook_response"` | ❌ FALLTHROUGH — `outcome`/`exit_code`/`output` 都不可见 |
| `system` | `task_started` | `SDKTaskStartedMessage` | `labels.rs:107-111` → `build_subagent_notice` | Info SystemNotice "Subagent started" + body 是 `description` | ✅ HANDLED |
| `system` | `task_progress` | `SDKTaskProgressMessage` | `labels.rs:112-116` | Info SystemNotice "Subagent progress" + body 是 `summary || description` | ✅ HANDLED — 但 `usage.{total_tokens, tool_uses, duration_ms}` / `last_tool_name` 字段**未渲染** |
| `system` | `task_completed` | （此 subtype 在 .d.ts 中**不存在**） | `labels.rs:117-121` | "Subagent completed" | ⚠️ DEAD CODE — pipeline 监听了一个 SDK 不会发的 subtype |
| `system` | `task_notification` | `SDKTaskNotificationMessage` | `labels.rs:122-134` | Info/Error/Warning notice 按 `status` ∈ {completed,failed,cancelled} | ✅ HANDLED |
| `system` | `session_state_changed` | `SDKSessionStateChangedMessage` | 兜底 | `"System: session_state_changed"` | ❌ FALLTHROUGH — `state: 'idle' \| 'running' \| 'requires_action'` 是**权威 turn-over 信号**，目前完全不用。如果用了，可以替代 sidecar 自己的 `end` 帧 |
| `system` | `files_persisted` | `SDKFilesPersistedEvent` | 兜底 | `"System: files_persisted"` | ❌ FALLTHROUGH — `files`/`failed` 数组丢失 |
| `system` | `elicitation_complete` | `SDKElicitationCompleteMessage` | 兜底 | `"System: elicitation_complete"` | ❌ FALLTHROUGH — MCP 元素勾选完成，UI 可以闭合等待状态 |
| `stream_event` | — | `SDKPartialAssistantMessage` | `accumulator/mod.rs:186-188` → `streaming::handle_stream_event` | 流式 partial 注入到 `blocks` 状态，前端走 `streamingPartial` | ✅ HANDLED — 但仅当 sidecar 配 `includePartialMessages: true` 才会有；详见第三部分 |
| `tool_progress` | — | `SDKToolProgressMessage` | `accumulator/mod.rs:190-192` → `streaming::handle_tool_progress` | 把对应 ToolUse 块的 `streaming_status` 设为 "running" | ✅ HANDLED — 但 `elapsed_time_seconds`/`task_id` 字段被忽略 |
| `tool_use_summary` | — | `SDKToolUseSummaryMessage` | **无 dispatch 分支** | — | 🚨 **DROP-GUARD FAIL** — 出现即 build 挂 |
| `auth_status` | — | `SDKAuthStatusMessage` | **无 dispatch 分支**（type 字面量是 `'auth_status'`，不是 `'system'`） | — | 🚨 **DROP-GUARD FAIL** |
| `rate_limit_event` | — | `SDKRateLimitEvent` | `accumulator/mod.rs:212-214` → `handle_rate_limit_event` → `adapter/mod.rs:112-115` → `convert_rate_limit_msg` | 仅当 `status != "allowed"` 时才渲染为 `Warning` SystemNotice。注释解释：每个用户回合都会发 `allowed` 状态，是噪音。 | ✅ HANDLED |
| `prompt_suggestion` | — | `SDKPromptSuggestionMessage` | `accumulator/mod.rs:216-218` → `handle_prompt_suggestion` → `adapter/mod.rs:120-140` | `PromptSuggestion` part → `<button>` 注入到输入框 | ✅ HANDLED |

### B. 系统子类型缺口的可见后果

`labels.rs:139-153` 的 `build_system_label` 是：

```rust
match sub {
    Some("init") => format!("Session initialized — {m}"),  // 但走不到这儿，前面已经 drop 掉
    Some(s) => format!("System: {s}"),                     // ← 全部"未知"子类型走这里
    None => "System".to_string(),
}
```

也就是说所有 `compact_boundary`、`status`、`api_retry`、`hook_*`、`session_state_changed`、`files_persisted`、`elicitation_complete` 在用户屏幕上都是一行裸字符串：

> System: api_retry

而真正的字段（重试次数、错误码、reset 时间）全部塞在原始 JSON 里没人读。

### C. 真正的 drop-guard 触发点

`accumulator/mod.rs:283-294` 的 fallthrough：

```rust
other => {
    let label = other.unwrap_or("<missing-type>").to_string();
    if !self.dropped_event_types.contains(&label) {
        self.dropped_event_types.push(label);
    }
    PushOutcome::NoOp
}
```

`pipeline_streams.rs` 在测试里断言 `dropped_event_types().is_empty()`，所以**任何 dispatch 没有分支的顶层 type 一旦出现就会 fail build**。当前会触发的：

- `tool_use_summary`
- `auth_status`
- Codex `error`（顶层 `ThreadErrorEvent`，与 Claude 的 `error` 字面量同名但 shape 不一样）

> 注意：Claude 也有 `error` 顶层事件吗？答：**SDKMessage 联合里没有 `type: 'error'` 这一层**。.d.ts 里的 `error` 都是字段（`SDKAssistantMessage.error`、`SDKAPIRetryMessage.error`），不是消息类型。所以 `accumulator/mod.rs:208-210` 的 `Some("error") =>` 实际只服务两类来源：
> 1. Codex `ThreadErrorEvent`（顶层 `{ type: "error", message }`）
> 2. sidecar 自己合成的 error 帧

这意味着 ThreadErrorEvent 是被处理的——但 Codex 还有一个 **`ErrorItem`**（item.type === "error"，inside item.completed/started/updated）走 `codex.rs:94-98` 的 fallthrough，会触发 drop-guard。详见第二部分。

### D. `SDKAssistantMessage.error` 字段（重要遗漏）

`sdk.d.ts:1895` 的完整定义：

```typescript
{
  type: 'assistant';
  message: BetaMessage;
  parent_tool_use_id: string | null;
  error?: SDKAssistantMessageError;        // ← 这里
  uuid: UUID;
  session_id: string;
}

type SDKAssistantMessageError =
  | 'authentication_failed' | 'billing_error' | 'rate_limit'
  | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';
```

`accumulator/mod.rs:436-497` 的 `handle_assistant` 完全没读这个字段。所以模型 turn 中途因为 token 上限/billing 错误中断时，**前端只能看到一段截断的 assistant 文本，没有任何错误说明**。

### E. `BetaMessage.stop_reason` 字段（同样未读）

`stop_reason` 取值（`messages.d.ts:1312`）：

```
'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'
| 'pause_turn' | 'compaction' | 'refusal' | 'model_context_window_exceeded'
```

`pause_turn`、`refusal`、`model_context_window_exceeded`、`max_tokens` 都是用户应该感知到的状态（"模型拒绝了"、"超 context 了"），目前都被忽略。`adapter/mod.rs:215-216` 硬编码 `reason: Some("stop")` 给所有 assistant 消息，跟实际 stop_reason 无关。

---

## 第二部分：Claude 内容块（assistant.message.content[]）

`BetaContentBlock` 联合（`messages.d.ts:592`）共 **15 种**。

### A. 覆盖矩阵

| 块 `type` | SDK 类型 | Rust 处理 | 输出 MessagePart | 前端组件 | 状态 |
|---|---|---|---|---|---|
| `text` | `BetaTextBlock` | `blocks.rs:55-60` | `Text { text }` | `AssistantText` (1757-1787) → `LazyStreamdown` | ✅ HANDLED — `citations` 字段**未读取** |
| `thinking` | `BetaThinkingBlock` | `blocks.rs:37-47` | `Reasoning { text, streaming }` | `Reasoning` 折叠面板 (ai/reasoning.tsx) | ✅ HANDLED — `signature` 字段未读取（无视觉影响） |
| `redacted_thinking` | `BetaRedactedThinkingBlock` | `blocks.rs:49-54` | `Reasoning { text: "[Thinking redacted]" }` | 同上 | ✅ HANDLED |
| `tool_use` | `BetaToolUseBlock` | `blocks.rs:89-135` | `ToolCall { tool_call_id, tool_name, args, ... }`，`tool_name == "TodoWrite"` 时合并为 `TodoList` | `AssistantToolCall` 路由到 `getToolInfo()` (2588-2731) | ✅ HANDLED — `caller` 字段未读取 |
| `server_tool_use` | `BetaServerToolUseBlock` | `blocks.rs:89-135` 同分支 | 同上 | 同上 | ✅ HANDLED — `name ∈ {web_search, web_fetch, code_execution, bash_code_execution, text_editor_code_execution, tool_search_tool_regex, tool_search_tool_bm25}` 都在前端 fallthrough（灰圆图标） |
| `web_search_tool_result` | `BetaWebSearchToolResultBlock` | `blocks.rs:81-87` → `attach_server_tool_result` | 整块 JSON 作为 `result` 挂到匹配的 ToolCall | tool 卡片 expandable 输出面板（前端渲染整段 JSON 为字符串） | ⚠️ PARTIAL — `BetaWebSearchResultBlock`（含 title/url/page_age）和 `BetaWebSearchToolResultError` 的结构化信息都被序列化成 JSON 字符串塞给 `<pre>`，**没有结构化展示**（链接列表、错误码徽章） |
| `web_fetch_tool_result` | `BetaWebFetchToolResultBlock` | 同上 | 同上 | 同上 | ⚠️ PARTIAL — 同上 |
| `code_execution_tool_result` | `BetaCodeExecutionToolResultBlock` | 同上 | 同上 | 同上 | ⚠️ PARTIAL — `BetaCodeExecutionResultBlock { return_code, stdout, stderr, content: BetaCodeExecutionOutputBlock[] }` 和 `BetaEncryptedCodeExecutionResultBlock` 都被字符串化，stdout/stderr/exit code 没有专门 UI |
| `bash_code_execution_tool_result` | `BetaBashCodeExecutionToolResultBlock` | 同上 | 同上 | 同上 | ⚠️ PARTIAL |
| `text_editor_code_execution_tool_result` | `BetaTextEditorCodeExecutionToolResultBlock` | 同上 | 同上 | 同上 | ⚠️ PARTIAL — view/create/str_replace 三种结果（含 lines diff 信息）都没有专门展示 |
| `tool_search_tool_result` | `BetaToolSearchToolResultBlock` | 同上 | 同上 | 同上 | ⚠️ PARTIAL |
| `mcp_tool_use` | `BetaMCPToolUseBlock` | **`blocks.rs:136` 静默 drop** | 无 | 无 | 🚨 **MISSING** — 用户的 MCP 工具调用**完全不可见** |
| `mcp_tool_result` | `BetaMCPToolResultBlock` | **静默 drop** | 无 | 无 | 🚨 **MISSING** — `is_error: boolean` + content（string 或 BetaTextBlock[]）丢失 |
| `container_upload` | `BetaContainerUploadBlock` | **静默 drop** | 无 | 无 | 🚨 **MISSING** — `file_id: string`，模型把文件传到容器的事件丢失 |
| `compaction` | `BetaCompactionBlock` | **静默 drop** | 无 | 无 | 🚨 **MISSING** — 上下文压缩摘要文本（`content: string \| null`）丢失。这块和上面 system `compact_boundary` 组成的"为什么对话变短了"的解释完全没有 UI |

### B. `image` 和 `document` 内容块

理论上 Anthropic SDK 把 `image`/`document` 列为 `MessageParam.content`（**user-side**）的成员，不在 `BetaContentBlock`（assistant-side）里。但 Helmor 的 adapter（`blocks.rs:62-70`）在 assistant content 解析时**也匹配了** `"image"` 和 `"document"`：

- `parse_image_block`（327-351）：仅识别 `source.type ∈ {base64, url}`，**忽略**了 `file` source（`BetaFileImageSource` — `type: 'file', file_id: string`）。当模型回复包含已上传到容器的文件引用时，图像不会显示。
- `parse_document_block`（281-292）：`source.type === 'text'` 时取 `data` 字段；`base64` 或其它走 fallback "[Document attached]"。Anthropic SDK 实际定义了 `PlainTextSource` / `Base64PDFSource` / `ContentBlockSource` / `URLPDFSource` / `FilePDFSource` 多种 document source，`url` / `file` / `content` 全部走 fallback。

### C. `tool_result` 反向（user → 合并到 assistant）

`blocks.rs:160-200` 的 `extract_tool_results`：

| 接受的 content 形态 | 解析行为 |
|---|---|
| `string` | 原样作为 result |
| `[{type:"text", text}, ...]` | 用 `\n` 拼接 text 块 |
| `[{type:"image"}, ...]` | 跳过；如果数组里有 image 块，**不阻断** all_tool_result，但 image 数据被 `extract_tool_result_content` 丢弃 |
| `[{type:"file"}, ...]` | 同上，跳过 |
| `[{type:"search_result"}, ...]` | **所有非 text/image/file 类型会让 `all_tool_result = false`**，整条消息会被拒绝合并 |
| `[{type:"document"}, ...]` | 同上，会拒绝合并 |
| `[{type:"tool_reference"}, ...]` | 同上，会拒绝合并 |

后果：当工具返回包含 `search_result` 块（这是 Anthropic 原生的 search 工具返回形态）时，**整个 user 消息会被识别为"非纯 tool_result"，merge 被取消**，用户看到的是 assistant 的 tool_use 单卡片 + 一条游离的 system 消息（因为后续逻辑会把它当作未知事件渲染）。

### D. content_block_start 流式期间

`streaming.rs:79-118` 只接受 `text` / `thinking` / `tool_use` 三种 content block 开始事件；其它 12 种全部走 `_ => {}`。**流式期间 server-tool / mcp / compaction 块的开始事件被丢弃**——直到块结束，整条 assistant 消息以 `type: 'assistant'` 全帧到来后，`blocks.rs` 才有机会看到它（且这时已经进入完整解析路径，不是流式渲染）。

### E. content_block_delta 期间

`streaming.rs:121-164` 处理三种 delta：`text_delta` / `thinking_delta` / `input_json_delta`。`.d.ts` 里另外定义了：

- `citations_delta` — text block 的 citation 流式追加，**未处理**（流期间引用看不到，要等完整帧）
- `signature_delta` — thinking block 的签名追加，**未处理**（无视觉影响）
- `compaction_delta` — compaction block 内容流式追加，**未处理**

---

## 第三部分：Claude 流式开关

`sdk.d.ts:1089` 定义了 `Options.includePartialMessages` 选项，**默认 false**。Helmor 的 sidecar 在 `claude-session-manager.ts` 里没有显式开启。这意味着：

- Pipeline 的 `streaming.rs` 整套机器其实**只对设置了 `includePartialMessages: true` 的会话有用**
- 默认情况下，SDK 把每个 finalized 内容块作为独立的 `SDKAssistantMessage` 事件发出来（同 `message.id`，content 数组逐块追加），由 `accumulator/mod.rs:464-487` 的 "delta-style append" 逻辑处理。这是 helmor 实际的工作模式。
- 既然没开 partial，整个 `streaming.rs`（包括对未知 content_block 类型的 drop）只在测试 fixture 里有覆盖。**生产路径走的是 `handle_assistant`**

需要确认：sidecar 是否打算开 partial？如果不打算，可以删 streaming.rs 一半代码并对应缩减 fixture；如果打算开，需要补齐第二部分 E 列的所有 delta 类型。

---

## 第四部分：Codex SDK v0.118.0 — 顶层事件

`ThreadEvent` 联合（`dist/index.d.ts:161-162`）共 **8 个变体**。

### A. 覆盖矩阵

| `type` | SDK 类型 | Rust 处理 | 状态 |
|---|---|---|---|
| `thread.started` | `ThreadStartedEvent` | `accumulator/mod.rs:266-270` 仅更新 `session_id` | ✅ HANDLED (no-op) |
| `turn.started` | `TurnStartedEvent` | `accumulator/mod.rs:263` no-op | ✅ HANDLED (no-op) — 注释解释了原因 |
| `turn.completed` | `TurnCompletedEvent` | `accumulator/mod.rs:249-251` → `handle_turn_completed` | ✅ HANDLED — `usage.cached_input_tokens` 字段未读取，但 input/output 都读 |
| `turn.failed` | `TurnFailedEvent` | `accumulator/mod.rs:253-255` → `handle_codex_turn_failed`，重塑成 Claude `error` 形态 | ✅ HANDLED |
| `item.started` | `ItemStartedEvent` | `accumulator/mod.rs:245-247` → `handle_item_snapshot(persist=false)` | ✅ HANDLED |
| `item.updated` | `ItemUpdatedEvent` | 同上 | ✅ HANDLED |
| `item.completed` | `ItemCompletedEvent` | `accumulator/mod.rs:241-243` → `handle_item_completed` | ✅ HANDLED |
| `error` | `ThreadErrorEvent` | `accumulator/mod.rs:208-210` → `handle_error` 复用了 Claude error 路径 | ⚠️ PARTIAL — Codex 的 shape 是 `{ type:"error", message }`，但 `build_error_label` 优先取 `parsed.content`、再取 `parsed.message`，能拿到 `message`。**没问题，已处理** |

> 注意：`thread.resumed` 在 `accumulator/mod.rs:266` 也被识别，但 Codex SDK v0.118.0 的 .d.ts **没有** `thread.resumed` 事件 —— 这是 dead branch，可能是历史遗物。

### B. Codex 没有进 dispatch 的 ThreadEvent
**没有遗漏**。8 个顶层事件全部覆盖。

---

## 第五部分：Codex Item 类型（item.started/updated/completed.item）

`ThreadItem` 联合（`dist/index.d.ts:102-103`）共 **8 种**。

### A. 覆盖矩阵

| item `type` | SDK 类型 | Rust 处理（`codex.rs`） | 合成的 Claude 形态 | 历史回放（`codex_items.rs`） | 前端最终渲染 | 状态 |
|---|---|---|---|---|---|---|
| `agent_message` | `AgentMessageItem` | `codex.rs:40-60` `handle_agent_message` | `assistant.message.content = [{type:"text", text}]` | `codex_items.rs:36-51` | `AssistantText` (Streamdown) | ✅ HANDLED |
| `reasoning` | `ReasoningItem` | `codex.rs:68-70` `handle_reasoning` | `assistant.message.content = [{type:"thinking", thinking}]` | `codex_items.rs:122-140` | `Reasoning` 折叠面板 | ✅ HANDLED |
| `command_execution` | `CommandExecutionItem` | `codex.rs:88-90` `handle_command_execution` | `tool_use { name:"Bash", input:{command} }` + 后续 user tool_result | `codex_items.rs:63-103` | `AssistantToolCall` Bash 卡片 | ✅ HANDLED |
| `file_change` | `FileChangeItem` | `codex.rs:73-75` `handle_file_change` | `tool_use { name:"apply_patch", input:{changes} }` | `codex_items.rs:143-181` | 通用 ToolCall 灰圆图标（"apply_patch" 不在 `getToolInfo` 列表里！）| ⚠️ PARTIAL — Rust 合成正确，但**前端 `getToolInfo` 没有 `apply_patch` 分支**，落入 fallthrough，文件变更会显示为灰圆 + "apply_patch" 字符串，没有 add/delete/update 徽章 |
| `mcp_tool_call` | `McpToolCallItem` | `codex.rs:83-85` `handle_mcp_tool_call` | `tool_use { name:"mcp__{server}__{tool}", input:arguments }` | `codex_items.rs:209-252` | 同 fallthrough 灰圆图标 | ⚠️ PARTIAL — 前端没有 `mcp__*` 模式特化，所有 MCP 工具显示为完整工具名字符串 |
| `web_search` | `WebSearchItem` | `codex.rs:78-80` `handle_web_search` | `tool_use { name:"WebSearch", input:{query} }` | `codex_items.rs:184-206` | `AssistantToolCall` WebSearch 卡片 | ✅ HANDLED |
| `todo_list` | `TodoListItem` | `codex.rs:63-65` `handle_todo_list` | `tool_use { name:"TodoWrite", input:{todos:[...]} }` 然后被 `parse_claude_todowrite_items` 折叠成 `TodoList` part | `codex_items.rs:106-119` | `TodoList` (1616-1657) | ✅ HANDLED |
| `error` | `ErrorItem` | **`codex.rs:94-98` 走 fallthrough** → `dropped_event_types.push("error")` | — | — | — | 🚨 **DROP-GUARD FAIL** — 出现即 build 挂 |

### B. Codex item 字段缺口

| item | 未读取的字段 | 影响 |
|---|---|---|
| `command_execution` | `aggregated_output` 在 `handle_command_execution` 里其实读了，但 `status` 字段（"in_progress"/"completed"/"failed"）目前是用 `exit_code is null` 推断的——和 SDK 真值不一致时（比如"failed"但有 exit_code）会推断错 | 命令失败状态可能错标为 "running" |
| `file_change` | `changes[].kind ∈ {add, delete, update}` 已透传到 args，但前端没消费 | UI 看不出是新增还是修改 |
| `mcp_tool_call` | `result.content`（来自 `@modelcontextprotocol/sdk` 的 `ContentBlock` 联合，含 text/image/audio/resource/resource_link）整块以 JSON 字符串形式塞进 result | image/audio/resource 不会展示，只有原始 JSON |
| `web_search` | 该 item 本身就只暴露 `query`，没有 results 字段（SDK 限制）——无法改进 | — |
| `todo_list` | Codex 只有 `completed: bool`，没有 in_progress 状态。`blocks.rs:384-410` 的 `parse_codex_todolist_items` 只映射 `Completed`/`Pending`，**永远不会有 InProgress** | 与 Claude TodoWrite 的视觉一致性丢失（Codex 永远没有"正在做"的项） |

### C. 为什么 `item.completed` 会进 `convert_flat` 主循环？

这是个奇怪的设计点：`accumulator` 里把 Codex item.* 合成成 Claude 形态（`{type:"assistant", message:...}`），然后下游 adapter 直接走 Claude 路径 — 但同时 `convert_flat` 还有 `Some("item.completed")` 分支（`adapter/mod.rs:279-283`）走 `codex_items::render_item_completed`。

读了实现：**accumulator 路径**用于流式（synthesize 后 collect），**adapter 路径**用于历史回放（DB 直接存的是 raw `item.completed` JSON，没有经过 accumulator）。两条路径维护两套 item 类型→渲染的 mapping，要保持同步。

风险：增加新 item type 时**两个地方都要改**。当前两边都缺 `error` 分支，加分支时也要两边一起加。

---

## 第六部分：前端渲染层

### A. content-part 类型 → 组件

文件：`src/components/workspace-panel.tsx`，类型定义：`src/lib/api.ts:1364-1390`。

| MessagePart `type` | 类型守卫 | 渲染组件 | 行号 |
|---|---|---|---|
| `text` | `isTextPart` (2495) | `AssistantText` (memo) | 1757-1787 |
| `reasoning` | `isReasoningPart` (2501) | `Reasoning` 折叠面板 | 1481-1492 |
| `tool-call` | `isToolCallPart` (2509) | `AssistantToolCall` (memo) | 1502-1512 |
| `collapsed-group` | `isCollapsedGroupPart` (2520) | `CollapsedToolGroup` | 1494-1500 |
| `todo-list` | `isTodoListPart` (2537) | `TodoList` | 1514-1515 |
| `image` | `isImagePart` (2541) | `ImageBlock` | 1517-1518 |
| `system-notice` | `isSystemNoticePart` (2526) | 仅 system 角色 | 1554-1576 |
| `prompt-suggestion` | `isPromptSuggestionPart` (2545) | 仅 system 角色 | 1578-1600 |
| **未知** | — | **`return null` 静默丢弃** | 1520 |

注：之前的 explore 报告里说"前端不用 @assistant-ui/react"。我读了一下入口确实如此 — 路由在自己写的 `ChatThread` 里，没有 `ExternalStoreRuntime`。CLAUDE.md 里写的 assistant-ui 描述与实际代码不符，这是文档老化（值得另开 PR 修一下，但不是本审计目标）。

### B. tool 名 → 组件路由（`getToolInfo` at 2588-2731）

| tool name | 渲染细节 |
|---|---|
| `Edit` | Pencil 图标 + 文件名 + diff 计数（read `old_string`/`new_string`） |
| `Read` | FileText 图标 + 文件名（+ 行限制） |
| `Write` | FilePlus 图标 + 文件名 |
| `Bash` | Terminal 图标 + 截断命令（80 字符） |
| `Grep` | Search 图标 + pattern |
| `Glob` | FolderSearch 图标 + pattern |
| `WebFetch` | Globe 图标 + URL（截断 60） |
| `WebSearch` | Globe 图标 + query（截断 50） |
| `ToolSearch` | Search 图标 + query |
| `Agent`, `Task` | Bot 图标 + `subagent_type` 或 prompt（含 `AgentChildrenBlock` 子工具预览） |
| `Prompt` | MessageSquareText 图标（folder 进父 Task 的 children） |
| **其它** | **灰圆 + 工具名字符串**（line 2730 fallthrough） |

### C. 后果：未在 `getToolInfo` 列表里的工具会得到丑陋兜底

按 SDK shape 合成出来但前端没有专属渲染的工具：

- `apply_patch`（Codex file_change） — 应该有 patch diff UI
- `mcp__{server}__{tool}` 模式 — 应该有 MCP 服务器名前缀 + 工具名 + server icon
- Claude server tools 的内置名字（`web_search` 小写、`web_fetch`、`code_execution`、`bash_code_execution`、`text_editor_code_execution`、`tool_search_tool_regex`、`tool_search_tool_bm25`） — 这些是 `BetaServerToolUseBlock.name` 的字面量取值，前端只识别大写 `WebSearch`/`WebFetch`，所以 server-tool 调用会进 fallthrough
- 任何用户自定义的 MCP 工具

### D. content-part 静默丢弃的盲区

`workspace-panel.tsx:1520` 的 `return null` 是**安全网**而不是 bug — Rust 端理论上不应该发出未知 part type。但实际上 Rust 端的 `MessagePart` enum 通过 serde 序列化前会先经过类型系统检查，所以这个分支几乎不会被命中。

唯一可能命中的场景：`ExtendedMessagePart::Basic(MessagePart::*)` 的 type 字段被 serialize 成 camelCase 后，前端 type guard 用的字符串 typo。读了一下 `src-tauri/src/pipeline/types.rs` 的 serde 标签和 `api.ts` 的字符串 union，名字对得上。

---

## 第七部分：风险/优先级

### P0 — 立即修
1. **Codex `ErrorItem` 进 drop-guard fail**：Codex 任何 non-fatal error 出现就会让测试套件挂掉。在 `accumulator/codex.rs:94-98` 加 `"error" =>` 分支，合成成 `system` 错误通知。
2. **Claude `auth_status` / `tool_use_summary` 进 drop-guard fail**：用户 OAuth 重连或 SDK 升级时即触发。在 `accumulator/mod.rs:282` match 之前加分支。

### P1 — 重要数据丢失
3. **`mcp_tool_use` / `mcp_tool_result` / `container_upload` / `compaction` 内容块静默 drop**：MCP 用户最直接的体验回归。在 `blocks.rs:136` 之前加四个分支：
   - `mcp_tool_use` → 复用 `tool_use` 解析路径，加 `server_name` 字段；前端加 `mcp__*` pattern 路由
   - `mcp_tool_result` → 复用 `attach_server_tool_result` 但 result content 是 `string \| BetaTextBlock[]`，不是整块 JSON
   - `container_upload` → 新 `ContainerUpload` MessagePart 或合成成 `Image` part（用 file_id）
   - `compaction` → 新 `SystemNotice` "Context compacted" + body 是 content 字段
4. **`SDKAssistantMessage.error` 字段未读**：assistant turn 因 token 限制中断时用户没有任何提示。在 `accumulator/mod.rs:436` 的 `handle_assistant` 里读 `error` 字段，合成 SystemNotice 跟在 assistant 后面。
5. **`BetaMessage.stop_reason` 未透传**：`adapter/mod.rs:215` 硬编码 `"stop"`，应该透传 `pause_turn`/`refusal`/`max_tokens`/`model_context_window_exceeded` 给前端的 status 显示。

### P2 — 体验降级
6. **Claude `system` 子类型走兜底**：6 个新子类型（`compact_boundary`, `status`, `api_retry`, `hook_started/progress/response`, `session_state_changed`, `files_persisted`, `elicitation_complete`）需要对应的 `build_*_notice` 函数。`api_retry` 和 `compact_boundary` 是用户最容易感知的两个。
7. **Server-tool result 没有结构化 UI**：`web_search_tool_result` 应该渲染成链接列表，`code_execution_tool_result` 应该渲染成 stdout/stderr/exit code 三段。当前是把整块 JSON 塞进 `<pre>`。
8. **前端 `apply_patch` 没特化**：Codex 文件变更只显示灰圆。在 `getToolInfo` 加 `apply_patch` 分支。
9. **前端 `mcp__{server}__{tool}` 没有模式匹配**：在 `getToolInfo` 加 `if (toolName.startsWith("mcp__"))` 分支。

### P3 — 字段微缺口
10. `SDKResultError.errors[]`、`SDKResultSuccess.permission_denials`、`SDKResultSuccess.terminal_reason` 未在 result label 里显示
11. `SDKToolProgressMessage.elapsed_time_seconds` 未渲染（可以加到 ToolCall 卡片的右侧时间戳）
12. `SDKTaskProgressMessage.usage` 未读取（subagent 的 token/工具次数统计可以在通知 body 里展示）
13. `Usage.cached_input_tokens`（Codex turn.completed）未读取（前端 token 统计应该把 cached 单独展示）
14. `BetaTextBlock.citations` 未读取（用于显示 web search / web fetch 结果的引用链接）
15. `parse_image_block` 不识别 `BetaFileImageSource`（`type: 'file', file_id`）
16. `parse_document_block` 不识别 `url`/`file`/`content` source 类型
17. `extract_tool_results` 拒绝包含 `search_result` / `document` / `tool_reference` 块的 user 消息，整条 merge 失败

### P4 — Dead code
18. `labels.rs:117-121` 监听了 `task_completed` subtype，SDK 实际不发，是 dead branch
19. `accumulator/mod.rs:266` 监听 Codex `thread.resumed`，SDK 不发
20. `streaming.rs` 整套机器只对 `includePartialMessages: true` 有用，sidecar 默认未开 — 要么开，要么删

---

## 第八部分：附录 — 关键的源码引用一览

### Rust 入口
| 文件 | 关键行 | 作用 |
|---|---|---|
| `src-tauri/src/agents.rs` | `send_agent_message_stream` | sidecar 事件 → pipeline → IPC channel |
| `src-tauri/src/pipeline/accumulator/mod.rs:161-295` | `push_event` | 顶层 dispatch（drop-guard 在 283-294） |
| `src-tauri/src/pipeline/accumulator/streaming.rs:35-202` | `handle_stream_event` 等 | Claude content_block_* 流式 |
| `src-tauri/src/pipeline/accumulator/codex.rs:22-99` | `handle_item_snapshot` | Codex item dispatch（drop-guard 在 94-98） |
| `src-tauri/src/pipeline/adapter/mod.rs:81-320` | `convert_flat` | IntermediateMessage → ThreadMessageLike |
| `src-tauri/src/pipeline/adapter/blocks.rs:15-141` | `parse_assistant_parts` | content block → MessagePart（drop 在 136） |
| `src-tauri/src/pipeline/adapter/blocks.rs:160-271` | `extract_tool_results` 等 | user tool_result merge |
| `src-tauri/src/pipeline/adapter/labels.rs:91-153` | `build_subagent_notice`/`build_system_label` | system 子类型 → notice/label |
| `src-tauri/src/pipeline/adapter/codex_items.rs:24-252` | `render_item_completed` | 历史回放 Codex item |

### 前端入口
| 文件 | 关键行 | 作用 |
|---|---|---|
| `src/lib/api.ts:1317-1424` | type 定义 | `ThreadMessageLike` / `MessagePart` / `ExtendedMessagePart` |
| `src/components/workspace-panel.tsx:1395` | `ConversationMessage` | 按 role 路由 |
| `src/components/workspace-panel.tsx:1455-1523` | `ChatAssistantMessage` | content-part dispatch（drop 在 1520） |
| `src/components/workspace-panel.tsx:2588-2731` | `getToolInfo` | tool 名 → icon/label/detail |
| `src/components/workspace-panel.tsx:1859-2057` | `AssistantToolCall` | 通用 tool 卡片 |
| `src/components/workspace-panel.tsx:1616-1657` | `TodoList` | Plan UI |
| `src/components/workspace-panel.tsx:1602-1614` | `ImageBlock` | image 渲染 |
| `src/components/ai/reasoning.tsx` | `Reasoning` 折叠面板 | thinking 块 |
| `src/components/streamdown-components.tsx` | 表格组件 | markdown 表格 override |

### SDK 真值文件
| SDK | 关键文件 |
|---|---|
| Claude Agent SDK 顶层 | `sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (4405 行) |
| Claude content blocks | `sidecar/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` (2965 行) |
| Claude user content blocks | `sidecar/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:677,439-...` |
| Codex SDK 全部 | `sidecar/node_modules/@openai/codex-sdk/dist/index.d.ts` (273 行) |
| MCP ContentBlock（用于 Codex mcp_tool_call.result.content） | `sidecar/node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts:1918-2033,8079` |

### Drop-guard 测试
- `src-tauri/tests/pipeline_streams.rs` 断言 `accumulator.dropped_event_types().is_empty()`
- 增加新 SDK 类型而不加 dispatch 分支会让这个测试 fail，作为安全网

---

## 第九部分：建议的下一步

如果要把缺口补完，我建议按以下顺序：

1. **先修 P0 的两个 drop-guard fail**（10 行代码）：避免测试套件被一个新 SDK 事件搞挂。
2. **加 fixture 覆盖现有 dead-letter 路径**：`tests/fixtures/streams/` 里加一组 fixture，每个文件包含一种 SDK 真实发出的"未处理"事件（compaction、mcp_tool_use、auth_status、files_persisted、api_retry 各一个）。让 drop-guard 测试**先 fail 出来**，再决定每条怎么渲染。这是把"未知未知"变成"已知未知"的关键一步。
3. **再补 P1 的内容块缺口**：MCP 用户量最大，先做 mcp_tool_use/result。
4. **P2 的 system 子类型**：写一组 `build_*_notice` 函数，按 .d.ts 字段映射。
5. **P3 字段微缺口**：单独的 PR 一起做，每个改动很小。
6. **P4 dead code 清理**：跟前面任意一个 PR 合并。

这份报告本身就是 step 1 — 现在你可以决定 P0 是否当前 sprint 修，剩下的优先级你来排。
