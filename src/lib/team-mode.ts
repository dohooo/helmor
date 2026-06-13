/**
 * Team mode (Phase 0): point the desktop app's IPC transport at a remote
 * Helmor companion fronted by a Cloudflare Worker, instead of the local Tauri
 * backend. "Zero new concepts" — the UI is identical; only the transport
 * changes.
 *
 * Config lives in `localStorage` (not Tauri app-settings) because `ipc.ts` must
 * decide the transport SYNCHRONOUSLY at module load, before any async settings
 * read could resolve. Switching mode persists here and reloads the app (the T2
 * "reload-style dynamic transport" decision); on the next boot `ipc.ts` reads
 * {@link isTeamModeActive} and routes every `invoke`/`listen`/`Channel` to the
 * Worker URL with the team token.
 *
 * Only `ipc.ts` (transport) and the Team settings panel / sidebar switch (UI)
 * import this module.
 */

const MODE_KEY = "helmor.team.mode";
const URL_KEY = "helmor.team.url";
const TOKEN_KEY = "helmor.team.token";

export interface TeamConfig {
	/** Worker base URL, trailing slash stripped. */
	url: string;
	/** Capability token the container's companion accepts (may be empty). */
	token: string;
}

function storage(): Storage | null {
	try {
		return typeof localStorage !== "undefined" ? localStorage : null;
	} catch {
		// localStorage can throw in locked-down embedded contexts.
		return null;
	}
}

function normalizeUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/** The saved team backend config, or `null` when no Worker URL is stored. */
export function getTeamConfig(): TeamConfig | null {
	const store = storage();
	if (!store) return null;
	const url = normalizeUrl(store.getItem(URL_KEY) ?? "");
	if (!url) return null;
	return { url, token: (store.getItem(TOKEN_KEY) ?? "").trim() };
}

/** Persist the Worker URL + token (does not toggle the mode on its own). */
export function saveTeamConfig(config: TeamConfig): void {
	const store = storage();
	if (!store) return;
	store.setItem(URL_KEY, normalizeUrl(config.url));
	store.setItem(TOKEN_KEY, config.token.trim());
}

/** True when team mode is switched on AND a Worker URL is configured. */
export function isTeamModeActive(): boolean {
	const store = storage();
	if (!store) return false;
	return store.getItem(MODE_KEY) === "1" && getTeamConfig() !== null;
}

/** Flip the team-mode flag (caller reloads the app to swap the transport). */
export function setTeamModeActive(active: boolean): void {
	const store = storage();
	if (!store) return;
	if (active) {
		store.setItem(MODE_KEY, "1");
	} else {
		store.removeItem(MODE_KEY);
	}
}

/**
 * Probe a team backend's reachability via its public `/v1/health` endpoint.
 * Resolves `true` only on a 2xx response; never throws (network / CORS errors
 * resolve `false`), so callers can drive a simple "connected?" indicator.
 */
export async function pingTeamBackend(
	url: string,
	token: string,
): Promise<boolean> {
	const base = normalizeUrl(url);
	if (!base) return false;
	try {
		const res = await fetch(`${base}/v1/health`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		return res.ok;
	} catch {
		return false;
	}
}
