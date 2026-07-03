/**
 * R2-D: per-backend React Query cache buckets for TEAM mode.
 *
 * The local transport persists its cache under the fixed
 * `helmor-query-cache` file. Team mode gets its own bucket keyed by
 * `sha256(url + "\n" + token)` so that:
 * - Local↔Team switching restores each side's lists instantly (R1),
 * - two different team backends never bleed into each other,
 * - a different member token on the same URL is a DIFFERENT bucket —
 *   cached workspace lists never leak across identities on a shared
 *   machine (security over convenience: a token rotation abandons the
 *   old bucket, which the pruning below reclaims).
 *
 * Bucket lifecycle is AGGRESSIVE by ruling: only the CURRENT team bucket
 * (+ the local bucket, which lives under a different fixed key) survive.
 * Anything else in the index — rotated-token buckets, buckets of teams
 * this machine has left — is deleted at the next team-persister init.
 * Leaving a team must not keep its workspace-list cache on disk
 * (privacy); re-joining an old team merely costs one cold first paint.
 *
 * All storage goes through the LOCAL Tauri commands (`read/write/
 * delete_query_cache` are in `LOCAL_ONLY_INVOKES`): the cache is desktop
 * disk state even while the app's transport points at the team Worker.
 */
import { invoke } from "./ipc";

const TEAM_BUCKET_PREFIX = "helmor-query-cache--team-";
/** localStorage index of every team bucket this machine has created —
 *  hashed keys aren't enumerable from the frontend, so we keep our own
 *  ledger to be able to prune. */
const TEAM_BUCKET_INDEX_KEY = "helmor.team.cacheBuckets";

function readBucketIndex(): string[] {
	try {
		const raw = window.localStorage.getItem(TEAM_BUCKET_INDEX_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed)
			? parsed.filter((k): k is string => typeof k === "string")
			: [];
	} catch {
		return [];
	}
}

function writeBucketIndex(keys: string[]): void {
	try {
		window.localStorage.setItem(TEAM_BUCKET_INDEX_KEY, JSON.stringify(keys));
	} catch {
		/* index is best-effort; worst case a bucket lingers until next init */
	}
}

/** `helmor-query-cache--team-<sha256hex(url \n token)>`. The newline
 *  separator prevents concatenation ambiguity; hashing keeps the token
 *  out of filenames and logs. */
export async function computeTeamBucketKey(
	url: string,
	token: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(`${url}\n${token}`);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${TEAM_BUCKET_PREFIX}${hex}`;
}

/** Register `currentKey` in the ledger and delete every OTHER team
 *  bucket (aggressive retention: current team + local only). Deletions
 *  are best-effort and awaited so tests can assert them; a failed
 *  delete stays in the ledger for the next init to retry. */
export async function registerAndPruneTeamBuckets(
	currentKey: string,
): Promise<void> {
	const index = readBucketIndex();
	const survivors: string[] = [currentKey];
	for (const key of index) {
		if (key === currentKey || !key.startsWith(TEAM_BUCKET_PREFIX)) continue;
		try {
			await invoke<void>("delete_query_cache", { key });
		} catch (error) {
			console.error(`[helmor] failed to prune team cache bucket`, error);
			survivors.push(key); // retry on next init
		}
	}
	writeBucketIndex(Array.from(new Set(survivors)));
}

/** Delete the bucket for a specific team config (used by
 *  `clearTeamConfig`: leaving a team removes its cached lists from disk
 *  immediately, not just at the next init). Best-effort. */
export async function deleteTeamQueryCacheBucket(
	url: string,
	token: string,
): Promise<void> {
	try {
		const key = await computeTeamBucketKey(url, token);
		await invoke<void>("delete_query_cache", { key });
		writeBucketIndex(readBucketIndex().filter((k) => k !== key));
	} catch (error) {
		console.error("[helmor] failed to delete team cache bucket", error);
	}
}
