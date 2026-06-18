/**
 * App-level streaming state store.
 *
 * Why this exists: the live agent stream's Tauri Channel callback writes
 * to React state (pending AUQ, pending permission, sending flag, etc.).
 * If the component that owns that state unmounts mid-stream — e.g. user
 * navigates from a workspace to the Start Page — every subsequent
 * setState becomes a no-op against the dead component, the AUQ panel
 * never appears, and the stream silently hangs because the user has no
 * way to respond.
 *
 * Lifting these slices into a module-level Zustand store decouples
 * "where the channel callback writes" from "which component is mounted".
 * Container remounts read the existing snapshot and resume rendering;
 * channel events that fire while no container is mounted simply update
 * the store and are picked up on the next mount.
 *
 * Every slice is keyed by `contextKey` (the composer's per-conversation
 * id, e.g. `session:<uuid>`). Identity-stable updates (the slice object
 * is replaced only when something inside it actually changes) keep
 * Zustand's selector re-render fan-out scoped to consumers whose slice
 * changed.
 */
import type { SerializedEditorState } from "lexical";
import { create } from "zustand";
import type { PendingUserInput } from "@/features/conversation/pending-user-input";
import type { ComposerCustomTag } from "@/lib/composer-insert";

export type PendingPermission = {
	permissionId: string;
	toolName: string;
	toolInput: Record<string, unknown>;
	title?: string | null;
	description?: string | null;
};

export type LiveSessionInfo = {
	provider: string;
	providerSessionId?: string | null;
};

export type ActiveSessionInfo = {
	stopSessionId: string;
	provider: string;
};

export type ComposerRestoreState = {
	contextKey: string;
	draft: string;
	images: string[];
	files: string[];
	customTags: ComposerCustomTag[];
	/** Optional full Lexical editor state. When present the composer restores
	 *  via `setEditorState(parseEditorState(...))` — a clean, lossless round
	 *  trip. The `draft / images / files / customTags` fields above remain as
	 *  a fallback for callers that don't have a snapshot. */
	editorState?: SerializedEditorState | null;
	nonce: number;
};

type StreamingState = {
	composerRestore: ComposerRestoreState | null;
	liveSessionsByContext: Record<string, LiveSessionInfo>;
	sendErrorsByContext: Record<string, string | null>;
	activeSessionByContext: Record<string, ActiveSessionInfo>;
	mirroredActiveSessionByContext: Record<string, string>;
	sendingContextKeys: ReadonlySet<string>;
	pendingPermissionsByContext: Record<string, PendingPermission[]>;
	pendingUserInputByContext: Record<string, PendingUserInput | null>;
	userInputResponsePendingByContext: Record<string, boolean>;
	interactionWorkspaceByContext: Record<string, string | null>;
	planReviewByContext: Record<string, boolean>;
	activeFastPreludes: Record<string, boolean>;
};

type StreamingActions = {
	setPendingUserInput(contextKey: string, value: PendingUserInput | null): void;
	clearPendingUserInput(contextKey: string): void;
	setUserInputResponsePending(contextKey: string, value: boolean): void;
	appendPendingPermission(
		contextKey: string,
		permission: PendingPermission,
	): void;
	removePendingPermission(contextKey: string, permissionId: string): void;
	clearPendingPermissions(contextKey: string): void;
	markSendingState(contextKey: string): void;
	clearSendingState(contextKey: string): void;
	setSendError(contextKey: string, error: string | null): void;
	setActiveSession(contextKey: string, info: ActiveSessionInfo): void;
	clearActiveSession(contextKey: string): void;
	setMirroredActiveSession(contextKey: string, sessionId: string): void;
	clearMirroredActiveSession(contextKey: string): void;
	setLiveSession(contextKey: string, info: LiveSessionInfo): void;
	rememberInteractionWorkspace(
		contextKey: string,
		workspaceId: string | null,
	): void;
	setPlanReviewActive(contextKey: string): void;
	clearPlanReview(contextKey: string): void;
	setFastPreludeActive(contextKey: string): void;
	clearFastPrelude(contextKey: string): void;
	setComposerRestore(value: ComposerRestoreState | null): void;
};

export type StreamingStore = StreamingState & StreamingActions;

function freshInitialState(): StreamingState {
	return {
		composerRestore: null,
		liveSessionsByContext: {},
		sendErrorsByContext: {},
		activeSessionByContext: {},
		mirroredActiveSessionByContext: {},
		sendingContextKeys: new Set<string>(),
		pendingPermissionsByContext: {},
		pendingUserInputByContext: {},
		userInputResponsePendingByContext: {},
		interactionWorkspaceByContext: {},
		planReviewByContext: {},
		activeFastPreludes: {},
	};
}

const INITIAL_STATE: StreamingState = freshInitialState();

export const EMPTY_PENDING_PERMISSIONS: readonly PendingPermission[] =
	Object.freeze([]);

/**
 * Omit a key from a Record, returning the same Record reference when the
 * key was absent so Zustand's shallow equality bails on no-op deletes.
 */
function omitKey<T>(
	current: Record<string, T>,
	key: string,
): Record<string, T> {
	if (!(key in current)) return current;
	const next = { ...current };
	delete next[key];
	return next;
}

export const useStreamingStore = create<StreamingStore>((set) => ({
	...INITIAL_STATE,

	// -------------------------------------------------------------------
	// pendingUserInput (AUQ / elicitation panel)
	// -------------------------------------------------------------------
	setPendingUserInput: (contextKey, value) =>
		set((state) => {
			const cur = state.pendingUserInputByContext[contextKey] ?? null;
			if (cur === value) return state;
			return {
				pendingUserInputByContext: {
					...state.pendingUserInputByContext,
					[contextKey]: value,
				},
			};
		}),

	clearPendingUserInput: (contextKey) =>
		set((state) => {
			const stripped = omitKey(state.pendingUserInputByContext, contextKey);
			const strippedPending = omitKey(
				state.userInputResponsePendingByContext,
				contextKey,
			);
			if (
				stripped === state.pendingUserInputByContext &&
				strippedPending === state.userInputResponsePendingByContext
			) {
				return state;
			}
			return {
				pendingUserInputByContext: stripped,
				userInputResponsePendingByContext: strippedPending,
			};
		}),

	// -------------------------------------------------------------------
	// userInputResponsePending — UI lock while AUQ submit is in-flight
	// -------------------------------------------------------------------
	setUserInputResponsePending: (contextKey, value) =>
		set((state) => {
			const cur = state.userInputResponsePendingByContext[contextKey] ?? false;
			if (cur === value) return state;
			return {
				userInputResponsePendingByContext: {
					...state.userInputResponsePendingByContext,
					[contextKey]: value,
				},
			};
		}),

	// -------------------------------------------------------------------
	// pendingPermissions (canUseTool permission requests)
	// -------------------------------------------------------------------
	appendPendingPermission: (contextKey, permission) =>
		set((state) => ({
			pendingPermissionsByContext: {
				...state.pendingPermissionsByContext,
				[contextKey]: [
					...(state.pendingPermissionsByContext[contextKey] ?? []),
					permission,
				],
			},
		})),

	clearPendingPermissions: (contextKey) =>
		set((state) => {
			const existing =
				state.pendingPermissionsByContext[contextKey] ??
				EMPTY_PENDING_PERMISSIONS;
			if (existing.length === 0) return state;
			return {
				pendingPermissionsByContext: omitKey(
					state.pendingPermissionsByContext,
					contextKey,
				),
			};
		}),

	/**
	 * Drop a single permission by id. Used when the user responds (allow /
	 * deny) — the request becomes a no-op for that one permission while
	 * any other pending permissions stay visible.
	 */
	removePendingPermission: (contextKey, permissionId) =>
		set((state) => {
			const existing =
				state.pendingPermissionsByContext[contextKey] ??
				EMPTY_PENDING_PERMISSIONS;
			const next = existing.filter(
				(permission) => permission.permissionId !== permissionId,
			);
			if (next.length === existing.length) return state;
			const stripped = { ...state.pendingPermissionsByContext };
			if (next.length > 0) {
				stripped[contextKey] = next;
			} else {
				delete stripped[contextKey];
			}
			return { pendingPermissionsByContext: stripped };
		}),

	// -------------------------------------------------------------------
	// sendingContextKeys — Set of contexts with an in-flight turn
	// -------------------------------------------------------------------
	markSendingState: (contextKey) =>
		set((state) => {
			if (state.sendingContextKeys.has(contextKey)) return state;
			const next = new Set(state.sendingContextKeys);
			next.add(contextKey);
			return { sendingContextKeys: next };
		}),

	clearSendingState: (contextKey) =>
		set((state) => {
			if (!state.sendingContextKeys.has(contextKey)) return state;
			const next = new Set(state.sendingContextKeys);
			next.delete(contextKey);
			return { sendingContextKeys: next };
		}),

	// -------------------------------------------------------------------
	// sendErrorsByContext
	// -------------------------------------------------------------------
	setSendError: (contextKey, error) =>
		set((state) => {
			const cur = state.sendErrorsByContext[contextKey] ?? null;
			if (cur === error) return state;
			return {
				sendErrorsByContext: {
					...state.sendErrorsByContext,
					[contextKey]: error,
				},
			};
		}),

	// -------------------------------------------------------------------
	// activeSessionByContext — what `stopSessionId` to use for stop button
	// -------------------------------------------------------------------
	setActiveSession: (contextKey, info) =>
		set((state) => {
			const cur = state.activeSessionByContext[contextKey];
			if (
				cur &&
				cur.stopSessionId === info.stopSessionId &&
				cur.provider === info.provider
			) {
				return state;
			}
			return {
				activeSessionByContext: {
					...state.activeSessionByContext,
					[contextKey]: info,
				},
			};
		}),

	clearActiveSession: (contextKey) =>
		set((state) => {
			const stripped = omitKey(state.activeSessionByContext, contextKey);
			if (stripped === state.activeSessionByContext) return state;
			return { activeSessionByContext: stripped };
		}),

	setMirroredActiveSession: (contextKey, sessionId) =>
		set((state) => {
			if (state.mirroredActiveSessionByContext[contextKey] === sessionId) {
				return state;
			}
			return {
				mirroredActiveSessionByContext: {
					...state.mirroredActiveSessionByContext,
					[contextKey]: sessionId,
				},
			};
		}),

	clearMirroredActiveSession: (contextKey) =>
		set((state) => {
			const stripped = omitKey(
				state.mirroredActiveSessionByContext,
				contextKey,
			);
			if (stripped === state.mirroredActiveSessionByContext) return state;
			return { mirroredActiveSessionByContext: stripped };
		}),

	// -------------------------------------------------------------------
	// liveSessionsByContext — adopted provider session id per context
	// -------------------------------------------------------------------
	setLiveSession: (contextKey, info) =>
		set((state) => {
			const cur = state.liveSessionsByContext[contextKey];
			if (
				cur &&
				cur.provider === info.provider &&
				(cur.providerSessionId ?? null) === (info.providerSessionId ?? null)
			) {
				return state;
			}
			return {
				liveSessionsByContext: {
					...state.liveSessionsByContext,
					[contextKey]: info,
				},
			};
		}),

	// -------------------------------------------------------------------
	// interactionWorkspaceByContext — workspace id at interaction time
	// -------------------------------------------------------------------
	rememberInteractionWorkspace: (contextKey, workspaceId) =>
		set((state) => {
			const cur = state.interactionWorkspaceByContext[contextKey] ?? null;
			if (cur === workspaceId) return state;
			return {
				interactionWorkspaceByContext: {
					...state.interactionWorkspaceByContext,
					[contextKey]: workspaceId,
				},
			};
		}),

	// -------------------------------------------------------------------
	// planReviewByContext
	// -------------------------------------------------------------------
	setPlanReviewActive: (contextKey) =>
		set((state) => {
			if (state.planReviewByContext[contextKey]) return state;
			return {
				planReviewByContext: {
					...state.planReviewByContext,
					[contextKey]: true,
				},
			};
		}),

	clearPlanReview: (contextKey) =>
		set((state) => {
			if (!state.planReviewByContext[contextKey]) return state;
			return {
				planReviewByContext: omitKey(state.planReviewByContext, contextKey),
			};
		}),

	// -------------------------------------------------------------------
	// activeFastPreludes
	// -------------------------------------------------------------------
	setFastPreludeActive: (contextKey) =>
		set((state) => {
			if (state.activeFastPreludes[contextKey]) return state;
			return {
				activeFastPreludes: {
					...state.activeFastPreludes,
					[contextKey]: true,
				},
			};
		}),

	clearFastPrelude: (contextKey) =>
		set((state) => {
			if (!state.activeFastPreludes[contextKey]) return state;
			return {
				activeFastPreludes: omitKey(state.activeFastPreludes, contextKey),
			};
		}),

	// -------------------------------------------------------------------
	// composerRestore — single-entry restore stash after a send error
	// -------------------------------------------------------------------
	setComposerRestore: (value) =>
		set((state) => {
			if (state.composerRestore === value) return state;
			return { composerRestore: value };
		}),
}));

/**
 * Reset every slice back to the initial state. This is a MODULE-LEVEL singleton
 * store (intentionally — channel callbacks write here regardless of which
 * component is mounted), so it SURVIVES the app-subtree remount on a team↔local
 * transport switch. After such a switch the per-context slices
 * (`activeSessionByContext` / `sendingContextKeys` / `liveSessionsByContext` /
 * …) hold session ids from the OLD backend, which would (a) leak the old
 * backend's "a stream is live" gating onto the new transport and (b) pair stale
 * stop-session ids with the new backend. The transport-switch effect in
 * `app-providers.tsx` calls this so the new transport starts from a clean slate.
 *
 * Uses Zustand's merge mode (no second `true` arg) so the action methods stay
 * attached — `setState(state, true)` replaces the whole object and would nuke
 * every action. A fresh initial state (new `sendingContextKeys` Set) is built
 * each call so no two resets share a mutable reference.
 */
export function resetStreamingStore(): void {
	useStreamingStore.setState(freshInitialState());
}

/**
 * Test-only alias for {@link resetStreamingStore}. Kept as a separate named
 * export so existing test imports stay valid.
 */
export function __resetStreamingStoreForTests(): void {
	resetStreamingStore();
}
