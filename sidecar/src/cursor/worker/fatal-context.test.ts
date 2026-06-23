import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fatalScope, sessionContext } from "./fatal-context.js";

// Probe the runtime guarantee the #868 fix depends on: that AsyncLocalStorage
// restores the originating async context when the runtime invokes a global
// `unhandledRejection` / `uncaughtException` handler. Asserting this in-runner
// is impossible (bun's test runner intercepts uncaught faults and fails the
// test), so we probe it in an isolated child — preferring `node`, the worker's
// actual runtime.
function probeFaultAttribution(
	event: "unhandledRejection" | "uncaughtException",
): string {
	const fault =
		event === "unhandledRejection"
			? `Promise.resolve().then(() => Promise.reject(new Error("boom")));`
			: `setTimeout(() => { throw new Error("boom"); }, 1);`;
	const script = `
		const { AsyncLocalStorage } = require("node:async_hooks");
		const als = new AsyncLocalStorage();
		process.on(${JSON.stringify(event)}, () => {
			process.stdout.write(String(als.getStore()?.sessionId));
			process.exit(0);
		});
		als.run({ sessionId: "S-child" }, () => { ${fault} });
		setTimeout(() => { process.stdout.write("TIMEOUT"); process.exit(1); }, 2000);
	`;
	let res = spawnSync("node", ["-e", script], { encoding: "utf8" });
	if (res.error) {
		// `node` not on PATH — fall back to the runtime running this test.
		res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
	}
	return res.stdout.trim();
}

// The #868 cascade fix relies on the session id propagating through the async
// continuations the SDK spawns inside `sessionContext.run`, so the worker's
// fatal handler can attribute a detached fault to the right session. Guard
// that the context survives awaits/timers (the propagation our fix assumes).
describe("sessionContext", () => {
	test("propagates the session id across awaits and timers", async () => {
		let captured: string | undefined;
		await sessionContext.run({ sessionId: "session-A" }, async () => {
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 1));
			captured = sessionContext.getStore()?.sessionId;
		});
		expect(captured).toBe("session-A");
	});

	test("isolates concurrent runs", async () => {
		const seen: string[] = [];
		const run = (id: string) =>
			sessionContext.run({ sessionId: id }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				seen.push(sessionContext.getStore()?.sessionId ?? "none");
			});
		await Promise.all([run("A"), run("B")]);
		expect(seen.sort()).toEqual(["A", "B"]);
	});

	test("has no store outside a run", () => {
		expect(sessionContext.getStore()).toBeUndefined();
	});

	// The load-bearing path: a detached task that rejects/throws must surface
	// its originating session to the process-level fatal handler (probed in an
	// isolated process — see `probeFaultAttribution`).
	test("attributes a detached rejection to its session (isolated process)", () => {
		expect(probeFaultAttribution("unhandledRejection")).toBe("S-child");
	});

	test("attributes a detached throw to its session (isolated process)", () => {
		expect(probeFaultAttribution("uncaughtException")).toBe("S-child");
	});
});

describe("fatalScope", () => {
	test("an auth fault with attribution scopes to that session", () => {
		expect(fatalScope(true, "S2", ["S1", "S2", "S3"])).toEqual({
			kind: "session",
			sessionId: "S2",
		});
	});

	// The #868-review guard: a connection-level (network) reset must NOT be
	// mis-attributed to one session — that would leave the real victims hung.
	test("a non-auth fault fails all when multiple turns are live", () => {
		expect(fatalScope(false, "S1", ["S1", "S2"])).toEqual({ kind: "all" });
	});

	test("an auth fault without attribution falls back to all (multi-turn)", () => {
		expect(fatalScope(true, undefined, ["S1", "S2"])).toEqual({ kind: "all" });
	});

	test("a lone live turn is scoped to it regardless of cause", () => {
		expect(fatalScope(false, undefined, ["only"])).toEqual({
			kind: "session",
			sessionId: "only",
		});
	});

	test("no live turns → all", () => {
		expect(fatalScope(false, undefined, [])).toEqual({ kind: "all" });
	});
});
