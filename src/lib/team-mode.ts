/**
 * Team mode (Phase 0): point the desktop app's IPC transport at a remote
 * Helmor companion fronted by a Cloudflare Worker, instead of the local Tauri
 * backend. "Zero new concepts" — the UI is identical; only the transport
 * changes.
 *
 * Config lives in `localStorage` (not Tauri app-settings) because `ipc.ts` must
 * decide the transport SYNCHRONOUSLY at module load, before any async settings
 * read could resolve. {@link switchTeamMode} persists here, flips the mode flag,
 * then repoints the live transport IN PLACE — no `window.location.reload`. The
 * cold-boot path is unchanged: `ipc.ts` reads {@link isTeamModeActive} at module
 * load and routes every `invoke`/`listen`/`Channel` accordingly.
 *
 * Only `ipc.ts` (transport) and the Team settings panel / sidebar switch (UI)
 * import this module.
 *
 * The in-place switch action `switchTeamMode` lives in the sibling
 * `team-switch.ts` module (it imports `ipc.ts`), deliberately NOT here:
 * `ipc.ts` eagerly reads {@link isTeamModeActive} at module init, so importing
 * `ipc.ts` from `team-mode.ts` would force `ipc.ts` to evaluate
 * mid-`team-mode`-init and hit `MODE_KEY` in its temporal dead zone.
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

/** Flip the team-mode flag. Persistence only — use {@link switchTeamMode} to
 *  actually repoint the live transport (it flips this flag, then swaps the
 *  transport in place). */
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

/** A parsed team invite: the Worker origin to register against and the
 * one-time invite token (which doubles as the member's bearer once
 * accepted — trust-on-first-use). */
export interface ParsedInvite {
	/** Worker base URL (origin only, trailing slash stripped). */
	url: string;
	/** The invite token from the link's `?invite=` query param. */
	token: string;
}

/**
 * Parse an invite from a pasted link. The control plane mints links shaped
 * like `https://helmor-team.example.workers.dev/?invite=<token>` — the
 * Worker origin is where we register, the `invite` query param is the
 * capability token. Returns `null` when the input isn't a URL carrying a
 * non-empty `invite` param (so callers can show "not a valid invite link").
 *
 * Pure + input-only (no `window`) so it's unit-testable; the location-based
 * convenience wrapper is {@link getInviteFromLocation}.
 */
export function parseInviteLink(input: string): ParsedInvite | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	const token = parsed.searchParams.get("invite")?.trim();
	if (!token) return null;
	// Origin only — drop the path/query so the saved backend URL is the
	// bare Worker root the `/team/*` routes hang off.
	return { url: normalizeUrl(parsed.origin), token };
}

/**
 * Read an invite out of the current `window.location` (the app was opened
 * via an invite deep-link). `null` outside a browser context or when no
 * valid `?invite=` is present.
 */
export function getInviteFromLocation(): ParsedInvite | null {
	if (typeof window === "undefined") return null;
	try {
		return parseInviteLink(window.location.href);
	} catch {
		return null;
	}
}

/** Strip the `?invite=` param from the address bar after handling it, so a
 * reload doesn't re-trigger the accept flow and the token isn't left
 * lingering in the URL. No-op outside a browser / when History is absent. */
export function clearInviteFromLocation(): void {
	if (typeof window === "undefined") return;
	try {
		const url = new URL(window.location.href);
		if (!url.searchParams.has("invite")) return;
		url.searchParams.delete("invite");
		window.history.replaceState(
			window.history.state,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
	} catch {
		// History API unavailable / locked-down context — harmless to skip.
	}
}
