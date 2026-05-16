import {
	runVoiceTool,
	type VoiceDispatchActionKind,
	type VoiceDispatchWorkspaceAction,
	type VoiceToolEnvelope,
	type VoiceToolImage,
	type VoiceToolMutationKind,
} from "@/lib/api";
import type {
	RealtimeClientEvent,
	RealtimeServerEvent,
} from "./realtime-session";
import { voiceDiag } from "./voice-diag";

/** Tag every dispatcher event with the `dispatcher.` namespace. See
 *  `voice-diag.ts` for the rationale on echoing to Rust tracing. */
function diag(event: string, data?: Record<string, unknown>) {
	voiceDiag(`dispatcher.${event}`, data);
}

/** Names of every typed tool we declare to `gpt-realtime-2`. Keep in
 *  sync with the `ToolKind` enum in
 *  `src-tauri/src/commands/voice_agent.rs::ToolKind` — the
 *  `tool_name_set_matches_frontend_contract` Rust test will flag any
 *  drift between the two lists at build time. */
type ToolName =
	| "list_workspaces"
	| "show_workspace"
	| "create_workspace"
	| "create_workspace_and_send"
	| "create_workspace_variants"
	| "set_workspace_status"
	| "archive_workspace"
	| "permanently_delete_workspace"
	| "run_workspace_action"
	| "run_workspace_script"
	| "list_sessions"
	| "get_session_messages"
	| "send_prompt"
	| "list_repos"
	| "list_context_items"
	| "get_context_item_detail"
	| "select_workspace"
	| "capture_screen"
	| "wait_for_user"
	| "end_session";

/** Re-export of the Rust-side mutation kind enum. Kept as a TS type
 *  alias rather than its own union so they can't drift independently. */
export type AgentMutationKind = VoiceToolMutationKind;

/** Tracked per call_id as deltas stream in. */
type PendingCall = {
	callId: string;
	name: string;
	argsBuffer: string;
};

type DispatcherOptions = {
	/** Forward client events back to the model over the data channel. */
	send: (event: RealtimeClientEvent) => void;
	/** Called once per turn (after all parallel tools resolved) with the
	 *  union of cache-mutation kinds the tools emitted. The host should
	 *  map these to React Query invalidations so the GUI picks up the
	 *  effects of in-process tool runs. */
	onMutation?: (kinds: AgentMutationKind[]) => void;
	/** Drive UI workspace selection on behalf of the voice agent.
	 *  Called with a resolved workspace UUID after:
	 *  - the model explicitly calls `select_workspace`
	 *  - `create_workspace` finishes (auto-follow to the new workspace)
	 *  - `send_prompt` finishes (auto-follow to the target workspace
	 *    so the user sees the agent's reply stream in real time)
	 *
	 *  The Rust handler guarantees the id is non-empty and the tool
	 *  reported success — the host doesn't need defensive checks. */
	onNavigateToWorkspace?: (workspaceId: string) => void;
	/** Close the voice-mode session. Fires when the agent invokes the
	 *  synthetic `end_session` tool — i.e. the user verbally signaled
	 *  they're done ("that's all" / "拜拜"). The dispatcher gives the
	 *  audio buffer a beat to flush before invoking this so the model's
	 *  goodbye reply isn't cut off mid-word. Caller should flip
	 *  `voiceModeStore.setActive(false)`. */
	onEndSession?: () => void;
	/** Route an agent-dispatched ship-flow action through the same
	 *  frontend handler the GUI commit buttons use. Fires after a
	 *  `run_workspace_action` call resolves with one of the four
	 *  agent-dispatched action kinds (`commit-and-push` / `create-pr` /
	 *  `fix` / `resolve-conflicts`). The host should call the matching
	 *  `handleInspectorCommitAction` / equivalent so the canned prompts +
	 *  post-stream verifier + auto-close behavior stay identical
	 *  between voice and click flows. Direct actions (`merge_pr` /
	 *  `pull_latest`) are executed inline by the Rust handler and do
	 *  NOT fire this callback. */
	onDispatchWorkspaceAction?: (
		workspaceId: string,
		actionKind: VoiceDispatchActionKind,
	) => void;
};

export type ToolDispatcher = {
	/** Hand every server event from `RealtimeVoiceSession.onEvent` to
	 *  this. Returns synchronously; tool execution happens in the
	 *  background. */
	handleEvent: (event: RealtimeServerEvent) => void;
	/** Drop all pending state. Call on session teardown. */
	reset: () => void;
};

/** Build a dispatcher tied to a live Realtime session. Watches the
 *  event stream for function-call deltas, runs the corresponding
 *  in-process Tauri command (`run_voice_tool`) on `response.done`, and
 *  posts `function_call_output` items + a fresh `response.create` back. */
export function createToolDispatcher(opts: DispatcherOptions): ToolDispatcher {
	const pendingByCallId = new Map<string, PendingCall>();
	const callsByResponseId = new Map<string, string[]>();

	function reset() {
		pendingByCallId.clear();
		callsByResponseId.clear();
	}

	function handleEvent(event: RealtimeServerEvent) {
		const eventType = event.type;
		if (!eventType) return;

		// Targeted server-side echo. We *don't* echo every event type
		// (transcript deltas alone fire ~30 times per second and would
		// flood the log) — only the lifecycle signals that answer
		// "what did the server actually do after we sent
		// response.create?" The `error` echo carries the full payload
		// because that's the only place the model + server gives us a
		// human-readable reason for a silent rejection (e.g. image
		// content rejected, model doesn't accept input_image, payload
		// too large).
		if (eventType === "error") {
			diag("server-error", { event });
		} else if (
			eventType === "response.created" ||
			eventType === "response.done" ||
			eventType === "conversation.item.created" ||
			eventType === "response.cancelled" ||
			eventType === "rate_limits.updated"
		) {
			// Strip noisy nested fields — for `response.done` the
			// `response.output` blob can be megabytes if it contains
			// audio. Just record the type and a status/id-ish summary.
			const responseStatus = (
				event as {
					response?: {
						id?: string;
						status?: string;
						status_details?: {
							error?: { message?: string; code?: string; type?: string };
							reason?: string;
						};
					};
				}
			).response;
			const item = (
				event as { item?: { id?: string; type?: string; role?: string } }
			).item;
			diag("server-event", {
				type: eventType,
				responseId: responseStatus?.id ?? null,
				responseStatus: responseStatus?.status ?? null,
				responseError:
					responseStatus?.status_details?.error?.message ??
					responseStatus?.status_details?.reason ??
					null,
				responseErrorCode: responseStatus?.status_details?.error?.code ?? null,
				responseErrorType: responseStatus?.status_details?.error?.type ?? null,
				itemId: item?.id ?? null,
				itemType: item?.type ?? null,
				itemRole: item?.role ?? null,
			});
		}

		// Track new function_call items as they appear, by both call_id
		// (for accumulating argument deltas) and response_id (so we
		// know which to run when the response finishes).
		if (eventType === "response.output_item.added") {
			const responseId = (event as { response_id?: string }).response_id;
			const item = (
				event as {
					item?: { type?: string; name?: string; call_id?: string };
				}
			).item;
			if (item?.type === "function_call" && item.call_id && item.name) {
				pendingByCallId.set(item.call_id, {
					callId: item.call_id,
					name: item.name,
					argsBuffer: "",
				});
				if (responseId) {
					const list = callsByResponseId.get(responseId) ?? [];
					list.push(item.call_id);
					callsByResponseId.set(responseId, list);
				}
			}
			return;
		}

		if (eventType === "response.function_call_arguments.delta") {
			const callId = (event as { call_id?: string }).call_id;
			const delta = (event as { delta?: string }).delta ?? "";
			if (!callId) return;
			const pending = pendingByCallId.get(callId);
			if (pending) {
				pending.argsBuffer += delta;
			}
			return;
		}

		if (eventType === "response.function_call_arguments.done") {
			const callId = (event as { call_id?: string }).call_id;
			const arguments_ = (event as { arguments?: string }).arguments;
			if (!callId) return;
			const pending = pendingByCallId.get(callId);
			if (pending && typeof arguments_ === "string") {
				// `.done` carries the canonical full arguments string;
				// prefer it over the accumulated deltas (handles cases
				// where a delta was missed or reordered).
				pending.argsBuffer = arguments_;
			}
			return;
		}

		if (eventType === "response.done") {
			const response = (
				event as {
					response?: { id?: string; status?: string };
				}
			).response;
			const responseId = response?.id;
			if (!responseId) return;
			const callIds = callsByResponseId.get(responseId);
			callsByResponseId.delete(responseId);
			if (!callIds || callIds.length === 0) return;
			// `response.done` also fires for cancelled / failed responses.
			// Only execute tools for completed responses; for everything
			// else, drop the pending state so we don't run stale calls.
			if (response?.status !== "completed") {
				console.warn(
					"[helmor voice] dropping",
					callIds.length,
					"tool call(s) — response status was",
					response?.status,
				);
				for (const callId of callIds) pendingByCallId.delete(callId);
				return;
			}
			const calls = callIds
				.map((id) => pendingByCallId.get(id))
				.filter((c): c is PendingCall => c !== undefined);
			for (const callId of callIds) pendingByCallId.delete(callId);
			if (calls.length === 0) return;
			// Fire-and-forget — execution races forward off the event
			// loop. Errors are caught inside `executeCalls` so a single
			// bad tool can't abort the whole response.
			void executeCalls(calls, opts);
			return;
		}
	}

	return { handleEvent, reset };
}

/** Run every function_call collected from one `response.done`, in
 *  parallel, then submit outputs + a single `response.create` to nudge
 *  the model into speaking the answer. */
async function executeCalls(calls: PendingCall[], opts: DispatcherOptions) {
	for (const c of calls) {
		console.log(
			"[helmor voice] tool call →",
			c.name,
			c.argsBuffer || "(no args)",
		);
		// Echo to Rust tracing so voice-panel webview invocations
		// (which can't surface a devtools console) still leave a
		// trail. argsBuffer can be JSON — keep it as a string to
		// avoid double-encoding gotchas.
		diag("tool-call-start", {
			name: c.name,
			args: c.argsBuffer || null,
			callId: c.callId,
		});
	}
	const results = await Promise.all(calls.map((c) => runCall(c)));
	for (const r of results) {
		console.log("[helmor voice] tool call ←", r.callId, r.output.slice(0, 200));
		// Slim summary — log the truncated output (matches the
		// console line) plus the `image` envelope side-channel
		// presence, which is the bit operators are usually grepping
		// for when triaging `capture_screen`. Keep the data_url out
		// of the log; the Rust side already records its byte count.
		diag("tool-call-end", {
			callId: r.callId,
			outputPreview: r.output.slice(0, 200),
			hasImage: r.image != null,
			imageMeta: r.image
				? { width: r.image.width, height: r.image.height }
				: null,
			navigateToWorkspaceId: r.navigateToWorkspaceId ?? null,
			dispatchActionKind: r.dispatchWorkspaceAction?.actionKind ?? null,
			endSession: r.endSession === true,
		});
	}
	// Submit outputs sequentially — community reports race quirks if
	// multiple `conversation.item.create` events race over the data
	// channel. Then a single `response.create` re-enters speech.
	for (const r of results) {
		opts.send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: r.callId,
				output: r.output,
			},
		});
	}
	// `capture_screen` tools attach a JPEG via `image`. The Realtime
	// API rejects non-string `function_call_output.output`, so the
	// actual frame has to ride a separate `conversation.item.create`
	// with role `user` and content `[input_text, input_image]`. We
	// append these AFTER all `function_call_output`s and BEFORE the
	// single `response.create` — the model only sees the image when
	// the next response starts. Order across multiple captures in one
	// turn is preserved so the model can correlate them with their
	// announcements (rare but possible: model called `capture_screen`
	// twice in one response). gpt-realtime-2 supports `input_image`
	// via `image_url`; older 4o-realtime-preview snapshots do not —
	// the tool is gated off by `build_tools_array` per model anyway.
	//
	// We use an inline `data:image/jpeg;base64,…` URL rather than a
	// Files API `file_id` because the Realtime API server-side
	// validator rejects `input_image` items that omit `image_url`,
	// even when `file_id` is set (verified live: `Missing required
	// parameter: 'item.content[*].image_url'`). The Rust capture path
	// keeps the payload small enough to fit the WebRTC dataChannel's
	// SCTP size ceiling — see screen_capture.rs for the downscale +
	// JPEG quality knobs, and
	// github.com/openai/openai-agents-js/issues/501 for the
	// dataChannel ceiling itself.
	for (const r of results) {
		if (!r.image) continue;
		console.log(
			"[helmor voice] inject input_image",
			r.callId,
			`${r.image.width}x${r.image.height}`,
			`${r.image.dataUrl.length}B`,
		);
		diag("inject-input-image", {
			callId: r.callId,
			width: r.image.width,
			height: r.image.height,
			dataUrlBytes: r.image.dataUrl.length,
			caption: r.image.caption,
		});
		opts.send({
			type: "conversation.item.create",
			item: {
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: r.image.caption },
					{ type: "input_image", image_url: r.image.dataUrl },
				],
			},
		});
	}
	// `end_session` is a synthetic UI-only signal — the model already
	// spoke its goodbye before invoking it, and the session is about to
	// be torn down. Sending `response.create` would prompt the model to
	// generate *another* turn (which we observed as "拜拜" being
	// spoken twice — see voice-panel phase log around the
	// speaking → acting → speaking → listening replay). Skip the
	// nudge whenever any call in this batch ended the session.
	const isEndSessionBatch = results.some((r) => r.endSession);
	if (!isEndSessionBatch) {
		diag("response-create", {
			callCount: results.length,
			imageCount: results.filter((r) => r.image != null).length,
		});
		opts.send({ type: "response.create" });
	} else {
		diag("response-create-skipped", { reason: "end_session" });
	}

	// Aggregate mutation kinds across this turn and notify the host
	// once. The Set keeps the callback idempotent when multiple write
	// tools fired in parallel (e.g. create + set-status of the same
	// workspace).
	if (opts.onMutation) {
		const kinds = new Set<AgentMutationKind>();
		for (const r of results) {
			for (const kind of r.invalidates) kinds.add(kind);
		}
		if (kinds.size > 0) opts.onMutation(Array.from(kinds));
	}

	// Fire UI navigation. Last-writer-wins: if a turn somehow chained
	// multiple workspace-touching tools (rare — the prompt steers the
	// model away from this), navigate to the most recent one so the
	// user lands where the last action happened.
	if (opts.onNavigateToWorkspace) {
		for (let i = results.length - 1; i >= 0; i--) {
			const id = results[i]?.navigateToWorkspaceId;
			if (id) {
				opts.onNavigateToWorkspace(id);
				break;
			}
		}
	}

	// Fire workspace-action dispatch for any agent-dispatched action
	// (`commit-and-push` / `create-pr` / `fix` / `resolve-conflicts`).
	// Order-preserving: if the model somehow batched multiple actions,
	// run them in the order they arrived. Direct actions (merge / pull)
	// don't surface this signal — they're already done by the time the
	// envelope returns.
	if (opts.onDispatchWorkspaceAction) {
		for (const r of results) {
			const dispatch = r.dispatchWorkspaceAction;
			if (dispatch) {
				opts.onDispatchWorkspaceAction(
					dispatch.workspaceId,
					dispatch.actionKind,
				);
			}
		}
	}

	// `end_session`: the user verbally said goodbye and the model
	// called the synthetic tool. `response.done` has already fired by
	// the time we're here, which means the server is done streaming
	// audio — but the audio frames buffered on the client side are
	// still playing out. Closing WebRTC immediately would clip the
	// last word or two of the goodbye reply. Wait for the buffer to
	// drain before tearing down. The 1500ms window matches the typical
	// length of a short sign-off ("see ya." / "好的拜拜。") with some
	// slack for jitter; longer goodbyes are the model's problem.
	if (opts.onEndSession && results.some((r) => r.endSession)) {
		const endSession = opts.onEndSession;
		setTimeout(endSession, 1500);
	}
}

type RunCallResult = {
	callId: string;
	output: string;
	invalidates: AgentMutationKind[];
	navigateToWorkspaceId?: string;
	/** Flag set by the `end_session` short-circuit so `executeCalls`
	 *  knows to fire `onEndSession` after the audio buffer flushes. */
	endSession?: boolean;
	/** Set when the Rust handler asks the frontend to route a ship-flow
	 *  action through the GUI commit-button path. */
	dispatchWorkspaceAction?: VoiceDispatchWorkspaceAction;
	/** Set by `capture_screen` to deliver a screenshot back into the
	 *  Realtime conversation. The dispatcher injects this as an
	 *  `input_image` user item between the `function_call_output` and
	 *  the follow-up `response.create` — the Realtime API rejects
	 *  non-string `function_call_output.output`, so binary frames have
	 *  to ride a separate conversation item. */
	image?: VoiceToolImage;
};

/** Empty-success result for `wait_for_user` and front-end short-circuits. */
function silentResult(
	callId: string,
	extra?: Partial<RunCallResult>,
): RunCallResult {
	return {
		callId,
		output: JSON.stringify({ ok: true }),
		invalidates: [],
		...extra,
	};
}

/** Run one tool call by invoking the in-process Tauri command. Errors
 *  are wrapped in an envelope and forwarded to the model rather than
 *  thrown — a single bad tool shouldn't abort the whole turn. */
async function runCall(call: PendingCall): Promise<RunCallResult> {
	// wait_for_user is intentionally a no-op: it tells the model not
	// to speak, and there's nothing to actually run. Short-circuit on
	// the client side to avoid a round-trip for the most-frequent
	// "agent has nothing to say" case.
	if (call.name === "wait_for_user") {
		return silentResult(call.callId);
	}
	// end_session is a UI-only signal: tear down the voice session.
	// Short-circuit (no IPC) but mark the result so `executeCalls`
	// fires the host's `onEndSession` callback after the audio buffer
	// has had a chance to flush — calling it immediately would clip
	// the model's goodbye reply.
	if (call.name === "end_session") {
		return silentResult(call.callId, { endSession: true });
	}

	const args = parseArgs(call.argsBuffer);

	let envelope: VoiceToolEnvelope;
	try {
		envelope = await runVoiceTool(call.name, args);
	} catch (err) {
		// The Rust command wraps handler errors in `ok: false`
		// envelopes, so an exception here is an IPC / serialization
		// failure rather than a handler problem.
		return {
			callId: call.callId,
			output: JSON.stringify({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}),
			invalidates: [],
		};
	}

	const output = JSON.stringify(
		envelope.ok
			? { ok: true, data: envelope.data }
			: { ok: false, error: envelope.error ?? "voice tool failed" },
	);

	return {
		callId: call.callId,
		output,
		invalidates: envelope.invalidates,
		navigateToWorkspaceId: envelope.navigateToWorkspaceId ?? undefined,
		dispatchWorkspaceAction: envelope.dispatchWorkspaceAction ?? undefined,
		image: envelope.image ?? undefined,
	};
}

function parseArgs(buffer: string): Record<string, unknown> {
	if (!buffer.trim()) return {};
	try {
		const parsed = JSON.parse(buffer);
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

// Re-export ToolName for any (future) caller that wants a typed
// reference to the registered tool set — the dispatcher itself accepts
// arbitrary strings (the Rust side validates).
export type { ToolName };
