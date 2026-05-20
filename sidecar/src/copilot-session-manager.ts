/**
 * SessionManager backed by GitHub Copilot CLI in ACP mode.
 *
 * Spawns `copilot --acp` as a child process per session, communicates
 * via newline-delimited JSON-RPC 2.0 on stdin/stdout (the ACP transport).
 * Streaming SessionUpdate notifications are forwarded as `copilot/`-prefixed
 * passthrough events so the Rust accumulator can handle them uniformly.
 */

import {
	type ChildProcessWithoutNullStreams,
	execFile,
	spawn,
} from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { SidecarEmitter } from "./emitter.js";
import { errorDetails, logger } from "./logger.js";
import { listProviderModels } from "./model-catalog.js";
import type {
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
	UserInputResolution,
} from "./session-manager.js";

function resolveCopilotBinPath(): string {
	const override = process.env.HELMOR_COPILOT_BIN_PATH;
	if (override && existsSync(override)) return override;
	return "copilot";
}

const COPILOT_BIN_PATH = resolveCopilotBinPath();

interface AcpPendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

interface CopilotSession {
	child: ChildProcessWithoutNullStreams;
	sessionId: string | null;
	pendingRequests: Map<number, AcpPendingRequest>;
	nextId: number;
	activeRequestId: string | null;
	activeEmitter: SidecarEmitter | null;
	aborted: boolean;
	modelId: string;
}

const ACP_REQUEST_TIMEOUT_MS = 30_000;

export class CopilotSessionManager implements SessionManager {
	private sessions = new Map<string, CopilotSession>();
	private pendingPermissions = new Map<
		string,
		{ helmorSessionId: string; jsonRpcId: number }
	>();

	resolveUserInput(
		_userInputId: string,
		_resolution: UserInputResolution,
	): boolean {
		return false;
	}

	resolvePermission(permissionId: string, behavior: "allow" | "deny"): void {
		const pending = this.pendingPermissions.get(permissionId);
		if (!pending) return;
		this.pendingPermissions.delete(permissionId);

		const ctx = this.sessions.get(pending.helmorSessionId);
		if (!ctx) return;

		const result = { approved: behavior === "allow" };
		this.sendJsonRpcResponse(ctx, pending.jsonRpcId, result);
		logger.debug("Copilot permission resolved", { permissionId, behavior });
	}

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		const { sessionId, prompt, model, cwd, effortLevel } = params;
		const workDir = cwd ?? process.cwd();
		const modelId = model ?? "gpt-4o";

		let ctx = this.sessions.get(sessionId);
		if (!ctx) {
			try {
				ctx = await this.spawnSession(sessionId, workDir, modelId, effortLevel);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				logger.error(
					`[${requestId}] Copilot spawn failed: ${msg}`,
					errorDetails(error),
				);
				emitter.error(requestId, `Copilot: ${msg}`);
				emitter.end(requestId);
				return;
			}
		}

		ctx.activeRequestId = requestId;
		ctx.activeEmitter = emitter;
		ctx.aborted = false;
		ctx.modelId = modelId;

		emitter.passthrough(requestId, {
			type: "copilot/session_init",
			session_id: ctx.sessionId ?? sessionId,
			model: modelId,
		});

		try {
			if (effortLevel) {
				try {
					await this.sendAcpRequest(ctx, "unstable_setSessionModel", {
						sessionId: ctx.sessionId,
						model: modelId,
						options: { effort: effortLevel },
					});
				} catch {
					// unstable — best effort
				}
			}

			emitter.passthrough(requestId, {
				type: "copilot/status",
				status: "RUNNING",
			});

			await this.sendAcpRequest(ctx, "prompt", {
				sessionId: ctx.sessionId,
				prompt: [{ type: "text", text: prompt }],
			});

			emitter.passthrough(requestId, {
				type: "copilot/status",
				status: "FINISHED",
			});
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (ctx.aborted) {
				logger.debug(`[${requestId}] Copilot stream aborted by user`);
			} else {
				logger.error(
					`[${requestId}] Copilot prompt failed: ${msg}`,
					errorDetails(error),
				);
				emitter.error(requestId, `Copilot: ${msg}`);
			}
		} finally {
			ctx.activeRequestId = null;
			ctx.activeEmitter = null;
		}

		if (ctx.aborted) {
			emitter.aborted(requestId, "user_requested");
		}
		emitter.end(requestId);
	}

	async generateTitle(
		_requestId: string,
		_userMessage: string,
		_branchRenamePrompt: string | null,
		_emitter: SidecarEmitter,
		_timeoutMs?: number,
		_options?: GenerateTitleOptions,
	): Promise<void> {
		// Copilot doesn't have a lightweight title-gen path; delegate to
		// Claude/Codex via the fallback chain in index.ts by throwing.
		throw new Error("Copilot does not support title generation");
	}

	async listSlashCommands(
		_params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		return [];
	}

	async listModels(_opts?: {
		apiKey?: string;
	}): Promise<readonly ProviderModelInfo[]> {
		try {
			const token = await this.getGhToken();
			if (!token) throw new Error("No gh auth token available");

			const response = await fetch(
				"https://api.individual.githubcopilot.com/models",
				{
					headers: {
						Authorization: `Bearer ${token}`,
						"Copilot-Integration-Id": "copilot-developer-cli",
					},
					signal: AbortSignal.timeout(15_000),
				},
			);

			if (!response.ok) {
				throw new Error(`Copilot API returned ${response.status}`);
			}

			const body = (await response.json()) as {
				data?: Array<{
					id: string;
					name: string;
					model_picker_enabled?: boolean;
					model_picker_category?: string;
					capabilities?: {
						type?: string;
						supports?: { reasoning_effort?: string[] };
					};
				}>;
			};

			const models = (body.data ?? []).filter(
				(m) =>
					m.model_picker_enabled === true &&
					(m.capabilities?.type === "chat" || !m.capabilities?.type),
			);

			if (models.length > 0) {
				return models.map((m) => ({
					id: m.id,
					label: m.name,
					cliModel: m.id,
					effortLevels:
						m.capabilities?.supports?.reasoning_effort?.filter(
							(e) => e !== "none",
						) ?? [],
				}));
			}
		} catch (err) {
			logger.debug(
				`Copilot API models fetch failed, using static catalog: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return listProviderModels("copilot");
	}

	private ghTokenCache: { token: string; expiresAt: number } | null = null;

	private async getGhToken(): Promise<string | null> {
		if (this.ghTokenCache && this.ghTokenCache.expiresAt > Date.now()) {
			return this.ghTokenCache.token;
		}
		try {
			const ghPath = process.env.HELMOR_GH_BIN_PATH || "gh";
			const result = await promisify(execFile)(ghPath, ["auth", "token"], {
				timeout: 5_000,
			});
			const token = result.stdout.trim();
			if (token) {
				this.ghTokenCache = {
					token,
					expiresAt: Date.now() + 5 * 60 * 1000,
				};
				return token;
			}
		} catch {
			// gh not available or not logged in
		}
		return null;
	}

	async stopSession(sessionId: string): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;
		ctx.aborted = true;

		if (ctx.sessionId) {
			try {
				this.sendJsonRpcNotification(ctx, "cancel", {
					sessionId: ctx.sessionId,
				});
			} catch {
				// best effort
			}
		}
	}

	async steer(
		_sessionId: string,
		_prompt: string,
		_files: readonly string[],
		_images: readonly string[],
	): Promise<boolean> {
		return false;
	}

	async shutdown(): Promise<void> {
		for (const [, ctx] of this.sessions) {
			try {
				ctx.child.kill("SIGTERM");
			} catch {
				// already dead
			}
		}
		this.sessions.clear();
	}

	// ── Private helpers ─────────────────────────────────────────────────

	private async spawnSession(
		helmorSessionId: string,
		cwd: string,
		modelId: string,
		effortLevel?: string,
	): Promise<CopilotSession> {
		const args = ["--acp"];
		if (effortLevel) {
			args.push("--reasoning-effort", effortLevel);
		}
		const child = spawn(COPILOT_BIN_PATH, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		const ctx: CopilotSession = {
			child,
			sessionId: null,
			pendingRequests: new Map(),
			nextId: 1,
			activeRequestId: null,
			activeEmitter: null,
			aborted: false,
			modelId,
		};

		this.sessions.set(helmorSessionId, ctx);

		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			this.handleLine(helmorSessionId, ctx, line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			logger.debug(
				`[copilot:${helmorSessionId}] stderr: ${chunk.toString().trim()}`,
			);
		});

		child.on("exit", (code, signal) => {
			logger.info(`[copilot:${helmorSessionId}] exited`, { code, signal });
			this.sessions.delete(helmorSessionId);
			for (const [, req] of ctx.pendingRequests) {
				clearTimeout(req.timeout);
				req.reject(new Error(`Copilot process exited (code=${code})`));
			}
			ctx.pendingRequests.clear();
		});

		// Initialize ACP connection
		await this.sendAcpRequest(ctx, "initialize", {
			protocolVersion: "0.1",
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				permissions: { requestPermission: true },
			},
		});

		// Create a session
		const sessionResult = (await this.sendAcpRequest(ctx, "newSession", {
			cwd,
		})) as { sessionId?: string };

		ctx.sessionId = sessionResult?.sessionId ?? helmorSessionId;

		return ctx;
	}

	private handleLine(
		helmorSessionId: string,
		ctx: CopilotSession,
		line: string,
	): void {
		if (!line.trim()) return;

		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line);
		} catch {
			logger.debug(
				`[copilot:${helmorSessionId}] non-JSON line: ${line.slice(0, 100)}`,
			);
			return;
		}

		// JSON-RPC response (has `id` + `result` or `error`)
		if ("id" in msg && ("result" in msg || "error" in msg)) {
			const id = msg.id as number;
			const pending = ctx.pendingRequests.get(id);
			if (pending) {
				ctx.pendingRequests.delete(id);
				clearTimeout(pending.timeout);
				if ("error" in msg) {
					const err = msg.error as { message?: string };
					pending.reject(new Error(err?.message ?? "ACP error"));
				} else {
					pending.resolve(msg.result);
				}
			}
			return;
		}

		// JSON-RPC request from agent (has `id` + `method`)
		if ("id" in msg && "method" in msg) {
			this.handleAgentRequest(helmorSessionId, ctx, msg);
			return;
		}

		// JSON-RPC notification (has `method`, no `id`)
		if ("method" in msg && !("id" in msg)) {
			this.handleNotification(helmorSessionId, ctx, msg);
			return;
		}
	}

	private handleAgentRequest(
		helmorSessionId: string,
		ctx: CopilotSession,
		msg: Record<string, unknown>,
	): void {
		const method = msg.method as string;
		const id = msg.id as number;
		const params = (msg.params ?? {}) as Record<string, unknown>;

		if (method === "requestPermission" || method === "permissions/request") {
			const permissionId = `copilot-${helmorSessionId}-${id}`;
			this.pendingPermissions.set(permissionId, {
				helmorSessionId,
				jsonRpcId: id,
			});

			const toolName = (params.tool as string) ?? "unknown";
			const description = (params.description as string) ?? "";
			const toolInput = (params.input as Record<string, unknown>) ?? {};

			if (ctx.activeRequestId && ctx.activeEmitter) {
				ctx.activeEmitter.passthrough(ctx.activeRequestId, {
					type: "permissionRequest",
					permissionId,
					toolName,
					toolInput,
					title: toolName,
					description,
				});
			}
			return;
		}

		// Unknown agent request — auto-approve
		this.sendJsonRpcResponse(ctx, id, {});
	}

	private handleNotification(
		helmorSessionId: string,
		ctx: CopilotSession,
		msg: Record<string, unknown>,
	): void {
		const method = msg.method as string;
		const params = (msg.params ?? {}) as Record<string, unknown>;

		if (!ctx.activeRequestId || !ctx.activeEmitter) return;

		const requestId = ctx.activeRequestId;
		const emitter = ctx.activeEmitter;

		// Map ACP SessionUpdate notifications to copilot/ prefixed events
		switch (method) {
			case "sessionUpdate": {
				const update = params as { type?: string; [key: string]: unknown };
				const updateType = update.type ?? "unknown";

				switch (updateType) {
					case "agent_message_chunk":
						emitter.passthrough(requestId, {
							type: "copilot/assistant",
							text: (update.text as string) ?? "",
						});
						break;
					case "agent_thought_chunk":
						emitter.passthrough(requestId, {
							type: "copilot/thinking",
							text: (update.text as string) ?? "",
						});
						break;
					case "tool_call": {
						const callId = (update.callId as string) ?? `tc-${Date.now()}`;
						emitter.passthrough(requestId, {
							type: "copilot/tool_call_start",
							call_id: callId,
							name: (update.name as string) ?? "unknown",
							args: update.arguments ?? {},
						});
						if (update.result !== undefined) {
							emitter.passthrough(requestId, {
								type: "copilot/tool_call_end",
								call_id: callId,
								result: update.result,
								is_error: (update.isError as boolean) ?? false,
							});
						}
						break;
					}
					case "tool_call_update":
						emitter.passthrough(requestId, {
							type: "copilot/tool_call_update",
							call_id: (update.callId as string) ?? "",
							output: (update.output as string) ?? "",
						});
						break;
					case "plan":
						emitter.passthrough(requestId, {
							type: "copilot/plan",
							plan: update.plan ?? update.text ?? "",
						});
						break;
					case "available_commands_update":
						// Cache for listSlashCommands — no pipeline event needed
						break;
					case "current_mode_update":
						break;
					default:
						emitter.passthrough(requestId, {
							type: `copilot/${updateType}`,
							...update,
						});
				}
				break;
			}
			default:
				logger.debug(
					`[copilot:${helmorSessionId}] unhandled notification: ${method}`,
				);
		}
	}

	private sendAcpRequest(
		ctx: CopilotSession,
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ctx.nextId++;
			const timeout = setTimeout(() => {
				ctx.pendingRequests.delete(id);
				reject(new Error(`ACP request '${method}' timed out`));
			}, ACP_REQUEST_TIMEOUT_MS);

			ctx.pendingRequests.set(id, { resolve, reject, timeout });

			const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
			try {
				ctx.child.stdin.write(`${msg}\n`);
			} catch (err) {
				ctx.pendingRequests.delete(id);
				clearTimeout(timeout);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	private sendJsonRpcResponse(
		ctx: CopilotSession,
		id: number,
		result: unknown,
	): void {
		const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
		try {
			ctx.child.stdin.write(`${msg}\n`);
		} catch {
			// pipe closed
		}
	}

	private sendJsonRpcNotification(
		ctx: CopilotSession,
		method: string,
		params: Record<string, unknown>,
	): void {
		const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
		try {
			ctx.child.stdin.write(`${msg}\n`);
		} catch {
			// pipe closed
		}
	}
}
