import {
	runVoiceTool,
	type VoiceToolEnvelope,
	type VoiceToolMutationKind,
} from "@/lib/api";
import type {
	RealtimeClientEvent,
	RealtimeServerEvent,
} from "./realtime-session";

/** Names of every typed tool we declare to `gpt-realtime-2`. Keep in
 *  sync with the `ToolKind` enum in
 *  `src-tauri/src/commands/voice_agent.rs::ToolKind` — the
 *  `tool_name_set_matches_frontend_contract` Rust test will flag any
 *  drift between the two lists at build time. */
type ToolName =
	| "list_workspaces"
	| "show_workspace"
	| "create_workspace"
	| "set_workspace_status"
	| "list_sessions"
	| "send_prompt"
	| "list_repos"
	| "select_workspace"
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
	}
	const results = await Promise.all(calls.map((c) => runCall(c)));
	for (const r of results) {
		console.log("[helmor voice] tool call ←", r.callId, r.output.slice(0, 200));
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
	opts.send({ type: "response.create" });

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
