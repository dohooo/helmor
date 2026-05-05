import { beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createSidecarEmitter, type SidecarEmitter } from "../src/emitter.js";

process.env.HELMOR_LOG_DIR = resolve(tmpdir(), "helmor-sidecar-test-logs");

type RequestRecord = {
	method: string;
	params: unknown;
};

const serverState = {
	requests: [] as RequestRecord[],
	onNotification: null as
		| null
		| ((notification: { method: string; params?: unknown }) => void),
	onExit: null as null | ((code: number | null, signal: string | null) => void),
	/** Optional hook tests use to inject extra notifications between
	 *  `turn/started` and `turn/completed` (e.g. `thread/tokenUsage/updated`). */
	beforeTurnCompleted: null as null | (() => void),
	exitAfterTurnStarted: false,
	instances: [] as MockCodexAppServer[],
};
const gitAccessState = {
	directories: [] as string[],
};
const codexConfigState = {
	result: {
		kind: "alreadyEnabled" as "alreadyEnabled" | "modified",
		path: "/fake/.codex/config.toml",
	},
	calls: 0,
};

class MockCodexAppServer {
	killed = false;

	constructor(opts: {
		onExit: (code: number | null, signal: string | null) => void;
	}) {
		serverState.onExit = opts.onExit;
		serverState.instances.push(this);
	}

	async sendRequest(method: string, params: unknown): Promise<unknown> {
		serverState.requests.push({ method, params });

		if (method === "initialize") return {};
		if (method === "thread/start") {
			return { thread: { id: "thread-1" } };
		}
		if (method === "thread/resume") {
			const threadId =
				(params as { threadId?: string } | undefined)?.threadId ??
				"thread-resumed";
			return { thread: { id: threadId } };
		}
		if (method === "thread/goal/set") {
			queueMicrotask(() => {
				serverState.onNotification?.({
					method: "turn/started",
					params: { turn: { id: "turn-goal-1" } },
				});
				serverState.onNotification?.({
					method: "turn/completed",
					params: { turn: { id: "turn-goal-1" } },
				});
			});
			return {};
		}
		if (method === "turn/start") {
			queueMicrotask(() => {
				serverState.onNotification?.({
					method: "turn/started",
					params: { turn: { id: "turn-1" } },
				});
				if (serverState.exitAfterTurnStarted) {
					serverState.onExit?.(1, null);
					return;
				}
				serverState.beforeTurnCompleted?.();
				serverState.onNotification?.({
					method: "turn/completed",
					params: { turn: { id: "turn-1" } },
				});
			});
			return {};
		}
		return {};
	}

	writeNotification(_method: string, _params?: unknown): void {}
	setHandlers(
		onNotification: (notification: {
			method: string;
			params?: unknown;
		}) => void,
		_onRequest: unknown,
	): void {
		serverState.onNotification = onNotification;
	}

	setActiveRequestId(_id: string): void {}

	sendResponse(_requestId: string | number, _result: unknown): void {}
	kill(): void {
		this.killed = true;
	}
}

mock.module("../src/codex-app-server.js", () => ({
	CodexAppServer: MockCodexAppServer,
}));

mock.module("../src/git-access.js", () => ({
	resolveGitAccessDirectories: async () => [...gitAccessState.directories],
}));

mock.module("../src/codex-config.js", () => ({
	ensureCodexGoalsFeatureEnabled: async () => {
		codexConfigState.calls += 1;
		return { ...codexConfigState.result };
	},
	codexConfigPath: () => codexConfigState.result.path,
}));

const { CodexAppServerManager } = await import(
	"../src/codex-app-server-manager.js"
);

describe("CodexAppServerManager", () => {
	let emitter: SidecarEmitter;

	beforeEach(() => {
		serverState.requests = [];
		serverState.onNotification = null;
		serverState.onExit = null;
		serverState.beforeTurnCompleted = null;
		serverState.exitAfterTurnStarted = false;
		serverState.instances = [];
		gitAccessState.directories = [];
		codexConfigState.result = {
			kind: "alreadyEnabled",
			path: "/fake/.codex/config.toml",
		};
		codexConfigState.calls = 0;
		emitter = createSidecarEmitter(() => {});
	});

	test("returns the hardcoded model list", async () => {
		const manager = new CodexAppServerManager();

		const models = await manager.listModels();

		expect(models).toHaveLength(6);
		expect(models).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "gpt-5.5",
					supportsFastMode: true,
				}),
				expect.objectContaining({
					id: "gpt-5.4",
					supportsFastMode: true,
				}),
				expect.objectContaining({
					id: "gpt-5.4-mini",
					supportsFastMode: true,
				}),
			]),
		);
		expect(serverState.requests).toEqual([]);
	});

	test("forwards service tier when fast mode is enabled for a codex model", async () => {
		const manager = new CodexAppServerManager();

		await manager.sendMessage(
			"REQ-fast-codex",
			{
				sessionId: "session-1",
				prompt: "hello",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "high",
				fastMode: true,
				images: [],
			},
			emitter,
		);

		const threadStart = serverState.requests.find(
			(request) => request.method === "thread/start",
		);
		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);

		expect(threadStart?.params).toEqual(
			expect.objectContaining({ serviceTier: "fast" }),
		);
		expect(turnStart?.params).toEqual(
			expect.objectContaining({ serviceTier: "fast" }),
		);
	});

	test("plan mode with additionalDirectories sets sandboxPolicy writableRoots including cwd", async () => {
		const manager = new CodexAppServerManager();
		gitAccessState.directories = ["/git/worktree-meta", "/git/common"];

		await manager.sendMessage(
			"REQ-plan-writable",
			{
				sessionId: "session-plan",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp/workspace",
				resume: undefined,
				permissionMode: "plan",
				effortLevel: "medium",
				fastMode: false,
				images: [],
				// Include cwd explicitly to verify dedupe, and a duplicate
				// `/tmp/a` to verify we keep the first occurrence only.
				additionalDirectories: ["/tmp/workspace", "/tmp/a", "/tmp/a", "/tmp/b"],
			},
			emitter,
		);

		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);

		expect(turnStart?.params).toEqual(
			expect.objectContaining({
				sandboxPolicy: {
					type: "workspaceWrite",
					writableRoots: [
						"/tmp/workspace",
						"/tmp/a",
						"/tmp/b",
						"/git/worktree-meta",
						"/git/common",
					],
					networkAccess: false,
				},
			}),
		);
	});

	test("plan mode without additionalDirectories sets sandboxPolicy for cwd", async () => {
		const manager = new CodexAppServerManager();

		await manager.sendMessage(
			"REQ-plan-noextras",
			{
				sessionId: "session-plan-noextras",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp/workspace",
				resume: undefined,
				permissionMode: "plan",
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);

		expect(turnStart?.params).toEqual(
			expect.objectContaining({
				sandboxPolicy: {
					type: "workspaceWrite",
					writableRoots: ["/tmp/workspace"],
					networkAccess: false,
				},
			}),
		);
	});

	test("non-plan modes restore dangerFullAccess sandboxPolicy", async () => {
		const manager = new CodexAppServerManager();

		await manager.sendMessage(
			"REQ-bypass-noop",
			{
				sessionId: "session-bypass",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: "medium",
				fastMode: false,
				images: [],
				additionalDirectories: ["/tmp/a"],
			},
			emitter,
		);

		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);

		expect(turnStart?.params).toEqual(
			expect.objectContaining({
				sandboxPolicy: {
					type: "dangerFullAccess",
				},
			}),
		);
	});

	test("prepends a linked-directories preamble to the turn input", async () => {
		const manager = new CodexAppServerManager();

		await manager.sendMessage(
			"REQ-preamble",
			{
				sessionId: "session-preamble",
				prompt: "summarize what's in these projects",
				model: "gpt-5.4",
				cwd: "/tmp/workspace",
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: "medium",
				fastMode: false,
				images: [],
				additionalDirectories: ["/abs/alpha", "/abs/bravo"],
			},
			emitter,
		);

		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);
		const input = (turnStart?.params as { input?: Array<{ text?: string }> })
			?.input;
		const firstText = input?.[0]?.text ?? "";
		// Preamble references the linked paths, and the original user prompt
		// is still in there (after the preamble).
		expect(firstText).toContain("/abs/alpha");
		expect(firstText).toContain("/abs/bravo");
		expect(firstText).toContain("summarize what's in these projects");
	});

	test("does not touch the user prompt when no directories are linked", async () => {
		const manager = new CodexAppServerManager();

		await manager.sendMessage(
			"REQ-no-preamble",
			{
				sessionId: "session-no-preamble",
				prompt: "hello",
				model: "gpt-5.4",
				cwd: "/tmp/workspace",
				resume: undefined,
				permissionMode: "bypassPermissions",
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);
		const input = (turnStart?.params as { input?: Array<{ text?: string }> })
			?.input;
		expect(input?.[0]?.text).toBe("hello");
	});

	test("includes resolved git access directories in the linked-directories preamble", async () => {
		const manager = new CodexAppServerManager();
		gitAccessState.directories = ["/git/worktree-meta", "/git/common"];

		await manager.sendMessage(
			"REQ-git-preamble",
			{
				sessionId: "session-git-preamble",
				prompt: "check repo state",
				model: "gpt-5.4",
				cwd: "/tmp/workspace",
				resume: undefined,
				permissionMode: "plan",
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		const turnStart = serverState.requests.find(
			(request) => request.method === "turn/start",
		);
		const input = (turnStart?.params as { input?: Array<{ text?: string }> })
			?.input;
		const firstText = input?.[0]?.text ?? "";

		expect(firstText).toContain("/git/worktree-meta");
		expect(firstText).toContain("/git/common");
		expect(firstText).toContain("check repo state");
	});

	test("normalizes thread/tokenUsage/updated into contextUsageUpdated emit", async () => {
		const manager = new CodexAppServerManager();
		const events: Array<Record<string, unknown>> = [];
		const capturingEmitter = createSidecarEmitter((event) => {
			events.push(event as Record<string, unknown>);
		});

		serverState.beforeTurnCompleted = () => {
			serverState.onNotification?.({
				method: "thread/tokenUsage/updated",
				params: {
					tokenUsage: {
						total: { totalTokens: 35_000 },
						last: { totalTokens: 17_500 },
						modelContextWindow: 400_000,
					},
				},
			});
		};

		await manager.sendMessage(
			"REQ-usage",
			{
				sessionId: "session-codex-usage",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			capturingEmitter,
		);

		// `last.totalTokens` (not `total.totalTokens`) is the numerator; max
		// is `modelContextWindow`; percentage is rounded to 2 decimals.
		const ctxUsage = events.find((e) => e.type === "contextUsageUpdated");
		expect(ctxUsage).toBeDefined();
		expect(ctxUsage?.sessionId).toBe("session-codex-usage");
		expect(ctxUsage?.id).toBe("REQ-usage");
		const meta = JSON.parse(ctxUsage?.meta as string);
		expect(meta).toEqual({
			// Stamped from the sendMessage param, not the notification.
			modelId: "gpt-5.4",
			usedTokens: 17_500,
			maxTokens: 400_000,
			percentage: 4.38,
		});
	});

	test("skips contextUsageUpdated emit when tokenUsage payload is empty", async () => {
		const manager = new CodexAppServerManager();
		const events: Array<Record<string, unknown>> = [];
		const capturingEmitter = createSidecarEmitter((event) => {
			events.push(event as Record<string, unknown>);
		});

		// Zero tokens AND zero window — nothing meaningful to persist.
		serverState.beforeTurnCompleted = () => {
			serverState.onNotification?.({
				method: "thread/tokenUsage/updated",
				params: {
					tokenUsage: {
						last: { totalTokens: 0 },
						total: { totalTokens: 0 },
					},
				},
			});
		};

		await manager.sendMessage(
			"REQ-empty",
			{
				sessionId: "session-empty",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			capturingEmitter,
		);

		expect(
			events.find((e) => e.type === "contextUsageUpdated"),
		).toBeUndefined();
	});

	test("suppresses app-server errors when protocol says Codex will retry", async () => {
		const manager = new CodexAppServerManager();
		const events: Array<Record<string, unknown>> = [];
		const capturingEmitter = createSidecarEmitter((event) => {
			events.push(event as Record<string, unknown>);
		});

		serverState.beforeTurnCompleted = () => {
			serverState.onNotification?.({
				method: "error",
				params: {
					error: { message: "stream interrupted" },
					willRetry: true,
					threadId: "thread-1",
					turnId: "turn-1",
				},
			});
		};

		await manager.sendMessage(
			"REQ-retryable-error",
			{
				sessionId: "session-retryable-error",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			capturingEmitter,
		);

		expect(events.find((e) => e.type === "error")).toBeUndefined();
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "REQ-retryable-error",
					type: "heartbeat",
				}),
			]),
		);
	});

	test("emits app-server errors when protocol says Codex will not retry", async () => {
		const manager = new CodexAppServerManager();
		const events: Array<Record<string, unknown>> = [];
		const capturingEmitter = createSidecarEmitter((event) => {
			events.push(event as Record<string, unknown>);
		});

		serverState.beforeTurnCompleted = () => {
			serverState.onNotification?.({
				method: "error",
				params: {
					error: { message: "fatal app-server failure" },
					willRetry: false,
					threadId: "thread-1",
					turnId: "turn-1",
				},
			});
		};

		await manager.sendMessage(
			"REQ-terminal-error",
			{
				sessionId: "session-terminal-error",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			capturingEmitter,
		);

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "REQ-terminal-error",
					type: "error",
					message: "fatal app-server failure",
				}),
			]),
		);
	});

	test("settles an active turn when the app-server exits unexpectedly", async () => {
		const manager = new CodexAppServerManager();
		const events: Array<Record<string, unknown>> = [];
		const capturingEmitter = createSidecarEmitter((event) => {
			events.push(event as Record<string, unknown>);
		});
		serverState.exitAfterTurnStarted = true;

		const sendPromise = manager.sendMessage(
			"REQ-app-server-exit",
			{
				sessionId: "session-app-server-exit",
				prompt: "hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			capturingEmitter,
		);

		const result = await Promise.race([
			sendPromise.then(() => "settled" as const),
			new Promise<"timed-out">((resolve) => {
				setTimeout(() => resolve("timed-out"), 50);
			}),
		]);

		expect(result).toBe("settled");
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "REQ-app-server-exit",
					type: "error",
					message: "Codex app-server exited unexpectedly",
				}),
				expect.objectContaining({
					id: "REQ-app-server-exit",
					type: "end",
				}),
			]),
		);
		expect(events.find((e) => e.type === "aborted")).toBeUndefined();
	});
});

describe("parseGoalCommand", () => {
	test("returns null for non-/goal prompts", async () => {
		const { parseGoalCommand } = await import(
			"../src/codex-app-server-manager.js"
		);
		expect(parseGoalCommand("hello world")).toBeNull();
		expect(parseGoalCommand("/compact")).toBeNull();
		expect(parseGoalCommand("/goalish trick")).toBeNull();
	});

	test("returns null for bare /goal so the agent handles it", async () => {
		const { parseGoalCommand } = await import(
			"../src/codex-app-server-manager.js"
		);
		expect(parseGoalCommand("/goal")).toBeNull();
		expect(parseGoalCommand("  /goal  ")).toBeNull();
	});

	test("treats free-form text as the objective", async () => {
		const { parseGoalCommand } = await import(
			"../src/codex-app-server-manager.js"
		);
		expect(parseGoalCommand("/goal improve benchmark coverage")).toEqual({
			kind: "set",
			objective: "improve benchmark coverage",
		});
	});

	test("recognises /goal resume as the resume kind", async () => {
		const { parseGoalCommand } = await import(
			"../src/codex-app-server-manager.js"
		);
		expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
	});

	// Contract: pause/clear are NOT recognised by the sidecar parser. The
	// container-level intercept catches them BEFORE the prompt ever reaches
	// the sidecar — they're routed through `mutateCodexGoal` so they don't
	// pollute chat history. If this changes (e.g. parser starts returning
	// pause/clear variants), the container intercept must lose its short-
	// circuit too, or `/goal pause` will be both lifecycle-mutated AND
	// echoed as a chat user prompt.
	test("does NOT recognise /goal pause or /goal clear (handled by container intercept)", async () => {
		const { parseGoalCommand } = await import(
			"../src/codex-app-server-manager.js"
		);
		// Sidecar treats them as plain objectives if they ever arrive here.
		expect(parseGoalCommand("/goal pause")).toEqual({
			kind: "set",
			objective: "pause",
		});
		expect(parseGoalCommand("/goal clear")).toEqual({
			kind: "set",
			objective: "clear",
		});
	});
});

describe("CodexAppServerManager goal pre-flight", () => {
	let emitter: SidecarEmitter;

	beforeEach(() => {
		serverState.requests = [];
		serverState.onNotification = null;
		serverState.onExit = null;
		serverState.beforeTurnCompleted = null;
		serverState.exitAfterTurnStarted = false;
		serverState.instances = [];
		gitAccessState.directories = [];
		codexConfigState.result = {
			kind: "alreadyEnabled",
			path: "/fake/.codex/config.toml",
		};
		codexConfigState.calls = 0;
		emitter = createSidecarEmitter(() => {});
	});

	test("/goal pre-flight: no-op when codex config already enables goals", async () => {
		const manager = new CodexAppServerManager();
		codexConfigState.result = {
			kind: "alreadyEnabled",
			path: "/fake/.codex/config.toml",
		};

		await manager.sendMessage(
			"REQ-goal-noop",
			{
				sessionId: "s-goal-noop",
				prompt: "/goal review the diff",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		expect(codexConfigState.calls).toBe(1);
		expect(serverState.instances).toHaveLength(1);
		expect(serverState.instances[0]?.killed).toBe(false);
		const goalSet = serverState.requests.find(
			(r) => r.method === "thread/goal/set",
		);
		expect(goalSet?.params).toMatchObject({
			threadId: "thread-1",
			objective: "review the diff",
		});
	});

	test("/goal pre-flight: recycles stale codex and resumes its thread when toml had to be modified", async () => {
		const manager = new CodexAppServerManager();

		// Seed a session so a stale ctx exists for the recycle.
		codexConfigState.result = {
			kind: "alreadyEnabled",
			path: "/fake/.codex/config.toml",
		};
		await manager.sendMessage(
			"REQ-seed",
			{
				sessionId: "s-goal-recycle",
				prompt: "warm-up",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);
		expect(serverState.instances).toHaveLength(1);
		const stale = serverState.instances[0];

		// Pretend the helper had to flip the flag.
		codexConfigState.result = {
			kind: "modified",
			path: "/fake/.codex/config.toml",
		};
		serverState.requests = [];

		await manager.sendMessage(
			"REQ-goal-recycle",
			{
				sessionId: "s-goal-recycle",
				prompt: "/goal say hi",
				model: "gpt-5.4",
				cwd: "/tmp",
				// No caller resume → pre-flight reuses the stale thread.
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		expect(stale?.killed).toBe(true);
		expect(serverState.instances).toHaveLength(2);
		expect(serverState.instances[1]?.killed).toBe(false);

		const resume = serverState.requests.find(
			(r) => r.method === "thread/resume",
		);
		expect(resume?.params).toMatchObject({ threadId: "thread-1" });

		const goalSet = serverState.requests.find(
			(r) => r.method === "thread/goal/set",
		);
		expect(goalSet?.params).toMatchObject({
			threadId: "thread-1",
			objective: "say hi",
		});
	});

	test("/goal pre-flight: caller-provided resume wins over stale providerThreadId", async () => {
		const manager = new CodexAppServerManager();

		codexConfigState.result = {
			kind: "alreadyEnabled",
			path: "/fake/.codex/config.toml",
		};
		await manager.sendMessage(
			"REQ-seed-2",
			{
				sessionId: "s-goal-explicit",
				prompt: "warm-up",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		codexConfigState.result = {
			kind: "modified",
			path: "/fake/.codex/config.toml",
		};
		serverState.requests = [];

		// Caller's resume wins over the in-memory stale id.
		await manager.sendMessage(
			"REQ-goal-explicit",
			{
				sessionId: "s-goal-explicit",
				prompt: "/goal something",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: "thread-from-rust",
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		const resume = serverState.requests.find(
			(r) => r.method === "thread/resume",
		);
		expect(resume?.params).toMatchObject({ threadId: "thread-from-rust" });
	});

	test("/goal pre-flight: skipped for non-/goal prompts", async () => {
		const manager = new CodexAppServerManager();

		await manager.sendMessage(
			"REQ-plain",
			{
				sessionId: "s-plain",
				prompt: "just a regular question",
				model: "gpt-5.4",
				cwd: "/tmp",
				resume: undefined,
				permissionMode: undefined,
				effortLevel: "medium",
				fastMode: false,
				images: [],
			},
			emitter,
		);

		expect(codexConfigState.calls).toBe(0);
	});
});
