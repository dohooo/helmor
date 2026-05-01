/**
 * Ghost-steer regression for `ClaudeSessionManager.steer()`.
 *
 * The race: the SDK emits ONE terminal `result` for the entire
 * streaming-input session (initial prompt + any `steer()` pushes fold
 * into one extended turn). The for-await loop bails on that result,
 * and the finally block closes `promptSource`. A `steer()` call whose
 * internal image-loading await straddles that boundary would — without
 * a post-await guard — emit a synthetic event into the pipeline (and
 * persist a DB row) with no assistant response behind it.
 *
 * Fix under test: `steer()` re-checks `promptSource.closed` AFTER any
 * internal async work, before emitting the synthetic event. If the
 * stream tore down during the await, the call quietly returns false.
 */

import { describe, expect, test } from "bun:test";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionManager } from "./claude-session-manager.js";
import type { SidecarEmitter } from "./emitter.js";
import { createPushable, type Pushable } from "./pushable-iterable.js";

/** Build the minimal SidecarEmitter that `steer()` touches — just
 *  `passthrough`. All other methods fail loudly so a test drift that
 *  starts calling them would be obvious. */
function makeSpyEmitter(): {
	emitter: SidecarEmitter;
	passthroughs: Array<{ requestId: string; message: object }>;
} {
	const passthroughs: Array<{ requestId: string; message: object }> = [];
	const emitter = {
		passthrough: (requestId: string, message: object) => {
			passthroughs.push({ requestId, message });
		},
	} as unknown as SidecarEmitter;
	return { emitter, passthroughs };
}

/** Minimal `Query` stub — `steer()` never invokes it. */
const queryStub = {} as unknown as Query;

/** Inject a fake live session into the manager. The `as any` is
 *  deliberately narrow: the test only touches public `steer()` which
 *  reads `sessions.get(...)` internally, and the returned map entry is
 *  structurally whatever `steer()` destructures. */
interface InjectedSession {
	query: Query;
	abortController: AbortController;
	promptSource: Pushable<SDKUserMessage>;
	requestId: string;
	emitter: SidecarEmitter;
}

function injectSession(
	manager: ClaudeSessionManager,
	sessionId: string,
	entry: InjectedSession,
): InjectedSession {
	// biome-ignore lint/suspicious/noExplicitAny: reach into private sessions map for test injection
	(manager as any).sessions.set(sessionId, entry);
	return entry;
}

describe("ClaudeSessionManager.steer ghost-steer guards", () => {
	test("returns false when promptSource is closed BEFORE the call", async () => {
		const manager = new ClaudeSessionManager();
		const { emitter, passthroughs } = makeSpyEmitter();
		const promptSource = createPushable<SDKUserMessage>();
		promptSource.close(); // simulate post-terminal-result state

		injectSession(manager, "s1", {
			query: queryStub,
			abortController: new AbortController(),
			promptSource,
			requestId: "rid-1",
			emitter,
		});

		const accepted = await manager.steer("s1", "ignored prompt", [], []);

		expect(accepted).toBe(false);
		expect(passthroughs).toHaveLength(0);
	});

	test("returns false when promptSource closes DURING the build await (image race)", async () => {
		const manager = new ClaudeSessionManager();
		const { emitter, passthroughs } = makeSpyEmitter();
		const promptSource = createPushable<SDKUserMessage>();

		injectSession(manager, "s1", {
			query: queryStub,
			abortController: new AbortController(),
			promptSource,
			requestId: "rid-1",
			emitter,
		});

		// Kick off a steer with an `@image` ref — this takes the
		// `buildUserMessageWithImages` branch, which has an internal
		// `await readImageWithResize(...)`. That await is our race
		// window. Pass the image via the structured `images` argument
		// (the parseImageRefs regex fallback no longer fires for steer
		// callers).
		const promise = manager.steer(
			"s1",
			"hey @/nonexistent-test-image.png",
			[],
			["/nonexistent-test-image.png"],
		);

		// While steer's image-load await is in flight, the streaming
		// loop terminates the turn — closes the prompt source before
		// steer resumes.
		promptSource.close();

		const accepted = await promise;

		// The post-await re-check must reject so no synthetic event
		// leaks into the pipeline — that's exactly the bug.
		expect(accepted).toBe(false);
		expect(passthroughs).toHaveLength(0);
	});

	test("plain-text steer on an open session still works (no false-positive lockout)", async () => {
		const manager = new ClaudeSessionManager();
		const { emitter, passthroughs } = makeSpyEmitter();
		const promptSource = createPushable<SDKUserMessage>();

		injectSession(manager, "s1", {
			query: queryStub,
			abortController: new AbortController(),
			promptSource,
			requestId: "rid-1",
			emitter,
		});

		const accepted = await manager.steer(
			"s1",
			"focus on failing tests",
			["src/foo.ts"],
			[],
		);

		expect(accepted).toBe(true);
		expect(passthroughs).toHaveLength(1);
		const [first] = passthroughs;
		if (!first) throw new Error("unreachable: already asserted length");
		expect(first.requestId).toBe("rid-1");
		expect(first.message).toEqual({
			type: "user_prompt",
			text: "focus on failing tests",
			steer: true,
			files: ["src/foo.ts"],
		});
	});
});

describe("ClaudeSessionManager.steer @-ref preservation", () => {
	/**
	 * The synthetic event's `text` MUST be the raw prompt, not the
	 * `parseImageRefs`-stripped version. `split_user_text_with_files`
	 * (both the Rust adapter and the frontend mirror) finds
	 * `@<path>` tokens by exact match — if we strip them the bubble
	 * loses its FileMention badges after the accumulator flush
	 * replaces the optimistic append. Same shape as
	 * `persist_user_message` writes for initial prompts.
	 */
	test("preserves image refs in synthetic event text", async () => {
		const manager = new ClaudeSessionManager();
		const { emitter, passthroughs } = makeSpyEmitter();
		const promptSource = createPushable<SDKUserMessage>();

		injectSession(manager, "s1", {
			query: queryStub,
			abortController: new AbortController(),
			promptSource,
			requestId: "rid-1",
			emitter,
		});

		await manager.steer("s1", "check this @/tmp/foo.png please", [], []);

		const [first] = passthroughs;
		if (!first) throw new Error("expected emit");
		// Image ref must still be in text. If the old
		// parseImageRefs-stripped version leaks back in, this reads
		// "check this  please" (double space + missing ref) and the
		// bubble loses every `@/image.png` on reload.
		expect(first.message).toMatchObject({
			type: "user_prompt",
			text: "check this @/tmp/foo.png please",
			steer: true,
		});
	});

	test("preserves file mention refs in synthetic event text", async () => {
		const manager = new ClaudeSessionManager();
		const { emitter, passthroughs } = makeSpyEmitter();
		const promptSource = createPushable<SDKUserMessage>();

		injectSession(manager, "s1", {
			query: queryStub,
			abortController: new AbortController(),
			promptSource,
			requestId: "rid-1",
			emitter,
		});

		await manager.steer(
			"s1",
			"review @src/foo.ts and @src/bar.ts",
			["src/foo.ts", "src/bar.ts"],
			[],
		);

		const [first] = passthroughs;
		if (!first) throw new Error("expected emit");
		// Both `@<file>` tokens AND the `files` array must be intact —
		// the adapter uses both to build FileMention parts.
		expect(first.message).toMatchObject({
			type: "user_prompt",
			text: "review @src/foo.ts and @src/bar.ts",
			steer: true,
			files: ["src/foo.ts", "src/bar.ts"],
		});
	});

	test("preserves mixed image + file + custom-tag inline text", async () => {
		const manager = new ClaudeSessionManager();
		const { emitter, passthroughs } = makeSpyEmitter();
		const promptSource = createPushable<SDKUserMessage>();

		injectSession(manager, "s1", {
			query: queryStub,
			abortController: new AbortController(),
			promptSource,
			requestId: "rid-1",
			emitter,
		});

		// The composer inlines custom-tag submitText into the prompt
		// before submit (see `$extractComposerContent`), so from the
		// sidecar's viewpoint they look like any other text. The steer
		// path must pass the whole thing through untouched.
		const raw = "@tasks:cleanup inspect @/img.png for @src/a.ts issues";
		await manager.steer("s1", raw, ["src/a.ts"], []);

		const [first] = passthroughs;
		if (!first) throw new Error("expected emit");
		expect((first.message as { text: string }).text).toBe(raw);
	});
});
