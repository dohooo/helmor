import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScriptEvent } from "@/lib/api";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Capture the event callback each `startScript` passes to `executeRepoScript`
// so tests can drive the stream synchronously without real IPC.

const apiMocks = vi.hoisted(() => ({
	executeRepoScript:
		vi.fn<
			(
				repoId: string,
				scriptType: "setup" | "run",
				onEvent: (event: ScriptEvent) => void,
				workspaceId?: string,
			) => Promise<void>
		>(),
	stopRepoScript: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		executeRepoScript: apiMocks.executeRepoScript,
		stopRepoScript: apiMocks.stopRepoScript,
	};
});

// Dynamic import so vi.mock is applied before module evaluation.
const {
	_resetForTesting,
	getScriptState,
	startScript,
	stopScript,
	TRUNCATION_NOTICE,
} = await import("./script-store");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Start a script and return the event-injector bound to that run. */
function startAndCapture(workspaceId = "ws1") {
	let injector: ((event: ScriptEvent) => void) | null = null;
	apiMocks.executeRepoScript.mockImplementationOnce(
		async (_repoId, _scriptType, onEvent) => {
			injector = onEvent;
			// Return a pending promise; we drive `exited` manually.
			await new Promise(() => {});
		},
	);
	startScript("repo1", "run", workspaceId);
	if (!injector)
		throw new Error("executeRepoScript mock did not capture handler");
	return injector as (event: ScriptEvent) => void;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const MAX_BYTES = 2 * 1024 * 1024;

beforeEach(() => {
	_resetForTesting();
	apiMocks.executeRepoScript.mockReset();
	apiMocks.stopRepoScript.mockReset();
});

describe("script-store ring buffer", () => {
	it("keeps every chunk when total stays under the cap", () => {
		const emit = startAndCapture();
		emit({ type: "stdout", data: "hello\n" });
		emit({ type: "stderr", data: "warn\n" });

		const entry = getScriptState("ws1", "run");
		expect(entry).not.toBeNull();
		expect(entry?.chunks).toEqual(["hello\n", "warn\n"]);
		expect(entry?.bufferedBytes).toBe(11);
		expect(entry?.truncated).toBe(false);
	});

	it("evicts head chunks once total exceeds the byte cap", () => {
		const emit = startAndCapture();
		const chunk = "x".repeat(700_000); // 700 KB
		for (let i = 0; i < 5; i++) emit({ type: "stdout", data: chunk });

		const entry = getScriptState("ws1", "run");
		expect(entry?.truncated).toBe(true);
		// Never exceed the cap after stabilizing (every push eventually shrinks).
		expect(entry?.bufferedBytes).toBeLessThanOrEqual(MAX_BYTES);
		// bufferedBytes stays in sync with the remaining chunks.
		const actualSum = entry?.chunks.reduce((n, c) => n + c.length, 0);
		expect(actualSum).toBe(entry?.bufferedBytes);
	});

	it("keeps a single oversized chunk rather than dropping it entirely", () => {
		const emit = startAndCapture();
		const huge = "y".repeat(MAX_BYTES + 1024); // single chunk > cap
		emit({ type: "stdout", data: huge });

		const entry = getScriptState("ws1", "run");
		// length > 1 guard means a lone oversized chunk survives.
		expect(entry?.chunks.length).toBe(1);
		expect(entry?.truncated).toBe(false);
		expect(entry?.bufferedBytes).toBe(huge.length);
	});

	it("resets truncated/bufferedBytes on a fresh startScript for the same workspace", () => {
		const emit1 = startAndCapture("ws1");
		const chunk = "z".repeat(700_000);
		for (let i = 0; i < 5; i++) emit1({ type: "stdout", data: chunk });
		expect(getScriptState("ws1", "run")?.truncated).toBe(true);

		// Second run reuses the same key.
		startAndCapture("ws1");
		const entry = getScriptState("ws1", "run");
		expect(entry?.truncated).toBe(false);
		expect(entry?.bufferedBytes).toBe(0);
		expect(entry?.chunks).toEqual([]);
	});

	it("also trims chunks appended through the `error` event path", () => {
		const emit = startAndCapture();
		const chunk = "w".repeat(700_000);
		for (let i = 0; i < 4; i++) emit({ type: "stdout", data: chunk });
		emit({ type: "error", message: "boom" });

		const entry = getScriptState("ws1", "run");
		expect(entry?.truncated).toBe(true);
		expect(entry?.status).toBe("exited");
		// Error message is still the *last* chunk — tail is never evicted.
		expect(entry?.chunks[entry.chunks.length - 1]).toContain("boom");
	});

	it("exposes a truncation notice for replay prefixing", () => {
		expect(TRUNCATION_NOTICE).toContain("truncated");
		// ANSI dim + reset so we don't leak styling into replayed chunks.
		expect(TRUNCATION_NOTICE).toContain("\x1b[2m");
		expect(TRUNCATION_NOTICE).toContain("\x1b[0m");
	});
});

describe("script-store userStopped tracking", () => {
	it("fresh entries start with userStopped=false", () => {
		startAndCapture();
		expect(getScriptState("ws1", "run")?.userStopped).toBe(false);
	});

	it("stopScript marks the entry as user-initiated", () => {
		startAndCapture();
		stopScript("repo1", "run", "ws1");
		expect(getScriptState("ws1", "run")?.userStopped).toBe(true);
	});

	it("a subsequent startScript clears userStopped", () => {
		startAndCapture();
		stopScript("repo1", "run", "ws1");
		expect(getScriptState("ws1", "run")?.userStopped).toBe(true);

		startAndCapture();
		expect(getScriptState("ws1", "run")?.userStopped).toBe(false);
	});
});
