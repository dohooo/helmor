import {
	abortPlannerTurn,
	type PlannerEvent,
	runVoiceTool,
	startPlannerTurn,
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
 *  drift between the two lists at build time.
 *
 *  Executor meta tools handle external MCP sources. Helmor native
 *  tools run directly in-process through Rust typed handlers.
 */
// Reception-only tool surface. Worker-side tools never appear here —
// they're invoked through the planner agent loop in Rust, not through
// rt's WebRTC dataChannel. Keep in sync with
// `voice_agent::is_reception_tool` in `src-tauri/`.
type ToolName = "ask_planner" | "wait_for_user";

/** Re-export of the Rust-side mutation kind enum. Kept as a TS type
 *  alias rather than its own union so they can't drift independently. */
export type AgentMutationKind = VoiceToolMutationKind;

const MIN_RESPONSE_CREATE_REMAINING_TOKENS = 5_000;
const MAX_RATE_LIMIT_WAIT_MS = 15_000;

// ─── Say queue — Reception's "voice these lines verbatim" mechanism ──
// Populated by `handlePlannerEvent` as the Worker emits `say` / `final`
// events. Drained one item per rt `response.done` so each gets its own
// audio response, and eagerly pumped when the Worker sends a fresh Say
// while rt is idle. Cleared on user interruption, response cancel, or
// dispatcher reset. (Same mechanism that validated Phase-0; the PoC
// harness has since been removed but the queue stays as planner
// infrastructure.)
function buildSayInstruction(line: string): string {
	return `Speak exactly this single short line in a natural voice, then stop. Do not add anything before or after it: "${line}"`;
}

/** Map a planner-side Helmor tool name to a short Chinese verb phrase
 *  for the voice bar. Falls back to the raw name when the tool isn't
 *  listed — humanise new tools here as the Worker catalog grows. */
function humanizePlannerTool(name: string): string {
	switch (name) {
		case "list_workspaces":
			return "查看 workspace";
		case "show_workspace":
			return "查看 workspace";
		case "list_repos":
			return "查看仓库";
		case "list_sessions":
			return "查 session";
		case "search_sessions":
			return "搜 session";
		case "get_session_messages":
			return "读 session 消息";
		case "create_workspace":
		case "create_workspace_and_send":
		case "create_workspace_variants":
			return "创建 workspace";
		case "set_workspace_status":
			return "更新状态";
		case "archive_workspace":
			return "归档 workspace";
		case "permanently_delete_workspace":
			return "删除 workspace";
		case "run_workspace_action":
			return "运行操作";
		case "run_workspace_script":
			return "运行脚本";
		case "send_prompt":
			return "派发任务";
		case "stop_session":
			return "停止 session";
		case "select_workspace":
			return "切换 workspace";
		case "search_mcp_tools":
			return "搜索外部工具";
		case "describe_mcp_tool":
			return "查工具参数";
		case "call_mcp_tool":
			return "调用外部工具";
		case "approve_mcp_call":
			return "批准外部调用";
		case "capture_screen":
			return "看屏幕";
		case "end_session":
			return "准备结束";
		default:
			return name;
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type TokenBudget = {
	remaining: number;
	resetAtMs: number;
	resetSeconds: number;
};

function readTokenBudget(event: RealtimeServerEvent): TokenBudget | null {
	const limits = event.rate_limits;
	if (!Array.isArray(limits)) {
		return null;
	}
	const tokenLimit = limits.find((limit) => {
		return (
			limit != null &&
			typeof limit === "object" &&
			(limit as Record<string, unknown>).name === "tokens"
		);
	}) as Record<string, unknown> | undefined;
	if (!tokenLimit) {
		return null;
	}
	const remaining = tokenLimit.remaining;
	const resetSeconds = tokenLimit.reset_seconds;
	if (typeof remaining !== "number" || typeof resetSeconds !== "number") {
		return null;
	}
	return {
		remaining,
		resetAtMs: Date.now() + resetSeconds * 1000,
		resetSeconds,
	};
}

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
	/** Push a status label onto the voice bar. Called when the Worker
	 *  starts/finishes a Helmor tool, or explicitly via the planner's
	 *  `show_status(text)` tool. `null` clears the label and lets the
	 *  bar drop back to its default "listening" / "speaking" state.
	 *  Implementation lives in `use-realtime-sequence.ts`. */
	onPlannerStatus?: (label: string | null) => void;
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
	let tokenBudget: TokenBudget | null = null;
	let disposed = false;
	// Say queue — shared mechanism between the Phase-0 PoC harness and
	// the Phase-1 planner integration. Items are drained one per
	// `response.done`, or eagerly when a planner Say arrives while no
	// response is in flight. Cleared on user interruption, response
	// cancel, or dispatcher reset.
	let pocQueue: string[] = [];
	let pocActive = false;
	// Planner state. `activePlannerTurnId` is set when we kick off a
	// planner turn via `ask_planner`; cleared on `Done` / `Error` or on
	// abort. Used so user interruption can cancel the in-flight GPT-5
	// stream rather than just clearing already-emitted say events.
	let activePlannerTurnId: string | null = null;
	// `responseInFlight` mirrors the server-side "one active response at
	// a time" invariant. Planner events arriving while a response is
	// already playing get queued; when the queue is drained and rt is
	// idle, the next Say fires immediately rather than waiting for the
	// next organic response.done.
	let responseInFlight = false;
	// `pendingEndSession` is set when the Worker invokes `end_session`.
	// We defer actually tearing down the WebRTC session until the say
	// queue has fully drained — that way the goodbye line voiced via
	// `final` finishes playing before we close the channel.
	let pendingEndSession = false;

	function reset() {
		disposed = true;
		pendingByCallId.clear();
		callsByResponseId.clear();
		tokenBudget = null;
		pocQueue = [];
		pocActive = false;
		pendingEndSession = false;
		if (activePlannerTurnId) {
			void abortPlannerTurn(activePlannerTurnId).catch(() => {});
			activePlannerTurnId = null;
		}
		responseInFlight = false;
		opts.onPlannerStatus?.(null);
	}

	function clearPocQueue(reason: string) {
		if (pocQueue.length === 0 && !pocActive && activePlannerTurnId === null) {
			return;
		}
		diag("poc-queue-cleared", {
			reason,
			remaining: pocQueue.length,
			hadActivePlanner: activePlannerTurnId !== null,
			cancelledPendingEnd: pendingEndSession,
		});
		pocQueue = [];
		pocActive = false;
		// Drop the deferred teardown — the user interrupted before the
		// goodbye finished, so they probably want to keep talking.
		pendingEndSession = false;
		// Clear voice-bar status — user is taking over, no more
		// "thinking…" badge.
		opts.onPlannerStatus?.(null);
		// If a planner turn is still in flight, abort it so the Worker
		// stops emitting more say/final events into a queue we just
		// emptied.
		if (activePlannerTurnId) {
			const turnId = activePlannerTurnId;
			activePlannerTurnId = null;
			void abortPlannerTurn(turnId).catch((e) =>
				diag("planner-abort-failed", { turnId, error: String(e) }),
			);
		}
	}

	function pumpPocQueue() {
		if (disposed) return;
		if (pocQueue.length === 0) {
			if (pocActive && activePlannerTurnId === null) {
				// Queue drained AND no planner is still streaming — safe
				// to flip pocActive off. If a planner is active we keep
				// the flag so a late Say still fires through the same
				// "pump on response.done" path.
				diag("poc-queue-drained", {});
				pocActive = false;
				// Worker requested session teardown: now that the goodbye
				// line has been voiced and the queue is empty, ask rt to
				// close. The 1500ms delay matches the rt-side end_session
				// path and lets the audio buffer flush.
				if (pendingEndSession) {
					const fireEnd = opts.onEndSession;
					pendingEndSession = false;
					if (fireEnd) {
						diag("end-session-scheduled", { delayMs: 1500 });
						setTimeout(fireEnd, 1500);
					}
				}
			}
			return;
		}
		const line = pocQueue.shift() as string;
		// Diagnostic note: idx is 1-based for the PoC harness (5 fixed
		// lines), but for planner-sourced lines we don't know the total
		// count up front, so just report queue position.
		diag("poc-inject", { line, remaining: pocQueue.length });
		// Optimistic flag — set before send so a fresh Say arriving
		// before we see `response.created` won't double-fire.
		responseInFlight = true;
		opts.send({
			type: "response.create",
			response: {
				output_modalities: ["audio"],
				instructions: buildSayInstruction(line),
				// `metadata` rides through `response.done` unchanged so we
				// can tell PoC/planner-driven responses apart from organic
				// ones in the diag stream. Useful when correlating timing.
				metadata: {
					kind: activePlannerTurnId ? "planner-say" : "poc-filler",
				},
			},
		});
	}

	function pumpIfIdle() {
		if (disposed || pocQueue.length === 0 || responseInFlight) return;
		pumpPocQueue();
	}

	function handlePlannerEvent(event: PlannerEvent) {
		if (disposed) return;
		switch (event.kind) {
			case "started":
				diag("planner-started", { turnId: event.turnId });
				break;
			case "say":
				diag("planner-say-received", {
					turnId: event.turnId,
					text: event.text,
				});
				if (activePlannerTurnId !== event.turnId) {
					// Stale event from a turn we already aborted — ignore.
					return;
				}
				pocQueue.push(event.text);
				pumpIfIdle();
				break;
			case "final":
				diag("planner-final-received", {
					turnId: event.turnId,
					text: event.text,
				});
				if (activePlannerTurnId !== event.turnId) return;
				// Clear voice-bar status — the final answer is about to
				// be voiced and the bar transitions to "speaking" on its
				// own once rt's response.created fires.
				opts.onPlannerStatus?.(null);
				pocQueue.push(event.text);
				pumpIfIdle();
				break;
			case "status":
				diag("planner-status", { turnId: event.turnId, note: event.note });
				// Worker's explicit `show_status(text)` call. Surfaced on
				// the voice bar so the user sees what the assistant is
				// doing without having to be told.
				if (activePlannerTurnId === event.turnId && event.note?.trim()) {
					opts.onPlannerStatus?.(event.note.trim());
				}
				break;
			case "error":
				diag("planner-error", {
					turnId: event.turnId,
					message: event.message,
				});
				if (activePlannerTurnId === event.turnId) {
					opts.onPlannerStatus?.(null);
					// Bubble a short user-facing line so rt says something
					// instead of just going silent.
					pocQueue.push("嗯,刚才走神了,你再说一遍?");
					pumpIfIdle();
				}
				break;
			case "done":
				diag("planner-done", { turnId: event.turnId });
				if (activePlannerTurnId === event.turnId) {
					activePlannerTurnId = null;
					opts.onPlannerStatus?.(null);
				}
				break;
			case "toolCallStarted":
				diag("planner-tool-started", {
					turnId: event.turnId,
					callId: event.callId,
					name: event.name,
					argsPreview: event.argsPreview,
				});
				// Surface tool activity on the voice bar — the user sees
				// what the assistant is doing in real time. Falls back to
				// the raw name if the tool isn't in the humanised list.
				if (activePlannerTurnId === event.turnId) {
					opts.onPlannerStatus?.(humanizePlannerTool(event.name));
				}
				break;
			case "toolCallCompleted":
				diag("planner-tool-completed", {
					turnId: event.turnId,
					callId: event.callId,
					name: event.name,
					ok: event.ok,
					durationMs: event.durationMs,
					resultPreview: event.resultPreview,
				});
				break;
			case "invalidate":
				diag("planner-invalidate", {
					turnId: event.turnId,
					kinds: event.kinds,
				});
				if (activePlannerTurnId === event.turnId && opts.onMutation) {
					// Mirror the per-turn mutation aggregator the rt path
					// uses. Cast through the union — Rust serialises
					// `MutationKind` as camelCase strings (workspaces /
					// sessions) which match `VoiceToolMutationKind`.
					opts.onMutation(event.kinds as AgentMutationKind[]);
				}
				break;
			case "navigateToWorkspace":
				diag("planner-navigate", {
					turnId: event.turnId,
					workspaceId: event.workspaceId,
				});
				if (
					activePlannerTurnId === event.turnId &&
					opts.onNavigateToWorkspace
				) {
					opts.onNavigateToWorkspace(event.workspaceId);
				}
				break;
			case "endSession":
				diag("planner-end-session", { turnId: event.turnId });
				if (activePlannerTurnId === event.turnId) {
					// Mark for teardown — actual `onEndSession` call fires
					// AFTER the final say/final has been voiced. We piggy-
					// back on the queue-drained transition so the audio
					// buffer has a chance to flush.
					pendingEndSession = true;
				}
				break;
			case "captureImage":
				diag("planner-capture-image", {
					turnId: event.turnId,
					width: event.width,
					height: event.height,
					captionPreview: event.caption.slice(0, 80),
					dataUrlBytes: event.dataUrl.length,
				});
				if (activePlannerTurnId !== event.turnId) return;
				// Forward the image into rt's conversation as an
				// `input_image` user message. Reception (gpt-realtime-2)
				// is multimodal and will reference it on its next
				// response; Worker only got the text caption back so
				// it can't reason about pixels, but Reception can.
				opts.send({
					type: "conversation.item.create",
					item: {
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: event.caption },
							{ type: "input_image", image_url: event.dataUrl },
						],
					},
				});
				break;
		}
	}

	function kickoffPlannerTurn(transcript: string) {
		// If a previous planner turn is still running, abort it before
		// starting the new one — the user wouldn't expect two parallel
		// agents speaking through the same voice.
		if (activePlannerTurnId) {
			const stale = activePlannerTurnId;
			diag("planner-superseded", { previous: stale });
			void abortPlannerTurn(stale).catch(() => {});
		}
		pocActive = true;
		pocQueue = [];
		// Show "thinking" on the voice bar immediately so the user has
		// visual feedback during the 1–3 s before the Worker emits its
		// first say/final or tool call. Replaces the old verbal "我看看"
		// ack — quieter, less repetitive.
		opts.onPlannerStatus?.("思考中…");
		startPlannerTurn(transcript, handlePlannerEvent)
			.then((accepted) => {
				if (disposed) {
					void abortPlannerTurn(accepted.turnId).catch(() => {});
					return;
				}
				activePlannerTurnId = accepted.turnId;
				diag("planner-turn-accepted", { turnId: accepted.turnId });
			})
			.catch((err) => {
				diag("planner-turn-start-failed", { error: String(err) });
				opts.onPlannerStatus?.(null);
				pocQueue.push("嗯,刚才走神了,你再说一遍?");
				pumpIfIdle();
			});
	}

	function responseCreateDelayMs() {
		if (
			!tokenBudget ||
			tokenBudget.remaining >= MIN_RESPONSE_CREATE_REMAINING_TOKENS
		) {
			return 0;
		}
		return Math.min(
			Math.max(0, tokenBudget.resetAtMs - Date.now()) + 500,
			MAX_RATE_LIMIT_WAIT_MS,
		);
	}

	function handleEvent(event: RealtimeServerEvent) {
		const eventType = event.type;
		if (!eventType) return;
		if (eventType === "rate_limits.updated") {
			tokenBudget = readTokenBudget(event) ?? tokenBudget;
		}

		// Track response lifecycle so the planner-side `pumpIfIdle` can
		// know whether the data channel is free for a fresh response.
		if (eventType === "response.created") {
			responseInFlight = true;
		} else if (
			eventType === "response.done" ||
			eventType === "response.cancelled"
		) {
			responseInFlight = false;
		}

		// PoC / planner interruption: user started speaking — drain the
		// queue AND abort the in-flight planner turn so rt can react to
		// them instead of plowing through filler lines or playing a
		// stale answer.
		if (
			eventType === "input_audio_buffer.speech_started" &&
			(pocActive || activePlannerTurnId !== null)
		) {
			clearPocQueue("user-speech-started");
		}
		// Server force-cancel: bail on the rest of the queue — sending
		// more `response.create` events into a cancelled state usually
		// races with the server-side teardown.
		if (
			eventType === "response.cancelled" &&
			(pocActive || activePlannerTurnId !== null)
		) {
			clearPocQueue("response-cancelled");
		}

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
			if (!callIds || callIds.length === 0) {
				// No tool calls on this response — it was either an
				// organic rt utterance or a PoC-driven filler completing.
				// Either way, if the PoC queue still has items, this is
				// our cue to fire the next one. `pumpPocQueue` is a no-op
				// when the queue is empty / inactive.
				pumpPocQueue();
				return;
			}
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
			void executeCalls(calls, opts, responseCreateDelayMs, () => disposed, {
				onAskPlanner: (transcript) => {
					// Planner batch entry: fire-and-forget the start RPC.
					// `kickoffPlannerTurn` resolves the turn id and wires
					// the event channel; subsequent planner Say / Final
					// events land back here via `handlePlannerEvent` and
					// feed the say queue for rt to voice.
					if (!transcript?.trim()) {
						diag("planner-skip", { reason: "empty-transcript" });
						return;
					}
					diag("planner-armed", { transcriptChars: transcript.length });
					kickoffPlannerTurn(transcript);
				},
			});
			return;
		}
	}

	return { handleEvent, reset };
}

/** Run every function_call collected from one `response.done`, in
 *  parallel, then submit outputs + a single `response.create` to nudge
 *  the model into speaking the answer. */
type ExecuteCallsHooks = {
	/** Called when the batch contains `ask_planner`, with the parsed
	 *  transcript argument. Lets the dispatcher closure kick off the
	 *  Worker stream while rt voices its short ack. */
	onAskPlanner?: (transcript: string) => void;
};

async function executeCalls(
	calls: PendingCall[],
	opts: DispatcherOptions,
	getResponseCreateDelayMs?: () => number,
	isDisposed?: () => boolean,
	hooks?: ExecuteCallsHooks,
) {
	// Detect ask_planner, extract the transcript arg, and signal the
	// dispatcher closure to start the Worker turn. Other tool calls are
	// handled inline below via `runVoiceTool`.
	const askPlannerCall = calls.find((c) => c.name === "ask_planner");
	if (askPlannerCall && hooks?.onAskPlanner) {
		const parsed = parseArgs(askPlannerCall.argsBuffer);
		const transcript =
			typeof parsed.transcript === "string" ? parsed.transcript : "";
		hooks.onAskPlanner(transcript);
	}
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
	if (isDisposed?.()) {
		diag("tool-results-discarded", {
			callCount: calls.length,
			reason: "dispatcher-reset",
		});
		return;
	}
	for (const r of results) {
		console.log("[helmor voice] tool call ←", r.callId, r.output);
		diag("tool-call-end", {
			callId: r.callId,
			output: r.output,
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
	// `ask_planner` also skips the response.create. We DON'T want rt
	// to voice an audible ack ("我看看") — the voice bar already shows
	// "思考中…" as visual feedback, and the Worker's first `say`/`final`
	// will trigger its own response.create via the say queue. Speaking
	// the ack here just adds a repetitive verbal tic on every turn.
	const isAskPlannerBatch = calls.some((c) => c.name === "ask_planner");
	if (!isEndSessionBatch && !isAskPlannerBatch) {
		const delayMs = getResponseCreateDelayMs?.() ?? 0;
		if (delayMs > 0) {
			diag("response-create-delayed", {
				delayMs,
				reason: "token-rate-limit",
			});
			await sleep(delayMs);
		}
		if (isDisposed?.()) {
			diag("response-create-skipped", { reason: "dispatcher-reset" });
			return;
		}
		diag("response-create", {
			callCount: results.length,
			imageCount: results.filter((r) => r.image != null).length,
		});
		opts.send({ type: "response.create" });
	} else {
		diag("response-create-skipped", {
			reason: isEndSessionBatch ? "end_session" : "ask_planner",
		});
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
