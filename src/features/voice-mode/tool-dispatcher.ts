import { type HelmorCliResult, runHelmorCli } from "@/lib/api";
import type {
	RealtimeClientEvent,
	RealtimeServerEvent,
} from "./realtime-session";

/** Names of every typed tool we declare to `gpt-realtime-2`. Keep in
 *  sync with the `tools` array in
 *  `src-tauri/src/commands/settings_commands.rs`. */
type ToolName =
	| "list_workspaces"
	| "show_workspace"
	| "create_workspace"
	| "set_workspace_status"
	| "list_sessions"
	| "send_prompt"
	| "list_repos"
	| "wait_for_user";

/** How each declared tool maps to an actual `helmor` CLI invocation.
 *  `toArgs` translates the model-supplied argument JSON into argv;
 *  `detach: true` flips on fire-and-forget mode for streaming commands. */
type ToolSpec = {
	toArgs: (args: Record<string, unknown>) => string[];
	detach?: boolean;
};

/** Tool name → CLI invocation recipe. The descriptions registered with
 *  the model live in `settings_commands.rs`; argument names must match
 *  the JSON Schemas declared there. */
const TOOL_REGISTRY: Record<ToolName, ToolSpec> = {
	list_workspaces: {
		toArgs: (a) => {
			const out = ["workspace", "list", "--json"];
			if (typeof a.status === "string") out.push("--status", a.status);
			if (typeof a.repo === "string") out.push("--repo", a.repo);
			if (a.archived === true) out.push("--archived");
			return out;
		},
	},
	show_workspace: {
		toArgs: (a) => ["workspace", "show", String(a.ref ?? ""), "--json"],
	},
	create_workspace: {
		toArgs: (a) => [
			"workspace",
			"new",
			"--repo",
			String(a.repo ?? ""),
			"--json",
		],
	},
	set_workspace_status: {
		toArgs: (a) => [
			"workspace",
			"set-status",
			String(a.status ?? ""),
			String(a.ref ?? ""),
			"--json",
		],
	},
	list_sessions: {
		toArgs: (a) => [
			"session",
			"list",
			"--workspace",
			String(a.workspace ?? ""),
			"--json",
		],
	},
	send_prompt: {
		toArgs: (a) => {
			const out = ["send", "--workspace", String(a.workspace ?? "")];
			if (typeof a.session === "string" && a.session) {
				out.push("--session", a.session);
			}
			if (a.plan_mode === true) out.push("--plan");
			out.push("--json");
			out.push(String(a.prompt ?? ""));
			return out;
		},
		detach: true,
	},
	list_repos: {
		toArgs: () => ["repo", "list", "--json"],
	},
	wait_for_user: {
		// No-op tool. Model calls it to deliberately produce no audio
		// when the latest input was silence / background noise. The
		// dispatcher resolves it without shelling out.
		toArgs: () => [],
	},
};

function isKnownTool(name: string): name is ToolName {
	return name in TOOL_REGISTRY;
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
};

export type ToolDispatcher = {
	/** Hand every server event from `RealtimeVoiceSession.onEvent` to
	 *  this. Returns synchronously; tool execution happens in the
	 *  background. */
	handleEvent: (event: RealtimeServerEvent) => void;
	/** Drop all pending state. Call on session teardown. */
	reset: () => void;
};

/** Build a dispatcher tied to a live Realtime session. The dispatcher
 *  watches the event stream for function-call deltas, runs the
 *  corresponding `helmor` CLI invocations on `response.done`, and posts
 *  `function_call_output` items + a fresh `response.create` back. */
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
			void executeCalls(calls, opts.send);
			return;
		}
	}

	return { handleEvent, reset };
}

/** Run every function_call collected from one `response.done`, in
 *  parallel, then submit outputs + a single `response.create` to nudge
 *  the model into speaking the answer. */
async function executeCalls(
	calls: PendingCall[],
	send: (event: RealtimeClientEvent) => void,
) {
	const results = await Promise.all(calls.map((c) => runCall(c)));
	// Submit outputs sequentially — community reports race quirks if
	// multiple `conversation.item.create` events race over the data
	// channel. Then a single `response.create` re-enters speech.
	for (const r of results) {
		send({
			type: "conversation.item.create",
			item: {
				type: "function_call_output",
				call_id: r.callId,
				output: r.output,
			},
		});
	}
	send({ type: "response.create" });
}

/** Run one tool call, return the JSON envelope the model will see. */
async function runCall(
	call: PendingCall,
): Promise<{ callId: string; output: string }> {
	const args = parseArgs(call.argsBuffer);
	if (!isKnownTool(call.name)) {
		return {
			callId: call.callId,
			output: JSON.stringify({
				ok: false,
				error: `unknown tool '${call.name}'`,
			}),
		};
	}

	// wait_for_user is intentionally a no-op: it tells the model not
	// to speak, and there's nothing to actually run.
	if (call.name === "wait_for_user") {
		return { callId: call.callId, output: JSON.stringify({ ok: true }) };
	}

	const spec = TOOL_REGISTRY[call.name];
	const argv = spec.toArgs(args);

	let cli: HelmorCliResult;
	try {
		cli = await runHelmorCli(argv, spec.detach === true);
	} catch (err) {
		return {
			callId: call.callId,
			output: JSON.stringify({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}),
		};
	}

	return { callId: call.callId, output: JSON.stringify(envelopeFor(cli)) };
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

/** Wrap a `HelmorCliResult` in the shape the model expects. The CLI
 *  emits JSON on stdout when invoked with `--json`; we try to parse
 *  it so the model sees structured fields rather than a string blob,
 *  but fall back to the raw text if parsing fails. */
function envelopeFor(cli: HelmorCliResult): unknown {
	if (cli.error) {
		return {
			ok: false,
			error: cli.error,
			exit_code: cli.exitCode,
			stderr: cli.stderr,
		};
	}
	const data = tryParseJson(cli.stdout);
	return {
		ok: cli.ok,
		exit_code: cli.exitCode,
		data,
		stderr: cli.stderr || undefined,
	};
}

function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;
	try {
		return JSON.parse(trimmed);
	} catch {
		return trimmed;
	}
}
