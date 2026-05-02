import type { SerializedEditorState } from "lexical";
import { listSessionDrafts, setSessionDraft } from "@/lib/api";

/**
 * Composer draft persistence. The on-disk source of truth is SQLite
 * (`sessions.draft_state` column) — this module hides the async IPC
 * round-trip behind the synchronous `load / save / clear` API the
 * Lexical persistence plugin already calls.
 *
 * Shape:
 *   - On boot, `hydrateDraftCache()` runs once and pulls every
 *     persisted draft into an in-memory `Map<contextKey, SerializedEditorState>`.
 *   - `loadPersistedDraft` returns from the map synchronously. Callers
 *     that mount before hydration finishes briefly see "no draft"; the
 *     `subscribeToDraftHydration` hook lets them re-render once the
 *     map is populated.
 *   - `savePersistedDraft` updates the map immediately and fires a
 *     debounced IPC write (per-context-key) so we never serialize the
 *     same state twice in a row when Lexical bursts updates.
 *   - `clearPersistedDraft` removes from the map and pushes `null` to
 *     the DB.
 *
 * `workspace:` and `global` keys are persisted under deterministic
 * `__workspace_<id>__` / `__global__` synthetic session ids so the same
 * pipeline handles them. They're rare in practice — every chat composer
 * mount uses a `session:` key.
 */

const STORAGE_PREFIX = "helmor:composer-draft:";

/** Public — used by tests that want to address the legacy localStorage
 * key (still produced for backwards compat during the transition). */
export function getComposerDraftStorageKey(contextKey: string): string {
	return `${STORAGE_PREFIX}${contextKey}`;
}

const draftCache = new Map<string, SerializedEditorState>();
const subscribers = new Set<() => void>();
let hydrationPromise: Promise<void> | null = null;
let hydrationDone = false;

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SAVE_DEBOUNCE_MS = 200;

function notifySubscribers(): void {
	for (const fn of subscribers) {
		try {
			fn();
		} catch (error) {
			console.error("[helmor] draft subscriber threw", error);
		}
	}
}

/** Tests reach for `__resetDraftCacheForTests` to start with a clean
 * slate; production code never calls it. */
export function __resetDraftCacheForTests(): void {
	draftCache.clear();
	subscribers.clear();
	hydrationPromise = null;
	hydrationDone = false;
	for (const timer of writeTimers.values()) {
		clearTimeout(timer);
	}
	writeTimers.clear();
}

/** Returns the same in-flight promise on every call so concurrent
 * mounts don't trigger N parallel `list_session_drafts` IPCs. */
export function hydrateDraftCache(): Promise<void> {
	if (hydrationPromise) return hydrationPromise;
	hydrationPromise = (async () => {
		try {
			const rows = await listSessionDrafts();
			for (const row of rows) {
				const parsed = parseEditorState(row.draftState);
				if (parsed) {
					draftCache.set(`session:${row.sessionId}`, parsed);
				}
			}
			await migrateLegacyLocalStorageDrafts();
		} catch (error) {
			console.error("[helmor] composer draft hydration failed", error);
		} finally {
			hydrationDone = true;
			notifySubscribers();
		}
	})();
	return hydrationPromise;
}

/** True once `hydrateDraftCache()` has finished — successful or not. */
export function isDraftHydrationComplete(): boolean {
	return hydrationDone;
}

/** Subscribe to hydration completion + every save / clear. The plugin
 * uses this to re-run its restore effect once the cache fills in. */
export function subscribeToDraftHydration(listener: () => void): () => void {
	subscribers.add(listener);
	return () => {
		subscribers.delete(listener);
	};
}

export function loadPersistedDraft(
	contextKey: string,
): SerializedEditorState | null {
	return draftCache.get(contextKey) ?? null;
}

export function savePersistedDraft(
	contextKey: string,
	editorState: SerializedEditorState,
): void {
	draftCache.set(contextKey, editorState);
	scheduleWrite(contextKey, editorState);
	notifySubscribers();
}

export async function persistSessionDraft(
	sessionId: string,
	editorState: SerializedEditorState,
): Promise<void> {
	draftCache.set(`session:${sessionId}`, editorState);
	notifySubscribers();
	await setSessionDraft(sessionId, JSON.stringify(editorState));
}

export function clearPersistedDraft(contextKey: string): void {
	if (!draftCache.has(contextKey) && !writeTimers.has(contextKey)) {
		// Even if cache is empty, fire the clear IPC — covers the case
		// where boot-time hydration hasn't finished and the caller is
		// trying to clear an entry the cache doesn't know about yet.
		scheduleWrite(contextKey, null);
		return;
	}
	draftCache.delete(contextKey);
	scheduleWrite(contextKey, null);
	notifySubscribers();
}

function scheduleWrite(
	contextKey: string,
	editorState: SerializedEditorState | null,
): void {
	const existing = writeTimers.get(contextKey);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		writeTimers.delete(contextKey);
		void flushWrite(contextKey, editorState);
	}, SAVE_DEBOUNCE_MS);
	writeTimers.set(contextKey, timer);
}

async function flushWrite(
	contextKey: string,
	editorState: SerializedEditorState | null,
): Promise<void> {
	const sessionId = sessionIdFromContextKey(contextKey);
	if (!sessionId) {
		// Non-session keys (workspace / global) — keep them in
		// localStorage as a fallback. Rare in practice; no DB column for
		// them and the workspaces table doesn't have one yet.
		try {
			if (editorState) {
				window.localStorage.setItem(
					getComposerDraftStorageKey(contextKey),
					JSON.stringify(editorState),
				);
			} else {
				window.localStorage.removeItem(getComposerDraftStorageKey(contextKey));
			}
		} catch (error) {
			console.error(
				`[helmor] composer draft localStorage fallback failed for "${contextKey}"`,
				error,
			);
		}
		return;
	}
	try {
		await setSessionDraft(
			sessionId,
			editorState ? JSON.stringify(editorState) : null,
		);
	} catch (error) {
		console.error(
			`[helmor] composer draft DB write failed for ${contextKey}`,
			error,
		);
	}
}

function sessionIdFromContextKey(contextKey: string): string | null {
	if (contextKey.startsWith("session:")) {
		const id = contextKey.slice("session:".length);
		return id.length > 0 ? id : null;
	}
	return null;
}

function parseEditorState(raw: string): SerializedEditorState | null {
	try {
		return JSON.parse(raw) as SerializedEditorState;
	} catch {
		return null;
	}
}

/** Move any leftover `helmor:composer-draft:session:*` keys from
 * localStorage into the DB. Runs once per app session — idempotent
 * (DB write would no-op on re-run since localStorage was cleared). */
async function migrateLegacyLocalStorageDrafts(): Promise<void> {
	if (typeof window === "undefined") return;
	const storage = window.localStorage;
	const sessionPrefix = `${STORAGE_PREFIX}session:`;

	const migrations: Array<{ key: string; sessionId: string; raw: string }> = [];
	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (!key?.startsWith(sessionPrefix)) continue;
		const sessionId = key.slice(sessionPrefix.length);
		if (!sessionId) continue;
		const raw = storage.getItem(key);
		if (!raw) continue;
		migrations.push({ key, sessionId, raw });
	}

	for (const { key, sessionId, raw } of migrations) {
		// Skip if we already loaded this draft from the DB — DB wins,
		// localStorage was just a stale leftover.
		const cacheKey = `session:${sessionId}`;
		if (!draftCache.has(cacheKey)) {
			const parsed = parseEditorState(raw);
			if (parsed) {
				draftCache.set(cacheKey, parsed);
				try {
					await setSessionDraft(sessionId, raw);
				} catch (error) {
					console.error(
						`[helmor] legacy draft migration failed for ${sessionId}`,
						error,
					);
					// Leave the localStorage entry alone so we can retry
					// next boot.
					continue;
				}
			}
		}
		try {
			storage.removeItem(key);
		} catch {
			/* ignore */
		}
	}
}
