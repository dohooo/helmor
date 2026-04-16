import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createSidecarEmitter, type SidecarEmitter } from "../src/emitter.js";

type RequestRecord = {
	method: string;
	params: unknown;
};

const serverState = {
	requests: [] as RequestRecord[],
	onNotification: null as
		| null
		| ((notification: { method: string; params?: unknown }) => void),
};

class MockCodexAppServer {
	killed = false;

	constructor(_opts: unknown) {}

	async sendRequest(method: string, params: unknown): Promise<unknown> {
		serverState.requests.push({ method, params });

		if (method === "initialize") return {};
		if (method === "model/list") {
			return {
				data: [
					{
						id: "gpt-5.4",
						model: "gpt-5.4",
						displayName: "GPT-5.4",
						supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
					},
					{
						id: "custom-nofast",
						model: "custom-nofast",
						displayName: "Custom No Fast",
						supportedReasoningEfforts: ["low", "medium"],
						supportsFastMode: false,
					},
				],
			};
		}
		if (method === "thread/start") {
			return { thread: { id: "thread-1" } };
		}
		if (method === "turn/start") {
			queueMicrotask(() => {
				serverState.onNotification?.({
					method: "turn/started",
					params: { turn: { id: "turn-1" } },
				});
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

const { CodexAppServerManager } = await import(
	"../src/codex-app-server-manager.js"
);

describe("CodexAppServerManager", () => {
	let emitter: SidecarEmitter;

	beforeEach(() => {
		serverState.requests = [];
		serverState.onNotification = null;
		emitter = createSidecarEmitter(() => {});
	});

	test("surfaces fast mode support in model list", async () => {
		const manager = new CodexAppServerManager();

		const models = await manager.listModels();

		expect(models).toEqual([
			expect.objectContaining({
				id: "gpt-5.4",
				supportsFastMode: true,
			}),
			expect.objectContaining({
				id: "custom-nofast",
				supportsFastMode: false,
			}),
		]);
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
});
