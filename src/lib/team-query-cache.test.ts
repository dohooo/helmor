import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import {
	computeTeamBucketKey,
	deleteTeamQueryCacheBucket,
	registerAndPruneTeamBuckets,
} from "./team-query-cache";

vi.mock("./ipc", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ipc")>()),
	invoke: vi.fn(),
}));

const INDEX_KEY = "helmor.team.cacheBuckets";

describe("team query cache buckets (R2-D)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.localStorage.removeItem(INDEX_KEY);
		vi.mocked(ipc.invoke).mockResolvedValue(undefined);
	});
	afterEach(() => {
		window.localStorage.removeItem(INDEX_KEY);
	});

	it("bucket key is stable for the same url+token and changes with either", async () => {
		const a1 = await computeTeamBucketKey("https://t.example", "tok-1");
		const a2 = await computeTeamBucketKey("https://t.example", "tok-1");
		const b = await computeTeamBucketKey("https://t.example", "tok-2");
		const c = await computeTeamBucketKey("https://other.example", "tok-1");
		expect(a1).toBe(a2);
		expect(a1).toMatch(/^helmor-query-cache--team-[0-9a-f]{64}$/);
		expect(new Set([a1, b, c]).size).toBe(3);
	});

	it("ADJUDICATION ANCHOR: the old-token bucket is ACTUALLY DELETED when the new token initializes", async () => {
		// Aggressive retention (by ruling): only the current team bucket (+ the
		// local bucket, under a different fixed key) survive. This assertion
		// exists to make a future silent drift back to LRU-style retention fail
		// loudly — leaving a team / rotating a token must remove the old cache
		// from disk, not merely stop using it.
		const oldKey = await computeTeamBucketKey("https://t.example", "old-token");
		const newKey = await computeTeamBucketKey("https://t.example", "new-token");
		window.localStorage.setItem(INDEX_KEY, JSON.stringify([oldKey]));

		await registerAndPruneTeamBuckets(newKey);

		expect(ipc.invoke).toHaveBeenCalledWith("delete_query_cache", {
			key: oldKey,
		});
		expect(JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]")).toEqual([
			newKey,
		]);
	});

	it("prune keeps the current bucket and never touches the local bucket key", async () => {
		const current = await computeTeamBucketKey("https://t.example", "tok");
		window.localStorage.setItem(
			INDEX_KEY,
			// A hostile/corrupt index entry that isn't a team bucket must be
			// ignored, not deleted (the local bucket lives outside the prefix).
			JSON.stringify([current, "helmor-query-cache"]),
		);
		await registerAndPruneTeamBuckets(current);
		expect(ipc.invoke).not.toHaveBeenCalled();
		expect(
			JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]"),
		).toContain(current);
	});

	it("a failed delete stays in the ledger for the next init to retry", async () => {
		const oldKey = await computeTeamBucketKey("https://t.example", "old");
		const newKey = await computeTeamBucketKey("https://t.example", "new");
		window.localStorage.setItem(INDEX_KEY, JSON.stringify([oldKey]));
		vi.mocked(ipc.invoke).mockRejectedValueOnce(new Error("disk"));

		await registerAndPruneTeamBuckets(newKey);
		const index = JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]");
		expect(index).toContain(oldKey);
		expect(index).toContain(newKey);
	});

	it("deleteTeamQueryCacheBucket removes the bucket and its ledger entry (clearTeamConfig path)", async () => {
		const key = await computeTeamBucketKey("https://t.example", "tok");
		window.localStorage.setItem(INDEX_KEY, JSON.stringify([key]));
		await deleteTeamQueryCacheBucket("https://t.example", "tok");
		expect(ipc.invoke).toHaveBeenCalledWith("delete_query_cache", { key });
		expect(JSON.parse(window.localStorage.getItem(INDEX_KEY) ?? "[]")).toEqual(
			[],
		);
	});
});
