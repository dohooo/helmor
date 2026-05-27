import { describe, expect, test } from "bun:test";
import type { OnNotification, OnRequest } from "./codex-app-server.js";
import { buildCodexAppServerArgs } from "./codex-app-server.js";
import {
	CodexAppServerManager,
	extractUserCommandText,
	parseGoalCommand,
} from "./codex-app-server-manager.js";
import { createSidecarEmitter } from "./emitter.js";

interface PendingRpc {
	method: string;
	params: unknown;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function threadGoal(
	status: "active" | "paused" | "budgetLimited" | "complete",
) {
	return {
		threadId: "thread-goal",
		objective: "finish the task",
		status,
		tokenBudget: null,
		tokensUsed: status === "complete" ? 42 : 7,
		timeUsedSeconds: 1,
		createdAt: 1,
		updatedAt: 2,
	};
}

function makeFakeServer() {
	let onNotification: OnNotification = () => {};
	let onRequest: OnRequest = () => {};
	const pending: PendingRpc[] = [];

	const api = {
		killed: false,
		setHandlers(n: OnNotification, r: OnRequest): void {
			onNotification = n;
			onRequest = r;
		},
		setActiveRequestId(_id: string): void {},
		async sendRequest<T>(method: string, params?: unknown): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				pending.push({
					method,
					params,
					resolve: resolve as (v: unknown) => void,
					reject,
				});
			});
		},
		sendResponse(_id: string | number, _result: unknown): void {},
		writeNotification(_method: string, _params?: unknown): void {},
		kill(): void {
			this.killed = true;
		},
	};

	return {
		server: api,
		pending,
		fireNotification(method: string, params?: Record<string, unknown>) {
			return onNotification({ method, params });
		},
		fireRequest(id: string, method: string, params?: Record<string, unknown>) {
			return onRequest({ id, method, params });
		},
		resolveNext(method: string, value: unknown): PendingRpc {
			const idx = pending.findIndex((p) => p.method === method);
			expect(idx).toBeGreaterThanOrEqual(0);
			const [p] = pending.splice(idx, 1);
			expect(p).toBeDefined();
			p?.resolve(value);
			return p as PendingRpc;
		},
	};
}

async function waitForPending(
	fake: ReturnType<typeof makeFakeServer>,
	method: string,
): Promise<PendingRpc> {
	for (let i = 0; i < 20; i++) {
		const pending = fake.pending.find((p) => p.method === method);
		if (pending) return pending;
		await tick();
	}
	throw new Error(`Timed out waiting for pending ${method}`);
}

async function driveGoalMessage(prompt: string) {
	const manager = new CodexAppServerManager();
	const fake = makeFakeServer();
	const events: object[] = [];
	const emitter = createSidecarEmitter((e) => events.push(e));

	// biome-ignore lint/suspicious/noExplicitAny: inject fake app-server context for protocol-level regression test
	(manager as any).sessions.set("session-goal", {
		server: fake.server,
		providerThreadId: "thread-goal",
		// Keep the fake context from being recycled; these tests exercise
		// the live-stream goal continuation loop, while the recycle path is
		// covered by sidecar/test/codex-app-server-manager.test.ts.
		activeTurnId: "skip-recycle",
		turnResolve: null,
		turnReject: null,
		activeRequestId: null,
		activeEmitter: null,
		notificationGate: null,
		lastSentModel: "",
		lastRetryAt: null,
		lastRetryNotice: null,
	});

	const sendMessagePromise = manager.sendMessage(
		"request-goal",
		{
			sessionId: "session-goal",
			prompt,
			model: undefined,
			cwd: undefined,
			resume: undefined,
			effortLevel: undefined,
			permissionMode: undefined,
			fastMode: undefined,
			images: [],
		},
		emitter,
	);
	await tick();
	await tick();

	return { fake, events, sendMessagePromise };
}

describe("Codex app-server goal integration", () => {
	test("spawns codex app-server with goals enabled at the process boundary", () => {
		expect(buildCodexAppServerArgs()).toEqual([
			"app-server",
			"--enable",
			"goals",
			"-c",
			"notify=[]",
		]);
	});

	test("parses wrapped Helmor prompts exactly as user slash commands", () => {
		expect(
			extractUserCommandText("Agent context\n\nUser request:\n/goal ship it"),
		).toBe("/goal ship it");
		expect(parseGoalCommand("/goal")).toEqual({ kind: "status" });
		expect(parseGoalCommand("/goal status")).toEqual({ kind: "status" });
		expect(parseGoalCommand("/goal pause")).toEqual({ kind: "pause" });
		expect(parseGoalCommand("/goal clear")).toEqual({ kind: "clear" });
		expect(parseGoalCommand("/goal resume")).toEqual({ kind: "resume" });
		expect(parseGoalCommand("/goal ship it")).toEqual({
			kind: "set",
			objective: "ship it",
		});
	});

	test("keeps a /goal stream subscribed across Codex continuation turns until terminal status", async () => {
		const { fake, events, sendMessagePromise } = await driveGoalMessage(
			"/goal finish the task",
		);

		const initialSet = await waitForPending(fake, "thread/goal/set");
		expect(initialSet.params).toEqual({
			threadId: "thread-goal",
			objective: "finish the task",
		});
		fake.resolveNext("thread/goal/set", { goal: threadGoal("active") });
		await tick();

		await fake.fireNotification("turn/started", {
			threadId: "thread-goal",
			turn: { id: "turn-1" },
		});
		await fake.fireNotification("turn/completed", {
			threadId: "thread-goal",
			turn: { id: "turn-1" },
		});

		const firstStatusRead = await waitForPending(fake, "thread/goal/get");
		expect(firstStatusRead.params).toEqual({ threadId: "thread-goal" });
		fake.resolveNext("thread/goal/get", { goal: threadGoal("active") });
		await tick();

		const continuationSet = await waitForPending(fake, "thread/goal/set");
		expect(continuationSet.params).toEqual({
			threadId: "thread-goal",
			status: "active",
		});
		fake.resolveNext("thread/goal/set", { goal: threadGoal("active") });
		await tick();

		await fake.fireNotification("turn/started", {
			threadId: "thread-goal",
			turn: { id: "turn-2" },
		});
		await fake.fireNotification("turn/completed", {
			threadId: "thread-goal",
			turn: { id: "turn-2" },
		});

		const terminalStatusRead = await waitForPending(fake, "thread/goal/get");
		expect(terminalStatusRead.params).toEqual({ threadId: "thread-goal" });
		fake.resolveNext("thread/goal/get", { goal: threadGoal("complete") });

		await sendMessagePromise;

		expect(
			events.filter((e) => (e as { type?: string }).type === "end"),
		).toHaveLength(1);
		expect(
			fake.pending.filter((p) => p.method === "thread/goal/set"),
		).toHaveLength(0);
	});

	test("keeps a model-created goal subscribed across continuation turns until terminal status", async () => {
		const { fake, events, sendMessagePromise } = await driveGoalMessage(
			"Create a goal to finish the task and keep working until done.",
		);

		const initialTurn = await waitForPending(fake, "turn/start");
		expect(initialTurn.params).toMatchObject({ threadId: "thread-goal" });
		fake.resolveNext("turn/start", { turn: { id: "turn-1" } });
		await tick();

		await fake.fireNotification("turn/started", {
			threadId: "thread-goal",
			turn: { id: "turn-1" },
		});
		await fake.fireNotification("thread/goal/updated", {
			threadId: "thread-goal",
			turnId: "turn-1",
			goal: threadGoal("active"),
		});
		await fake.fireNotification("turn/completed", {
			threadId: "thread-goal",
			turn: { id: "turn-1" },
		});

		const firstStatusRead = await waitForPending(fake, "thread/goal/get");
		expect(firstStatusRead.params).toEqual({ threadId: "thread-goal" });
		fake.resolveNext("thread/goal/get", { goal: threadGoal("active") });
		await tick();

		const continuationSet = await waitForPending(fake, "thread/goal/set");
		expect(continuationSet.params).toEqual({
			threadId: "thread-goal",
			status: "active",
		});
		fake.resolveNext("thread/goal/set", { goal: threadGoal("active") });
		await tick();

		await fake.fireNotification("turn/started", {
			threadId: "thread-goal",
			turn: { id: "turn-2" },
		});
		await fake.fireNotification("turn/completed", {
			threadId: "thread-goal",
			turn: { id: "turn-2" },
		});

		const terminalStatusRead = await waitForPending(fake, "thread/goal/get");
		expect(terminalStatusRead.params).toEqual({ threadId: "thread-goal" });
		fake.resolveNext("thread/goal/get", { goal: threadGoal("complete") });

		await sendMessagePromise;

		expect(
			events.filter((e) => (e as { type?: string }).type === "end"),
		).toHaveLength(1);
	});

	test("routes /goal resume through the stream path so Codex continuation turns are observed", async () => {
		const { fake, sendMessagePromise } = await driveGoalMessage("/goal resume");

		const resumeSet = await waitForPending(fake, "thread/goal/set");
		expect(resumeSet.params).toEqual({
			threadId: "thread-goal",
			status: "active",
		});
		fake.resolveNext("thread/goal/set", { goal: threadGoal("active") });

		await fake.fireNotification("turn/started", {
			threadId: "thread-goal",
			turn: { id: "turn-resume" },
		});
		await fake.fireNotification("turn/completed", {
			threadId: "thread-goal",
			turn: { id: "turn-resume" },
		});

		await waitForPending(fake, "thread/goal/get");
		fake.resolveNext("thread/goal/get", { goal: threadGoal("complete") });
		await sendMessagePromise;
	});
});
