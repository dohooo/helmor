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

export type PongEvent = { readonly id: string; readonly type: "pong" };

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

export type ElicitationRequestEvent = {
	readonly id: string;
	readonly type: "elicitationRequest";
	readonly serverName: string;
	readonly message: string;
	readonly mode: "form" | "url" | undefined;
	readonly url: string | undefined;
	readonly elicitationId: string | undefined;
	readonly requestedSchema: Record<string, unknown> | undefined;
};

export type DeferredToolUseEvent = {
	readonly id: string;
	readonly type: "deferredToolUse";
	readonly toolUseId: string;
	readonly toolName: string;
	readonly toolInput: Record<string, unknown>;
};

export type PermissionModeChangedEvent = {
	readonly id: string;
	readonly type: "permissionModeChanged";
	readonly permissionMode: string;
};

export type SidecarControlEvent =
	| ReadyEvent
	| EndEvent
	| AbortedEvent
	| ErrorEvent
	| StoppedEvent
	| PongEvent
	| TitleGeneratedEvent
	| SlashCommandsListedEvent
	| PermissionRequestEvent
	| ElicitationRequestEvent
	| DeferredToolUseEvent
	| PermissionModeChangedEvent;

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
	pong(requestId: string): void;
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
	elicitationRequest(
		requestId: string,
		serverName: string,
		message: string,
		mode: "form" | "url" | undefined,
		url: string | undefined,
		elicitationId: string | undefined,
		requestedSchema: Record<string, unknown> | undefined,
	): void;
	deferredToolUse(
		requestId: string,
		toolUseId: string,
		toolName: string,
		toolInput: Record<string, unknown>,
	): void;
	permissionModeChanged(requestId: string, permissionMode: string): void;
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
		pong: (requestId) => write({ id: requestId, type: "pong" }),
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
		elicitationRequest: (
			requestId,
			serverName,
			message,
			mode,
			url,
			elicitationId,
			requestedSchema,
		) =>
			write({
				id: requestId,
				type: "elicitationRequest",
				serverName,
				message,
				mode,
				url,
				elicitationId,
				requestedSchema,
			}),
		deferredToolUse: (requestId, toolUseId, toolName, toolInput) =>
			write({
				id: requestId,
				type: "deferredToolUse",
				toolUseId,
				toolName,
				toolInput,
			}),
		permissionModeChanged: (requestId, permissionMode) =>
			write({
				id: requestId,
				type: "permissionModeChanged",
				permissionMode,
			}),
		passthrough: (requestId, message) =>
			write({ ...(message as Record<string, unknown>), id: requestId }),
	};
}
