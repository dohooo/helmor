/**
 * Strict types for the sidecar's wire protocol + the typed emitter that
 * produces them.
 *
 * Control events (ready/end/aborted/error/stopped/pong/titleGenerated) are
 * fully typed. SDK passthrough events carry arbitrary fields from the
 * underlying provider SDK and go through `SidecarEmitter.passthrough`,
 * which guarantees `id` is always our request id (never overridden by an
 * SDK-supplied field of the same name).
 */

export type ReadyEvent = { readonly type: "ready"; readonly version: number };

export type EndEvent = { readonly id: string; readonly type: "end" };

export type AbortedEvent = {
	readonly id: string;
	readonly type: "aborted";
	readonly reason: string;
};

export type ErrorEvent =
	| {
			readonly id: string;
			readonly type: "error";
			readonly message: string;
			readonly internal?: boolean;
	  }
	| {
			readonly type: "error";
			readonly message: string;
			readonly internal?: boolean;
	  };

export type StoppedEvent = {
	readonly id: string;
	readonly type: "stopped";
	readonly sessionId: string;
};

export type SteeredEvent = {
	readonly id: string;
	readonly type: "steered";
	readonly sessionId: string;
	readonly accepted: boolean;
	readonly reason?: string;
};

export type PongEvent = { readonly id: string; readonly type: "pong" };

/**
 * Liveness ping — emitted every ~15s while a stream is active. Used by the
 * Rust side to detect a hung/frozen sidecar vs. one that's legitimately
 * waiting on a long-running tool. Carries no payload; only presence matters.
 */
export type HeartbeatEvent = {
	readonly id: string;
	readonly type: "heartbeat";
};

export type TitleGeneratedEvent = {
	readonly id: string;
	readonly type: "titleGenerated";
	readonly title: string;
	readonly branchName: string | undefined;
};

export type SlashCommandEntry = {
	readonly name: string;
	readonly description: string;
	readonly argumentHint: string | undefined;
	readonly source: "builtin" | "skill";
};

export type SlashCommandsListedEvent = {
	readonly id: string;
	readonly type: "slashCommandsListed";
	readonly commands: readonly SlashCommandEntry[];
};

export type PermissionRequestEvent = {
	readonly id: string;
	readonly type: "permissionRequest";
	readonly permissionId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
	readonly title: string | undefined;
	readonly description: string | undefined;
};

/**
 * Unified "agent needs user input" event. Subsumes what used to be three
 * separate events (Claude MCP `elicitationRequest`, Claude AUQ
 * `deferredToolUse`, Codex `userInputRequest`).
 *
 * The wire-level event shape is unified, but each `payload.kind` keeps
 * its provider's native data shape so the matching frontend renderer
 * can render exactly the UI it always rendered (AUQ keeps preview /
 * notes / header / always-other; elicitation keeps its JSON-Schema
 * form / URL launcher; etc.). `source` is a free-form badge string
 * (e.g. `"Claude"`, `"Codex"`, an MCP server name).
 *
 * `userInputId` is the round-trip key — the matching `respondToUserInput`
 * RPC carries the same id, and the sidecar's `pendingUserInputs` map
 * uses it to dispatch the user's answer back to the correct waiting
 * resolver closure. The closure encapsulates all SDK-specific
 * back-conversion (AUQ `updatedInput`, MCP `ElicitationResult`, Codex
 * `answers`).
 */
export type UserInputRequestEvent = {
	readonly id: string;
	readonly type: "userInputRequest";
	readonly userInputId: string;
	readonly source: string;
	readonly message: string;
	readonly payload: UserInputPayload;
};

export type UserInputPayload =
	| {
			readonly kind: "ask-user-question";
			readonly questions: ReadonlyArray<Record<string, unknown>>;
			readonly metadata?: Record<string, unknown>;
	  }
	| {
			readonly kind: "form";
			readonly schema: Record<string, unknown>;
	  }
	| {
			readonly kind: "url";
			readonly url: string;
	  };

export type PermissionModeChangedEvent = {
	readonly id: string;
	readonly type: "permissionModeChanged";
	readonly permissionMode: string;
};

export type PlanCapturedEvent = {
	readonly id: string;
	readonly type: "planCaptured";
	readonly toolUseId: string;
	readonly plan: string | null;
};

export type ModelsListedEvent = {
	readonly id: string;
	readonly type: "modelsListed";
	readonly provider: string;
	readonly models: ReadonlyArray<{
		readonly id: string;
		readonly label: string;
		readonly cliModel: string;
		readonly effortLevels?: readonly string[];
		readonly supportsFastMode?: boolean;
		/** Cursor only — raw `parameters[]` from `Cursor.models.list`. */
		readonly cursorParameters?: ReadonlyArray<{
			readonly id: string;
			readonly displayName?: string;
			readonly values: ReadonlyArray<{
				readonly value: string;
				readonly displayName?: string;
			}>;
		}>;
	}>;
};

// Context-window snapshot from the agent SDK. Claude auto-pulls at
// turn-end; Codex forwards `thread/tokenUsage/updated`. Both ride on
// the streaming requestId. `meta` is the raw SDK JSON, stringified.
export type ContextUsageUpdatedEvent = {
	readonly id: string;
	readonly type: "contextUsageUpdated";
	readonly sessionId: string;
	readonly meta: string | null;
};

// Ad-hoc response to a `getContextUsage` RPC. Rides on the request's
// own id (not a stream id) and carries the slim JSON directly — not
// persisted, frontend caches for 30s.
export type ContextUsageResultEvent = {
	readonly id: string;
	readonly type: "contextUsageResult";
	readonly meta: string;
};

// Codex `/goal` state change. `goal` is the stringified `ThreadGoal`
// payload from `thread/goal/updated`; `null` means the goal was cleared.
// Rust persists this to an in-memory map so the banner can render the
// active goal in the panel header.
export type CodexGoalUpdatedEvent = {
	readonly id: string;
	readonly type: "codexGoalUpdated";
	readonly sessionId: string;
	readonly goal: string | null;
};

export type SidecarControlEvent =
	| ReadyEvent
	| EndEvent
	| AbortedEvent
	| ErrorEvent
	| StoppedEvent
	| SteeredEvent
	| PongEvent
	| HeartbeatEvent
	| TitleGeneratedEvent
	| SlashCommandsListedEvent
	| PermissionRequestEvent
	| UserInputRequestEvent
	| PermissionModeChangedEvent
	| PlanCapturedEvent
	| ModelsListedEvent
	| ContextUsageUpdatedEvent
	| ContextUsageResultEvent
	| CodexGoalUpdatedEvent;

/**
 * Typed emitter for the sidecar's stdout protocol.
 *
 * One method per control-event type so callers can't typo a field name or
 * forget a required one. `passthrough` is the single escape hatch for
 * forwarding raw provider SDK messages.
 */
export interface SidecarEmitter {
	ready(version: number): void;
	end(requestId: string): void;
	aborted(requestId: string, reason: string): void;
	error(requestId: string | null, message: string, internal?: boolean): void;
	stopped(requestId: string, sessionId: string): void;
	steered(
		requestId: string,
		sessionId: string,
		accepted: boolean,
		reason?: string,
	): void;
	pong(requestId: string): void;
	heartbeat(requestId: string): void;
	titleGenerated(
		requestId: string,
		title: string,
		branchName: string | undefined,
	): void;
	slashCommandsListed(
		requestId: string,
		commands: readonly SlashCommandEntry[],
	): void;
	permissionRequest(
		requestId: string,
		permissionId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
		title: string | undefined,
		description: string | undefined,
	): void;
	/**
	 * Surface a user-input request to the frontend. `source` is a free-form
	 * badge string (e.g. `"Claude"`, `"Codex"`, an MCP server name).
	 * `payload` carries the kind-specific data the matching frontend
	 * renderer needs to render its native UI; see [`UserInputPayload`].
	 */
	userInputRequest(
		requestId: string,
		userInputId: string,
		source: string,
		message: string,
		payload: UserInputPayload,
	): void;
	permissionModeChanged(requestId: string, permissionMode: string): void;
	planCaptured(requestId: string, toolUseId: string, plan: string | null): void;
	modelsListed(
		requestId: string,
		provider: string,
		models: ReadonlyArray<{
			id: string;
			label: string;
			cliModel: string;
			effortLevels?: readonly string[];
			supportsFastMode?: boolean;
			cursorParameters?: ReadonlyArray<{
				id: string;
				displayName?: string;
				values: ReadonlyArray<{
					value: string;
					displayName?: string;
				}>;
			}>;
		}>,
	): void;
	contextUsageUpdated(
		requestId: string,
		sessionId: string,
		meta: string | null,
	): void;
	contextUsageResult(requestId: string, meta: string): void;
	codexGoalUpdated(
		requestId: string,
		sessionId: string,
		goal: string | null,
	): void;
	/**
	 * Forward a raw provider SDK message. `id` is appended LAST so an SDK
	 * field named `id` can never override our request id.
	 */
	passthrough(requestId: string, message: object): void;
}

/** Build a `SidecarEmitter` that pushes events through `write`. */
export function createSidecarEmitter(
	write: (event: object) => void,
): SidecarEmitter {
	return {
		ready: (version) => write({ type: "ready", version }),
		end: (requestId) => write({ id: requestId, type: "end" }),
		aborted: (requestId, reason) =>
			write({ id: requestId, type: "aborted", reason }),
		error: (requestId, message, internal) =>
			write(
				requestId === null
					? { type: "error", message, ...(internal ? { internal: true } : {}) }
					: {
							id: requestId,
							type: "error",
							message,
							...(internal ? { internal: true } : {}),
						},
			),
		stopped: (requestId, sessionId) =>
			write({ id: requestId, type: "stopped", sessionId }),
		steered: (requestId, sessionId, accepted, reason) =>
			write({
				id: requestId,
				type: "steered",
				sessionId,
				accepted,
				...(reason ? { reason } : {}),
			}),
		pong: (requestId) => write({ id: requestId, type: "pong" }),
		heartbeat: (requestId) => write({ id: requestId, type: "heartbeat" }),
		titleGenerated: (requestId, title, branchName) =>
			write({ id: requestId, type: "titleGenerated", title, branchName }),
		slashCommandsListed: (requestId, commands) =>
			write({ id: requestId, type: "slashCommandsListed", commands }),
		permissionRequest: (
			requestId,
			permissionId,
			toolName,
			toolInput,
			title,
			description,
		) =>
			write({
				id: requestId,
				type: "permissionRequest",
				permissionId,
				toolName,
				toolInput,
				title,
				description,
			}),
		userInputRequest: (requestId, userInputId, source, message, payload) =>
			write({
				id: requestId,
				type: "userInputRequest",
				userInputId,
				source,
				message,
				payload,
			}),
		permissionModeChanged: (requestId, permissionMode) =>
			write({
				id: requestId,
				type: "permissionModeChanged",
				permissionMode,
			}),
		planCaptured: (requestId, toolUseId, plan) =>
			write({ id: requestId, type: "planCaptured", toolUseId, plan }),
		modelsListed: (requestId, provider, models) =>
			write({ id: requestId, type: "modelsListed", provider, models }),
		contextUsageUpdated: (requestId, sessionId, meta) =>
			write({
				id: requestId,
				type: "contextUsageUpdated",
				sessionId,
				meta,
			}),
		contextUsageResult: (requestId, meta) =>
			write({ id: requestId, type: "contextUsageResult", meta }),
		codexGoalUpdated: (requestId, sessionId, goal) =>
			write({
				id: requestId,
				type: "codexGoalUpdated",
				sessionId,
				goal,
			}),
		passthrough: (requestId, message) =>
			write({ ...(message as Record<string, unknown>), id: requestId }),
	};
}
