/**
 * SessionManager backed by the Cursor `agent` CLI (JSON-RPC over stdin/stdout).
 *
 * Spawns `agent --print --output-format stream-json --stream-partial-output`
 * for each turn, translating the CLI's streaming JSON into the Claude wire
 * format the Rust pipeline already understands. Auth is read automatically
 * from the local `agent login` session — no API key needed.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";
import type { SidecarEmitter } from "./emitter.js";
import { errorDetails, logger } from "./logger.js";
import type {
	GenerateTitleOptions,
	ListSlashCommandsParams,
	ProviderModelInfo,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
} from "./session-manager.js";

const CURSOR_AGENT_BIN = process.env.HELMOR_CURSOR_AGENT_BIN_PATH || "agent";

const CURSOR_MODELS: readonly ProviderModelInfo[] = [
	{
		id: "composer-2-fast",
		label: "Composer 2 Fast",
		cliModel: "composer-2-fast",
	},
	{ id: "composer-2", label: "Composer 2", cliModel: "composer-2" },
	{
		id: "claude-opus-4-7-thinking",
		label: "Opus 4.7 Thinking",
		cliModel: "claude-opus-4-7-thinking",
		effortLevels: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		id: "claude-4.6-opus",
		label: "Opus 4.6",
		cliModel: "claude-4.6-opus",
		effortLevels: ["high", "max"],
	},
	{
		id: "claude-4.6-sonnet-medium",
		label: "Sonnet 4.6",
		cliModel: "claude-4.6-sonnet-medium",
	},
	{
		id: "gpt-5.5",
		label: "Codex 5.5",
		cliModel: "gpt-5.5",
		effortLevels: ["medium", "high", "extra-high"],
	},
	{
		id: "gpt-5.4",
		label: "Codex 5.4",
		cliModel: "gpt-5.4",
		effortLevels: ["low", "medium", "high", "xhigh"],
	},
	{ id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", cliModel: "gemini-3.1-pro" },
];

// Models where effort is baked into the model ID as a suffix: <base>-<effort>
const CURSOR_EFFORT_BASE_IDS = new Set([
	"claude-opus-4-7-thinking",
	"claude-4.6-opus",
	"gpt-5.4",
	"gpt-5.5",
]);

interface ActiveSession {
	child: ChildProcessWithoutNullStreams;
	providerSessionId: string | null;
}

export class CursorSessionManager implements SessionManager {
	// Maps Helmor session ID → active child process + provider session ID
	readonly #sessions = new Map<string, ActiveSession>();

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		const baseModelId = params.model ?? "composer-2";
		const modelId =
			params.effortLevel && CURSOR_EFFORT_BASE_IDS.has(baseModelId)
				? `${baseModelId}-${params.effortLevel}`
				: baseModelId;
		const cwd = params.cwd ?? process.cwd();

		// Resolve provider session ID: prefer existing session over params.resume
		const existing = this.#sessions.get(params.sessionId);
		const providerSessionId =
			existing?.providerSessionId ?? params.resume ?? null;

		const args = buildAgentArgs({ modelId, cwd, providerSessionId, params });

		logger.debug(`[${requestId}] cursor sendMessage`, {
			model: modelId,
			cwd,
			resume: providerSessionId ?? "(none)",
		});

		const child = spawn(CURSOR_AGENT_BIN, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const session: ActiveSession = { child, providerSessionId };
		this.#sessions.set(params.sessionId, session);

		// Write prompt to stdin and close it so the CLI can start processing
		child.stdin.write(params.prompt);
		child.stdin.end();

		child.stderr.on("data", (chunk: Buffer) => {
			logger.debug(`[${requestId}] cursor agent stderr`, {
				data: chunk.toString().trim(),
			});
		});

		// Prime the Claude-format accumulator. The Rust pipeline expects
		// message_start + content_block_start before any deltas.
		emitter.passthrough(requestId, {
			type: "message_start",
			message: {
				type: "message",
				role: "assistant",
				content: [],
				model: modelId,
				id: `cursor-${requestId}`,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
		emitter.passthrough(requestId, {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		});

		let resultSeen = false;

		try {
			const rl = readline.createInterface({ input: child.stdout });

			for await (const line of rl) {
				if (!line.trim()) continue;

				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					logger.debug(`[${requestId}] cursor: unparseable stdout line`, {
						line: line.slice(0, 200),
					});
					continue;
				}

				const eventType = typeof event.type === "string" ? event.type : "";

				// Pass through system.init so Rust adopts the provider session ID
				if (eventType === "system") {
					emitter.passthrough(requestId, event);
					if (typeof event.session_id === "string") {
						session.providerSessionId = event.session_id;
					}
					continue;
				}

				// Streaming delta (has timestamp_ms) → translate to content_block_delta
				if (eventType === "assistant" && "timestamp_ms" in event) {
					const msg = event.message as Record<string, unknown> | undefined;
					const content = Array.isArray(msg?.content) ? msg.content : [];
					const text = (content as Array<Record<string, unknown>>)
						.filter((b) => b.type === "text")
						.map((b) => b.text as string)
						.join("");
					if (text) {
						emitter.passthrough(requestId, {
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text },
						});
					}
					continue;
				}

				// Final assistant message (no timestamp_ms) → pass through for persistence
				if (eventType === "assistant") {
					emitter.passthrough(requestId, event);
					continue;
				}

				// result → close the streaming block, pass through for persistence
				if (eventType === "result") {
					resultSeen = true;
					emitter.passthrough(requestId, {
						type: "content_block_stop",
						index: 0,
					});
					emitter.passthrough(requestId, {
						type: "message_delta",
						delta: { stop_reason: "end_turn", stop_sequence: null },
						usage: { output_tokens: 0 },
					});
					emitter.passthrough(requestId, { type: "message_stop" });
					emitter.passthrough(requestId, event);
					break;
				}

				// Pass through other events (user echo, tool events, etc.)
				emitter.passthrough(requestId, event);
			}

			// If the process ended without a result event, close the block so
			// Rust can finalize the accumulator. Skip if child was killed by
			// stopSession (we'll emit aborted below instead).
			if (!resultSeen && !child.killed) {
				emitter.passthrough(requestId, {
					type: "content_block_stop",
					index: 0,
				});
				emitter.passthrough(requestId, {
					type: "message_delta",
					delta: { stop_reason: "end_turn", stop_sequence: null },
					usage: { output_tokens: 0 },
				});
				emitter.passthrough(requestId, { type: "message_stop" });
			}
		} catch (err) {
			if (child.killed) {
				emitter.aborted(requestId, "user_requested");
				return;
			}
			logger.error(
				`[${requestId}] cursor sendMessage error`,
				errorDetails(err),
			);
			emitter.error(
				requestId,
				err instanceof Error ? err.message : String(err),
			);
			return;
		}

		// Wait for the child to exit
		const exitCode = await new Promise<number | null>((resolve) => {
			if (child.exitCode !== null) {
				resolve(child.exitCode);
				return;
			}
			child.once("exit", (code) => resolve(code));
			child.once("error", () => resolve(1));
		});

		// Keep session entry alive (with providerSessionId) for resume on the
		// next turn; only clear if a different child has since replaced this one.
		const s = this.#sessions.get(params.sessionId);
		if (s?.child === child) {
			this.#sessions.set(params.sessionId, {
				child,
				providerSessionId: s.providerSessionId,
			});
		}

		if (child.killed) {
			emitter.aborted(requestId, "user_requested");
		} else if (exitCode !== 0 && !resultSeen) {
			emitter.error(requestId, `Cursor agent exited with code ${exitCode}`);
		} else {
			emitter.end(requestId);
		}
	}

	async generateTitle(
		_requestId: string,
		_userMessage: string,
		_branchRenamePrompt: string | null,
		_emitter: SidecarEmitter,
		_timeoutMs?: number,
		_options?: GenerateTitleOptions,
	): Promise<void> {
		// index.ts routes title generation to claude/codex managers only.
		throw new Error(
			"Cursor does not support standalone title generation; use the Claude/Codex fallback",
		);
	}

	async listSlashCommands(
		_params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		return [];
	}

	async listModels(): Promise<readonly ProviderModelInfo[]> {
		return CURSOR_MODELS;
	}

	async stopSession(sessionId: string): Promise<void> {
		const session = this.#sessions.get(sessionId);
		if (session) {
			try {
				session.child.kill();
			} catch {
				// best-effort
			}
			this.#sessions.delete(sessionId);
		}
	}

	async steer(
		_sessionId: string,
		_prompt: string,
		_files: readonly string[],
	): Promise<boolean> {
		// Mid-turn steering is not supported — Cursor CLI runs one turn per invocation.
		return false;
	}

	async shutdown(): Promise<void> {
		for (const session of this.#sessions.values()) {
			try {
				session.child.kill();
			} catch {
				// best-effort
			}
		}
		this.#sessions.clear();
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentArgsInput {
	modelId: string;
	cwd: string;
	providerSessionId: string | null;
	params: SendMessageParams;
}

function buildAgentArgs(input: AgentArgsInput): string[] {
	const { modelId, cwd, providerSessionId, params } = input;
	const args = [
		"--print",
		"--output-format",
		"stream-json",
		"--stream-partial-output",
		"--workspace",
		cwd,
		"--trust", // Required for headless / non-interactive use
	];

	args.push("--model", modelId);

	if (providerSessionId) {
		args.push("--resume", providerSessionId);
	}

	if (params.permissionMode === "plan") {
		args.push("--mode", "plan");
	}

	if (params.permissionMode === "bypassPermissions") {
		args.push("--force");
	}

	return args;
}
