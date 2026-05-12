import { type HelmorCliResult, runHelmorCli } from "@/lib/api";
import type {
	RealtimeClientEvent,
	RealtimeServerEvent,
} from "./realtime-session";

/** Names of every typed tool we declare to `gpt-realtime-2`. Keep in
 *  sync with the `tools` array in `commands::voice_tools` on the Rust
 *  side. */
type ToolName =
	| "list_workspaces"
	| "show_workspace"
	| "create_workspace"
	| "set_workspace_status"
	| "list_sessions"
	| "send_prompt"
	| "list_repos"
	| "select_workspace"
	| "wait_for_user";

/** Coarse-grained kinds of state the voice agent can mutate. The
 *  dispatcher emits these so the host can invalidate the matching
 *  React Query caches — without that wiring, the running GUI never
 *  notices that an external CLI process changed the database, and
 *  newly-created workspaces stay invisible until the app restarts. */
export type AgentMutationKind = "workspaces" | "sessions" | "repos";

/** How each declared tool maps to an actual `helmor` CLI invocation.
 *  `toArgs` translates the model-supplied argument JSON into argv;
 *  `invalidates` lists which caches to refresh after a successful run. */
type ToolSpec = {
	toArgs: (args: Record<string, unknown>) => string[];
	invalidates?: AgentMutationKind[];
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
		invalidates: ["workspaces"],
	},
	set_workspace_status: {
		// `set-status` is a clap subcommand whose actions are further
		// nested (`Set`, `Clear`) — see `cli/args.rs::WorkspaceStatusAction`.
		// The missing `"set"` literal here used to cause every call to
		// exit non-zero; combined with the now-deleted detach mode (which
		// reported `ok: true` regardless), this was silent for months.
		toArgs: (a) => [
			"workspace",
			"set-status",
			"set",
			String(a.status ?? ""),
			String(a.ref ?? ""),
			"--json",
		],
		invalidates: ["workspaces"],
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
		// `helmor send` may create a new session item in the workspace
		// (and updates last-message timestamps). Invalidate both lists
		// so the GUI sees the freshly-spawned session.
		invalidates: ["sessions", "workspaces"],
	},
	list_repos: {
		toArgs: () => ["repo", "list", "--json"],
	},
	select_workspace: {
		// UI-only side effect: dispatcher uses `workspace show` to
		// resolve the ref → UUID, then routes through
		// `onNavigateToWorkspace`. We still shell `show --json` because
		// it validates the ref exists before we navigate (a slug for a
		// just-deleted workspace would otherwise leave the UI on a
		// dangling row).
		toArgs: (a) => ["workspace", "show", String(a.ref ?? ""), "--json"],
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
	/** Called after a successful write tool returns, with the kinds of
	 *  state that changed. The host should map these to React Query
	 *  invalidations so the GUI picks up the external DB mutation
	 *  (`helmor` CLI writes to the same SQLite the desktop app reads). */
	onMutation?: (kinds: AgentMutationKind[]) => void;
	/** Drive UI workspace selection on behalf of the voice agent.
	 *  Called with a resolved workspace UUID after:
	 *  - the model explicitly calls `select_workspace`
	 *  - `create_workspace` finishes (auto-follow to the new workspace)
	 *  - `send_prompt` finishes (auto-follow to the target workspace
	 *    so the user sees the agent's reply stream in real time)
	 *
	 *  The dispatcher guarantees the id is non-empty and the CLI call
	 *  it was derived from reported success — the host doesn't need
	 *  defensive checks on its side. */
	onNavigateToWorkspace?: (workspaceId: string) => void;
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
			if (r.invalidates) {
				for (const kind of r.invalidates) kinds.add(kind);
			}
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
}

type RunCallResult = {
	callId: string;
	output: string;
	invalidates?: AgentMutationKind[];
	navigateToWorkspaceId?: string;
};

/** Run one tool call, return the JSON envelope the model will see plus
 *  any cache-invalidation hints and UI-navigation intent. */
async function runCall(call: PendingCall): Promise<RunCallResult> {
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
		cli = await runHelmorCli(argv);
	} catch (err) {
		return {
			callId: call.callId,
			output: JSON.stringify({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}),
		};
	}

	// Only request a cache flush when the CLI itself reported success;
	// otherwise the DB hasn't actually changed and invalidating would
	// just thrash queries.
	const succeeded = cli.ok && !cli.error;
	const invalidates = succeeded ? spec.invalidates : undefined;

	// Resolve UI navigation intent for the three workspace-touching
	// tools. Guard: only navigate on real success and a non-empty id.
	let navigateToWorkspaceId: string | undefined;
	if (succeeded) {
		if (call.name === "select_workspace" || call.name === "create_workspace") {
			// Both commands print the workspace row as JSON; the
			// canonical `id` field is the UUID we hand to the UI.
			navigateToWorkspaceId = parseWorkspaceId(cli.stdout) ?? undefined;
		} else if (call.name === "send_prompt") {
			// `helmor send --json` emits `AgentStreamEvent::Done`, which
			// carries `sessionId` but not `workspaceId`. Re-resolve from
			// the user-supplied ref so we can follow the prompt to the
			// right workspace. The shortcut for already-resolved UUIDs
			// avoids a second CLI hop in the common voice flow where
			// the model just listed workspaces and got UUIDs back.
			const ref = typeof args.workspace === "string" ? args.workspace : "";
			if (ref) {
				navigateToWorkspaceId = (await resolveWorkspaceId(ref)) ?? undefined;
			}
		}
	}

	// For select_workspace, return a tiny envelope rather than the
	// full workspace row — the model only needs to confirm; surfacing
	// the row tempts it to read the id aloud, which violates the
	// "no UUIDs" rule in the prompt.
	const output =
		call.name === "select_workspace" && navigateToWorkspaceId
			? JSON.stringify({ ok: true, navigated_to: navigateToWorkspaceId })
			: JSON.stringify(envelopeFor(cli));

	return {
		callId: call.callId,
		output,
		invalidates,
		navigateToWorkspaceId,
	};
}

/** Pull the UUID we should navigate to out of `helmor workspace
 *  show|new --json` output. The two commands print different
 *  envelopes:
 *  - `workspace show` returns a `WorkspaceDetail` with `id` at the
 *    top level.
 *  - `workspace new` returns a `CreateWorkspaceResponse` whose
 *    relevant fields are `selectedWorkspaceId` (preferred — covers
 *    the case where create reuses a pending workspace) and
 *    `createdWorkspaceId` (fallback). It does NOT have an `id`
 *    field — relying on `id` alone for `create_workspace` silently
 *    dropped the navigate event and was the original bug here.
 *
 *  We check all three in priority order so this one helper covers
 *  every workspace-emitting subcommand. */
function parseWorkspaceId(stdout: string): string | null {
	const parsed = tryParseJson(stdout);
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	for (const key of ["id", "selectedWorkspaceId", "createdWorkspaceId"]) {
		const value = obj[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

/** Standard 8-4-4-4-12 hex UUID. We use this to skip a redundant
 *  `workspace show` round-trip when the model already passed a UUID
 *  (which is what `list_workspaces` returns). */
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Translate a workspace ref (UUID or `repo-name/dir-name`) to its
 *  UUID, used by the auto-navigate path for `send_prompt`. Returns
 *  `null` on any failure path so the caller skips navigation cleanly
 *  rather than landing on a stale or non-existent workspace. */
async function resolveWorkspaceId(ref: string): Promise<string | null> {
	if (UUID_RE.test(ref)) return ref;
	let cli: HelmorCliResult;
	try {
		cli = await runHelmorCli(["workspace", "show", ref, "--json"]);
	} catch {
		return null;
	}
	if (!cli.ok || cli.error) return null;
	return parseWorkspaceId(cli.stdout);
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
 *  but fall back to the raw text if parsing fails.
 *
 *  Failure paths: when the CLI exits non-zero it usually prints a
 *  `{"error":"..."}` JSON to stdout (see `helmor` Rust impl). We lift
 *  that string up to the envelope's top-level `error` so the model
 *  doesn't have to dig into `data` to phrase the failure — that step
 *  was unreliable in practice and led to false "success" reports. */
function envelopeFor(cli: HelmorCliResult): unknown {
	if (cli.error) {
		return {
			ok: false,
			error: cli.error,
			exit_code: cli.exitCode,
			stderr: cli.stderr || undefined,
		};
	}
	const data = tryParseJson(cli.stdout);
	let error: string | undefined;
	if (
		!cli.ok &&
		data &&
		typeof data === "object" &&
		"error" in (data as Record<string, unknown>)
	) {
		const e = (data as Record<string, unknown>).error;
		if (typeof e === "string" && e.length > 0) error = e;
	}
	if (!cli.ok && !error && cli.stderr) {
		error = cli.stderr.trim().split("\n")[0];
	}
	return {
		ok: cli.ok,
		exit_code: cli.exitCode,
		data,
		...(error ? { error } : {}),
		...(cli.stderr ? { stderr: cli.stderr } : {}),
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
