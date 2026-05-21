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
			emitter.passthrough(requestId, {
				type: "copilot/status",
				status: "RUNNING",
			});

			await this.sendAcpRequest(
				ctx,
				"session/prompt",
				{
					sessionId: ctx.sessionId,
					prompt: [{ type: "text", text: prompt }],
				},
				0,
			);

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
				this.sendJsonRpcNotification(ctx, "session/cancel", {
					sessionId: ctx.sessionId,
				});
			} catch {
				// best effort
			}
		}

		ctx.activeRequestId = null;
		ctx.activeEmitter = null;
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

		try {
			await this.sendAcpRequest(ctx, "initialize", {
				protocolVersion: 1,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
				},
			});

			const sessionResult = (await this.sendAcpRequest(ctx, "session/new", {
				cwd,
				mcpServers: [],
			})) as { sessionId?: string };

			ctx.sessionId = sessionResult?.sessionId ?? helmorSessionId;
		} catch (err) {
			try {
				child.kill("SIGTERM");
			} catch {
				// already dead
			}
			throw err;
		}

		this.sessions.set(helmorSessionId, ctx);
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

		if (method === "session/request_permission") {
			const permissionId = `copilot-${helmorSessionId}-${id}`;
			this.pendingPermissions.set(permissionId, {
				helmorSessionId,
				jsonRpcId: id,
			});

			const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
			const toolName =
				(toolCall.title as string) ?? (toolCall.kind as string) ?? "tool";
			const toolInput = (toolCall.rawInput as Record<string, unknown>) ?? {};

			if (ctx.activeRequestId && ctx.activeEmitter) {
				ctx.activeEmitter.passthrough(ctx.activeRequestId, {
					type: "permissionRequest",
					permissionId,
					toolName,
					toolInput,
					title: toolName,
					description: "",
				});
			}
			return;
		}

		if (method === "fs/read_text_file") {
			void this.handleFsReadTextFile(ctx, id, params);
			return;
		}

		if (method === "fs/write_text_file") {
			void this.handleFsWriteTextFile(ctx, id, params);
			return;
		}

		this.sendJsonRpcResponse(ctx, id, {});
	}

	private async handleFsReadTextFile(
		ctx: CopilotSession,
		id: number,
		params: Record<string, unknown>,
	): Promise<void> {
		const path = params.path as string;
		const line = params.line as number | undefined;
		const limit = params.limit as number | undefined;
		try {
			const fs = await import("node:fs/promises");
			let content = await fs.readFile(path, "utf-8");
			if (line !== undefined || limit !== undefined) {
				const lines = content.split("\n");
				const start = line ?? 0;
				const end = limit !== undefined ? start + limit : lines.length;
				content = lines.slice(start, end).join("\n");
			}
			this.sendJsonRpcResponse(ctx, id, { content });
		} catch (err) {
			this.sendJsonRpcError(ctx, id, {
				code: -32603,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async handleFsWriteTextFile(
		ctx: CopilotSession,
		id: number,
		params: Record<string, unknown>,
	): Promise<void> {
		const path = params.path as string;
		const content = params.content as string;
		try {
			const fs = await import("node:fs/promises");
			await fs.writeFile(path, content, "utf-8");
			this.sendJsonRpcResponse(ctx, id, {});
		} catch (err) {
			this.sendJsonRpcError(ctx, id, {
				code: -32603,
				message: err instanceof Error ? err.message : String(err),
			});
		}
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

		if (method !== "session/update") {
			logger.debug(
				`[copilot:${helmorSessionId}] unhandled notification: ${method}`,
			);
			return;
		}

		const update = (params.update ?? {}) as {
			sessionUpdate?: string;
			[key: string]: unknown;
		};
		const variant = update.sessionUpdate ?? "unknown";

		const extractText = (block: unknown): string => {
			if (!block || typeof block !== "object") return "";
			const b = block as { type?: string; text?: unknown };
			if (b.type === "text" && typeof b.text === "string") return b.text;
			return "";
		};

		switch (variant) {
			case "agent_message_chunk":
				emitter.passthrough(requestId, {
					type: "copilot/assistant",
					text: extractText(update.content),
				});
				break;
			case "agent_thought_chunk":
				emitter.passthrough(requestId, {
					type: "copilot/thinking",
					text: extractText(update.content),
				});
				break;
			case "user_message_chunk":
				break;
			case "tool_call": {
				const callId =
					(update.toolCallId as string) ??
					(update.callId as string) ??
					`tc-${Date.now()}`;
				emitter.passthrough(requestId, {
					type: "copilot/tool_call_start",
					call_id: callId,
					name: (update.title as string) ?? (update.kind as string) ?? "tool",
					args: update.rawInput ?? {},
				});
				const status = update.status as string | undefined;
				if (status === "completed" || status === "failed") {
					emitter.passthrough(requestId, {
						type: "copilot/tool_call_end",
						call_id: callId,
						result: update.content ?? update.rawOutput ?? null,
						is_error: status === "failed",
					});
				}
				break;
			}
			case "tool_call_update": {
				const callId =
					(update.toolCallId as string) ?? (update.callId as string) ?? "";
				const status = update.status as string | undefined;
				if (status === "completed" || status === "failed") {
					emitter.passthrough(requestId, {
						type: "copilot/tool_call_end",
						call_id: callId,
						result: update.content ?? update.rawOutput ?? null,
						is_error: status === "failed",
					});
				} else {
					emitter.passthrough(requestId, {
						type: "copilot/tool_call_update",
						call_id: callId,
						output:
							(update.content as string) ?? (update.rawOutput as string) ?? "",
					});
				}
				break;
			}
			case "plan":
				emitter.passthrough(requestId, {
					type: "copilot/plan",
					plan: update.entries ?? update.plan ?? [],
				});
				break;
			case "available_commands_update":
			case "current_mode_update":
				break;
			default:
				logger.debug(
					`[copilot:${helmorSessionId}] unhandled session/update variant: ${variant}`,
				);
		}
	}

	private sendAcpRequest(
		ctx: CopilotSession,
		method: string,
		params: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = ctx.nextId++;
			const effectiveTimeout = timeoutMs ?? ACP_REQUEST_TIMEOUT_MS;
			const timeout =
				effectiveTimeout > 0
					? setTimeout(() => {
							ctx.pendingRequests.delete(id);
							reject(new Error(`ACP request '${method}' timed out`));
						}, effectiveTimeout)
					: null;

			ctx.pendingRequests.set(id, {
				resolve,
				reject,
				timeout: timeout as ReturnType<typeof setTimeout>,
			});

			const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
			try {
				ctx.child.stdin.write(`${msg}\n`);
			} catch (err) {
				ctx.pendingRequests.delete(id);
				if (timeout) clearTimeout(timeout);
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

	private sendJsonRpcError(
		ctx: CopilotSession,
		id: number,
		error: { code: number; message: string },
	): void {
		const msg = JSON.stringify({ jsonrpc: "2.0", id, error });
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
