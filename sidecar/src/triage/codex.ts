import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, type JsonRpcNotification } from "../codex-app-server";
import {
	HELMOR_CLIENT_INFO,
	resolveCodexBinPath,
} from "../codex-app-server-manager";
import { callHost } from "../host-bridge";
import { errorDetails, logger } from "../logger";
import { pickFastestCodexModel } from "../model-catalog";
import { type CodexTriageDecision, parseCodexDecision } from "./codex-decision";
import { buildCodexTriageInput } from "./codex-input";
import type { TriageTickParams } from "./types";

export { parseCodexDecision } from "./codex-decision";

const CODEX_APPROVAL_POLICY = {
	granular: {
		sandbox_approval: false,
		rules: false,
		skill_approval: false,
		request_permissions: false,
		mcp_elicitations: false,
	},
} as const;

export function startCodexTriageTick(
	params: TriageTickParams,
	hooks: {
		emitProgress(payload: {
			turn?: number;
			tool?: string;
			argsPreview?: string;
		}): void;
	},
): {
	promise: Promise<CodexTriageDecision & { cancelled: boolean }>;
	abort(): void;
} {
	let server: CodexAppServer | null = null;
	let cancelled = false;

	const promise = runCodexTriageTick(params, hooks, {
		setServer(next) {
			server = next;
		},
		isCancelled() {
			return cancelled;
		},
	}).catch((error) => {
		if (cancelled) {
			return {
				proposals: [],
				skips: [],
				summary: "Triage tick stopped.",
				cancelled: true,
			};
		}
		throw error;
	});

	return {
		promise,
		abort() {
			cancelled = true;
			server?.kill();
		},
	};
}

async function runCodexTriageTick(
	params: TriageTickParams,
	hooks: {
		emitProgress(payload: {
			turn?: number;
			tool?: string;
			argsPreview?: string;
		}): void;
	},
	state: {
		setServer(server: CodexAppServer): void;
		isCancelled(): boolean;
	},
): Promise<CodexTriageDecision & { cancelled: boolean }> {
	const tickId = params.tickId || "(no-tick-id)";
	const logTag = `triage[${tickId}]`;
	const cwd = await mkdtemp(join(tmpdir(), "helmor-triage-codex-"));
	const model = pickFastestCodexModel();

	let server: CodexAppServer | null = null;
	try {
		const input = await buildCodexTriageInput(params, cwd);
		hooks.emitProgress({
			tool: "codex_triage",
			argsPreview: `${params.candidates.length} candidates`,
		});

		const finalTextParts: string[] = [];
		let finalText = "";
		let turnCompleted: (() => void) | null = null;
		let turnFailed: ((error: Error) => void) | null = null;

		server = new CodexAppServer({
			binaryPath: resolveCodexBinPath(),
			cwd,
			onNotification(notification) {
				handleCodexNotification(notification, {
					onTurnStarted() {
						hooks.emitProgress({ turn: 1 });
					},
					onDelta(delta) {
						finalTextParts.push(delta);
					},
					onFinalText(text) {
						finalText = text;
					},
					onComplete() {
						turnCompleted?.();
					},
					onError(error) {
						turnFailed?.(error);
					},
				});
			},
			onRequest(request) {
				server?.sendResponse(request.id, undefined);
			},
			onExit(_code, _signal) {
				if (!state.isCancelled()) {
					turnFailed?.(new Error("Codex app-server exited during triage"));
				}
			},
			onError(error) {
				turnFailed?.(error);
			},
		});
		state.setServer(server);

		await server.sendRequest("initialize", HELMOR_CLIENT_INFO);
		server.writeNotification("initialized");
		const thread = await server.sendRequest<Record<string, unknown>>(
			"thread/start",
			{
				cwd,
				model,
				approvalPolicy: CODEX_APPROVAL_POLICY,
				sandbox: "workspace-write",
				developerInstructions:
					"You are Helmor Smart Triage. Do not modify files. Return only the requested JSON object.",
			},
		);
		const threadId = getNestedString(thread, "thread", "id");
		if (!threadId) {
			throw new Error("Codex did not return a triage thread id");
		}

		await new Promise<void>((resolve, reject) => {
			turnCompleted = resolve;
			turnFailed = reject;
			void server
				?.sendRequest("turn/start", {
					threadId,
					model,
					input,
				})
				.catch(reject);
		});

		const text = finalText.trim() || finalTextParts.join("").trim();
		const decision = parseCodexDecision(text);
		await persistSkips(decision.skips);
		logger.info(`${logTag} codex.done`, {
			proposalCount: decision.proposals.length,
			skipCount: decision.skips.length,
			finalMessage: decision.summary,
		});
		return { ...decision, cancelled: false };
	} catch (error) {
		logger.error(`${logTag} codex failed`, errorDetails(error));
		throw error;
	} finally {
		server?.kill();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

function handleCodexNotification(
	notification: JsonRpcNotification,
	handlers: {
		onTurnStarted(): void;
		onDelta(delta: string): void;
		onFinalText(text: string): void;
		onComplete(): void;
		onError(error: Error): void;
	},
): void {
	const params =
		notification.params && typeof notification.params === "object"
			? (notification.params as Record<string, unknown>)
			: {};
	if (notification.method === "turn/started") {
		handlers.onTurnStarted();
		return;
	}
	if (notification.method === "item/agentMessage/delta") {
		const delta = params.delta;
		if (typeof delta === "string") handlers.onDelta(delta);
		return;
	}
	if (notification.method === "item/completed") {
		const item = params.item;
		if (item && typeof item === "object") {
			const obj = item as Record<string, unknown>;
			if (obj.type === "agentMessage" && typeof obj.text === "string") {
				handlers.onFinalText(obj.text);
			}
		}
		return;
	}
	if (notification.method === "turn/completed") {
		handlers.onComplete();
		return;
	}
	if (notification.method === "error") {
		const message =
			getNestedString(params, "error", "message") ?? "Codex triage failed";
		handlers.onError(new Error(message));
	}
}

async function persistSkips(
	skips: readonly { candidateId: string; reason: string }[],
): Promise<void> {
	await Promise.all(
		skips.map((skip) =>
			callHost<{ ok: boolean }>("triage.record_decision", {
				candidateId: skip.candidateId,
				decision: "skip",
				reason: skip.reason,
			}),
		),
	);
}

function getNestedString(obj: unknown, ...keys: string[]): string | null {
	let current = obj;
	for (const key of keys) {
		if (!current || typeof current !== "object") return null;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : null;
}
