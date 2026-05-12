/** SessionManager backed by GitHub Copilot CLI's ACP server.
 *
 * One `copilot --acp` process is held per Helmor
 * session. ACP session updates are converted into a small `copilot/`
 * event vocabulary that Rust normalizes through the shared ACP-shape
 * accumulator (see `src-tauri/src/pipeline/accumulator/cursor.rs`).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	type Agent,
	type Client,
	ClientSideConnection,
	type ContentBlock,
	type ModelInfo,
	ndJsonStream,
	type PermissionOption,
	PROTOCOL_VERSION,
	type PromptRequest,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionMode,
	type SessionModelState,
	type SessionModeState,
	type SessionNotification,
	type SessionUpdate,
	type ToolCall,
	type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { buildCopilotStoredMeta } from "./context-usage.js";
import { scanCursorSkills } from "./cursor-skill-scanner.js";
import type { SidecarEmitter } from "./emitter.js";
import { readImageWithResize } from "./image-resize.js";
import { parseImageRefs } from "./images.js";
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

/// Hybrid bin discovery — same priority order Tauri uses for the
/// other agent CLIs: explicit env override → bundled vendor binary
/// (resolved relative to the sidecar entry point so `bun run dev` and
/// the compiled `helmor-sidecar` both work) → PATH lookup.
function resolveCopilotBinPath(): string {
	const envOverride = process.env.HELMOR_COPILOT_BIN_PATH?.trim();
	if (envOverride) return envOverride;

	// `import.meta.dir` resolves to the source dir under `bun run dev`
	// and to the bundle root under `bun build --compile`. The vendor
	// staging script (`scripts/stage-vendor.ts`) places the binary at
	// `dist/vendor/copilot/copilot` next to the sidecar executable.
	const candidates = [
		join(import.meta.dir, "..", "vendor", "copilot", "copilot"),
		join(import.meta.dir, "..", "dist", "vendor", "copilot", "copilot"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}

	return "copilot";
}

const COPILOT_BIN_PATH = resolveCopilotBinPath();

/// Sidecar version surfaced to the ACP server. Read once at module
/// load to keep `clientInfo` honest across releases without forcing
/// callers to thread the value through. Bundle layouts: package.json
/// sits one directory above the source file in `bun run dev` and one
/// above the compiled bundle.
const SIDECAR_VERSION = readSidecarVersion();

function readSidecarVersion(): string {
	const candidates = [
		join(import.meta.dir, "..", "package.json"),
		join(import.meta.dir, "..", "..", "package.json"),
	];
	for (const candidate of candidates) {
		try {
			if (!existsSync(candidate)) continue;
			const raw = readFileSync(candidate, "utf8");
			const parsed = JSON.parse(raw) as { version?: unknown };
			if (typeof parsed.version === "string") return parsed.version;
		} catch {
			// fall through
		}
	}
	return "0.0.0";
}

/// Upstream `@github/copilot` exposes the ACP server as a top-level
/// `--acp` flag. Keep this constant authoritative so future bumps stay
/// in sync with `copilot --help`.
export const COPILOT_ACP_ARGS = ["--acp"] as const;

/// No-op ACP client used for the lightweight model-probe session.
/// Probe sessions never send prompts, so all callbacks are empty stubs.
const NOOP_CLIENT: Client = {
	sessionUpdate: async () => {},
	requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
};

interface PendingPermission {
	sessionId: string;
	resolve: (response: RequestPermissionResponse) => void;
	options: readonly PermissionOption[];
}

interface CopilotSessionContext {
	child: ChildProcessWithoutNullStreams;
	agent: Agent;
	connection: ClientSideConnection;
	providerSessionId: string;
	cwd: string;
	additionalDirectories: string[];
	activeRequestId: string | null;
	activeEmitter: SidecarEmitter | null;
	activePermissionMode: string | undefined;
	currentPrompt: Promise<unknown> | null;
	aborted: boolean;
	/// ACP-reported state — populated from the `newSession`/`resumeSession`
	/// response and refreshed via `current_mode_update` / future
	/// `current_model_update` notifications. Drives composer pickers.
	availableModels: readonly ModelInfo[];
	currentModelId: string | null;
	availableModes: readonly SessionMode[];
	currentModeId: string | null;
}

export class CopilotAcpSessionManager implements SessionManager {
	private sessions = new Map<string, CopilotSessionContext>();
	private pendingPermissions = new Map<string, PendingPermission>();
	/// Last-known ACP model list across any spawned ACP child. Used as
	/// the source for `listModels()` so the composer picker can show
	/// real Copilot model IDs even before the user has sent a prompt.
	private lastKnownModels: readonly ModelInfo[] = [];
	/// Singleton probe promise — ensures only one temp ACP child runs
	/// at a time when `listModels()` is called concurrently cold.
	private probePromise: Promise<void> | null = null;

	resolvePermission(permissionId: string, behavior: "allow" | "deny"): void {
		const pending = this.pendingPermissions.get(permissionId);
		if (!pending) return;
		this.pendingPermissions.delete(permissionId);

		const option = pickPermissionOption(pending.options, behavior);
		if (!option) {
			pending.resolve({ outcome: { outcome: "cancelled" } });
			return;
		}
		pending.resolve({
			outcome: { outcome: "selected", optionId: option.optionId },
		});
	}

	resolveUserInput(
		_userInputId: string,
		_resolution: UserInputResolution,
	): boolean {
		return false;
	}

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		const cwd = params.cwd ?? process.cwd();
		const additionalDirectories = params.additionalDirectories ?? [];
		const ctx = await this.ensureContext(params.sessionId, cwd, params.resume, [
			...additionalDirectories,
		]);
		// ACP carries the linked-directory context natively via
		// `additionalDirectories` on the session-create call (see
		// `ensureContext`). Avoid double-feeding by NOT also prepending
		// it as a synthetic system-prompt prefix.
		const input = await buildPromptInput(params.prompt, params.images);
		const messageId = randomUUID();

		ctx.activeRequestId = requestId;
		ctx.activeEmitter = emitter;
		ctx.activePermissionMode = params.permissionMode;
		ctx.aborted = false;

		// Apply per-turn model + mode BEFORE the prompt fires. Both
		// calls are best-effort: ACP servers may not advertise the
		// requested id (e.g. user picked a stale option), in which case
		// we emit a copilot/status warning and let the prompt run with
		// the previously-applied state.
		const appliedModelId = await this.applyModel(ctx, params.model, requestId);
		const appliedModeId = await this.applyPermissionMode(
			ctx,
			params.permissionMode,
			requestId,
		);

		emitter.passthrough(requestId, {
			type: "copilot/session_started",
			session_id: ctx.providerSessionId,
			model: appliedModelId ?? params.model ?? "default",
			mode: appliedModeId ?? null,
		});
		emitter.passthrough(requestId, {
			type: "copilot/status",
			status: "RUNNING",
			run_id: messageId,
			mode: appliedModeId ?? null,
			model: appliedModelId ?? params.model ?? null,
		});

		try {
			const promptRequest: PromptRequest = {
				sessionId: ctx.providerSessionId,
				messageId,
				prompt: input,
			};
			const promptPromise = ctx.agent.prompt(promptRequest);
			ctx.currentPrompt = promptPromise;
			const result = await promptPromise;
			if (result.stopReason === "cancelled") {
				ctx.aborted = true;
			}
			emitter.passthrough(requestId, {
				type: "copilot/status",
				status: "FINISHED",
				run_id: messageId,
				stopReason: result.stopReason,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error(`[${requestId}] Copilot prompt failed: ${msg}`, {
				...errorDetails(err),
			});
			emitter.error(requestId, `Copilot: ${msg}`);
		} finally {
			ctx.currentPrompt = null;
			ctx.activeRequestId = null;
			ctx.activeEmitter = null;
			ctx.activePermissionMode = undefined;
			if (ctx.aborted) {
				emitter.aborted(requestId, "user_requested");
			}
			emitter.end(requestId);
		}
	}

	async generateTitle(
		requestId: string,
		userMessage: string,
		_branchRenamePrompt: string | null,
		emitter: SidecarEmitter,
		_timeoutMs?: number,
		_options?: GenerateTitleOptions,
	): Promise<void> {
		// ACP has no one-shot prompt mode (unlike the Claude/Cursor
		// SDKs), so spinning up a temporary `copilot` process just to
		// label the chat would cost ~2-5 s per new session. Fall back
		// to a deterministic single-line summary derived from the
		// user's first message — same shape as Codex's offline title.
		const firstLine = userMessage.split(/\r?\n/, 1)[0]?.trim() ?? "";
		const collapsed = firstLine.replace(/\s+/g, " ");
		const truncated =
			collapsed.length > 50
				? `${collapsed.slice(0, 50).trimEnd()}…`
				: collapsed;
		emitter.titleGenerated(requestId, truncated || "New chat", undefined);
	}

	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		// Copilot's ACP server has no slash-command RPC. Re-use the
		// shared filesystem skill scan (`.agents/skills` is the
		// cross-provider convention) so user-defined commands surface
		// in the composer.
		try {
			return await scanCursorSkills(params);
		} catch (err) {
			logger.error(
				`copilot listSlashCommands failed: ${err instanceof Error ? err.message : String(err)}`,
				errorDetails(err),
			);
			return [];
		}
	}

	async listModels(_opts?: {
		apiKey?: string;
	}): Promise<readonly ProviderModelInfo[]> {
		// Prefer the live ACP-reported list — Copilot CLI tracks the
		// user's actual entitlement (Pro vs Free, BYOK overrides, beta
		// rollouts). Fall back to the static catalog only when no ACP
		// child has reported yet (cold start before first prompt).
		if (this.lastKnownModels.length === 0) {
			await this.probeModelsOnce();
		}
		if (this.lastKnownModels.length > 0) {
			return this.lastKnownModels.map(
				(model): ProviderModelInfo => ({
					id: model.modelId,
					label: model.name,
					cliModel: model.modelId,
				}),
			);
		}
		return listProviderModels("copilot");
	}

	/// Spawn a lightweight ACP child just to enumerate available models.
	/// Result is stored in `lastKnownModels` so subsequent `listModels()`
	/// calls return live data immediately. The probe child is killed
	/// after model capture — it is never used for prompts. A singleton
	/// promise prevents concurrent spawns when multiple callers race.
	private probeModelsOnce(): Promise<void> {
		if (this.probePromise) return this.probePromise;
		this.probePromise = this.runModelProbe().finally(() => {
			this.probePromise = null;
		});
		return this.probePromise;
	}

	private async runModelProbe(): Promise<void> {
		const PROBE_TIMEOUT_MS = 15_000;
		const cwd = process.cwd();

		const child = spawn(COPILOT_BIN_PATH, [...COPILOT_ACP_ARGS], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		child.stderr.on("data", (chunk: Buffer) => {
			logger.debug("copilot acp probe stderr", {
				data: chunk.toString().trim(),
			});
		});

		const timeoutHandle = setTimeout(() => {
			logger.info("copilot model probe timed out — killing probe child");
			child.kill();
		}, PROBE_TIMEOUT_MS);

		try {
			const stream = ndJsonStream(
				Writable.toWeb(child.stdin),
				Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
			);
			// Probe sessions never emit events back to a Helmor session,
			// so we provide a no-op client.
			const connection = new ClientSideConnection(() => NOOP_CLIENT, stream);
			const agent = connection as unknown as Agent;

			await agent.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientInfo: {
					name: "helmor_desktop",
					title: "Helmor Desktop",
					version: SIDECAR_VERSION,
				},
				clientCapabilities: {},
			});

			const session = await agent.newSession({
				cwd,
				additionalDirectories: [],
				mcpServers: [],
			});
			const models =
				(session as { models?: SessionModelState | null }).models ?? null;
			if (models?.availableModels && models.availableModels.length > 0) {
				this.lastKnownModels = models.availableModels;
				logger.info(
					`copilot model probe: captured ${models.availableModels.length} models`,
				);
			}

			try {
				await (
					agent as unknown as {
						closeSession?: (req: { sessionId: string }) => Promise<unknown>;
					}
				).closeSession?.({
					sessionId:
						"sessionId" in session && typeof session.sessionId === "string"
							? session.sessionId
							: "",
				});
			} catch {
				// best-effort close
			}
		} catch (err) {
			logger.info(
				`copilot model probe failed: ${err instanceof Error ? err.message : String(err)}`,
				errorDetails(err),
			);
		} finally {
			clearTimeout(timeoutHandle);
			child.kill();
		}
	}

	async stopSession(sessionId: string): Promise<void> {
		const ctx = this.sessions.get(sessionId);
		if (!ctx) return;
		ctx.aborted = true;
		for (const [id, pending] of this.pendingPermissions) {
			if (pending.sessionId !== ctx.providerSessionId) continue;
			pending.resolve({ outcome: { outcome: "cancelled" } });
			this.pendingPermissions.delete(id);
		}
		try {
			await ctx.agent.cancel({ sessionId: ctx.providerSessionId });
		} catch (err) {
			logger.debug("Copilot cancel failed; killing ACP process", {
				...errorDetails(err),
			});
			ctx.child.kill();
			this.sessions.delete(sessionId);
		}
	}

	/// ACP has no mid-turn steering RPC — the upstream protocol expects
	/// callers to cancel and resend. Returning `false` lets the sidecar
	/// fall through to the cancel+resend path, matching how the Codex
	/// manager handles the same gap.
	async steer(
		_sessionId: string,
		_prompt: string,
		_files: readonly string[],
		_images: readonly string[],
	): Promise<boolean> {
		return false;
	}

	async shutdown(): Promise<void> {
		for (const [sessionId, ctx] of this.sessions) {
			try {
				await ctx.agent.closeSession?.({ sessionId: ctx.providerSessionId });
			} catch {
				// Process teardown below is the fallback.
			}
			ctx.child.kill();
			this.sessions.delete(sessionId);
		}
	}

	private async ensureContext(
		helmorSessionId: string,
		cwd: string,
		resume: string | undefined,
		additionalDirectories: string[],
	): Promise<CopilotSessionContext> {
		const existing = this.sessions.get(helmorSessionId);
		// Recreate when the working directory OR the linked-directory
		// set changes — ACP bakes both into the session-create call,
		// so a stale child would silently lose visibility of new dirs.
		if (
			existing &&
			existing.cwd === cwd &&
			sameDirectories(existing.additionalDirectories, additionalDirectories)
		) {
			return existing;
		}
		if (existing) {
			existing.child.kill();
			this.sessions.delete(helmorSessionId);
		}

		const child = spawn(COPILOT_BIN_PATH, [...COPILOT_ACP_ARGS], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});
		child.stderr.on("data", (chunk: Buffer) => {
			logger.debug("copilot acp stderr", { data: chunk.toString().trim() });
		});

		const stream = ndJsonStream(
			Writable.toWeb(child.stdin),
			Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
		);
		let ctx!: CopilotSessionContext;
		const connection = new ClientSideConnection(
			() => this.buildClient(() => ctx),
			stream,
		);
		const agent = connection as unknown as Agent;

		await agent.initialize({
			protocolVersion: PROTOCOL_VERSION,
			clientInfo: {
				name: "helmor_desktop",
				title: "Helmor Desktop",
				version: SIDECAR_VERSION,
			},
			clientCapabilities: {},
		});

		const sessionParams = {
			cwd,
			additionalDirectories,
			mcpServers: [],
		};
		const session =
			resume && agent.resumeSession
				? await agent.resumeSession({
						...sessionParams,
						sessionId: resume,
					})
				: await agent.newSession(sessionParams);

		const providerSessionId: string | null =
			resume ??
			("sessionId" in session && typeof session.sessionId === "string"
				? session.sessionId
				: null);
		if (!providerSessionId) {
			child.kill();
			throw new Error("Copilot ACP did not return a session id");
		}

		ctx = {
			child,
			agent,
			connection,
			providerSessionId,
			cwd,
			additionalDirectories: [...additionalDirectories],
			activeRequestId: null,
			activeEmitter: null,
			activePermissionMode: undefined,
			currentPrompt: null,
			aborted: false,
			availableModels: [],
			currentModelId: null,
			availableModes: [],
			currentModeId: null,
		};
		this.captureSessionState(
			ctx,
			(session as { models?: SessionModelState | null }).models ?? null,
			(session as { modes?: SessionModeState | null }).modes ?? null,
		);
		child.on("exit", () => {
			if (this.sessions.get(helmorSessionId) === ctx) {
				this.sessions.delete(helmorSessionId);
			}
		});
		this.sessions.set(helmorSessionId, ctx);
		return ctx;
	}

	/// Mirror ACP's `SessionModelState` / `SessionModeState` into the
	/// per-session context and refresh the cross-process model cache.
	private captureSessionState(
		ctx: CopilotSessionContext,
		models: SessionModelState | null,
		modes: SessionModeState | null,
	): void {
		if (models) {
			ctx.availableModels = models.availableModels ?? [];
			ctx.currentModelId = models.currentModelId ?? null;
			if (ctx.availableModels.length > 0) {
				this.lastKnownModels = ctx.availableModels;
			}
		}
		if (modes) {
			ctx.availableModes = modes.availableModes ?? [];
			ctx.currentModeId = modes.currentModeId ?? null;
		}
	}

	/// Pick the ACP `modeId` that best matches the user's `permissionMode`.
	/// Returns null when the ACP server didn't advertise modes (older
	/// Copilot builds) or no mapping fits — caller skips the set call.
	private resolveModeId(
		ctx: CopilotSessionContext,
		permissionMode: string | undefined,
	): string | null {
		if (ctx.availableModes.length === 0) return null;
		const findMode = (predicate: (mode: SessionMode) => boolean) =>
			ctx.availableModes.find(predicate)?.id ?? null;

		const target = (permissionMode ?? "default").toLowerCase();
		switch (target) {
			case "plan":
				return (
					findMode((m) => m.id.toLowerCase() === "plan") ??
					findMode((m) => m.name.toLowerCase().includes("plan"))
				);
			case "autopilot":
				return (
					findMode((m) => m.id.toLowerCase() === "autopilot") ??
					findMode((m) => m.name.toLowerCase().includes("autopilot")) ??
					findMode((m) => m.name.toLowerCase().includes("auto"))
				);
			case "bypasspermissions":
				// Helmor's "skip permission prompts" maps onto Copilot's
				// autopilot mode where available; otherwise stay
				// interactive and let the bypass code path swallow
				// approvals at the requestPermission layer.
				return (
					findMode((m) => m.id.toLowerCase() === "autopilot") ??
					findMode((m) => m.name.toLowerCase().includes("autopilot")) ??
					findMode((m) => m.id.toLowerCase() === "interactive") ??
					null
				);
			default:
				return (
					findMode((m) => m.id.toLowerCase() === "interactive") ??
					findMode((m) => m.name.toLowerCase().includes("interactive"))
				);
		}
	}

	private async applyModel(
		ctx: CopilotSessionContext,
		requested: string | undefined,
		requestId: string,
	): Promise<string | null> {
		if (!requested || requested === "default") return ctx.currentModelId;
		if (requested === ctx.currentModelId) return ctx.currentModelId;
		// `unstable_setSessionModel` is the experimental ACP RPC for
		// per-session model switching. Optional on the agent side; the
		// SDK exposes it on `ClientSideConnection` directly.
		const setter = (
			ctx.agent as unknown as {
				unstable_setSessionModel?: (req: {
					sessionId: string;
					modelId: string;
				}) => Promise<unknown>;
			}
		).unstable_setSessionModel;
		if (!setter) return ctx.currentModelId;
		try {
			await setter.call(ctx.agent, {
				sessionId: ctx.providerSessionId,
				modelId: requested,
			});
			ctx.currentModelId = requested;
			return requested;
		} catch (err) {
			logger.info("copilot setSessionModel failed", {
				modelId: requested,
				...errorDetails(err),
			});
			ctx.activeEmitter?.passthrough(requestId, {
				type: "copilot/status",
				status: "WARNING",
				warning: "model_switch_failed",
				modelId: requested,
			});
			return ctx.currentModelId;
		}
	}

	private async applyPermissionMode(
		ctx: CopilotSessionContext,
		permissionMode: string | undefined,
		requestId: string,
	): Promise<string | null> {
		const target = this.resolveModeId(ctx, permissionMode);
		if (!target || target === ctx.currentModeId) return ctx.currentModeId;
		const setter = (
			ctx.agent as unknown as {
				setSessionMode?: (req: {
					sessionId: string;
					modeId: string;
				}) => Promise<unknown>;
			}
		).setSessionMode;
		if (!setter) return ctx.currentModeId;
		try {
			await setter.call(ctx.agent, {
				sessionId: ctx.providerSessionId,
				modeId: target,
			});
			ctx.currentModeId = target;
			return target;
		} catch (err) {
			logger.info("copilot setSessionMode failed", {
				modeId: target,
				...errorDetails(err),
			});
			ctx.activeEmitter?.passthrough(requestId, {
				type: "copilot/status",
				status: "WARNING",
				warning: "mode_switch_failed",
				modeId: target,
			});
			return ctx.currentModeId;
		}
	}

	private buildClient(getCtx: () => CopilotSessionContext): Client {
		return {
			sessionUpdate: async (params: SessionNotification) => {
				const ctx = getCtx();
				const requestId = ctx.activeRequestId;
				const emitter = ctx.activeEmitter;
				if (!requestId || !emitter) return;
				const update = params.update;
				// usage_update → persist via emitter.contextUsageUpdated
				// so it flows through the same Codex pipeline that
				// updates `sessions.context_usage_meta` and triggers
				// `UiMutationEvent::ContextUsageChanged`. Also emit the
				// raw passthrough for any UI that wants live deltas.
				if (update.sessionUpdate === "usage_update") {
					const usage = update as {
						used?: number;
						size?: number;
						_meta?: Record<string, unknown> | null;
					};
					const meta = buildCopilotStoredMeta(
						{
							used: usage.used,
							size: usage.size,
						},
						ctx.currentModelId,
					);
					if (meta) {
						emitter.contextUsageUpdated(
							requestId,
							ctx.providerSessionId,
							JSON.stringify(meta),
						);
					}
				}
				// current_mode_update → reflect server-driven mode
				// changes (slash commands, autopilot continues) so the
				// next sendMessage doesn't try to "switch back" via a
				// redundant setSessionMode call.
				if (update.sessionUpdate === "current_mode_update") {
					const modeUpdate = update as { currentModeId?: string };
					if (modeUpdate.currentModeId) {
						ctx.currentModeId = modeUpdate.currentModeId;
						emitter.passthrough(requestId, {
							type: "copilot/status",
							status: "MODE_CHANGED",
							mode: modeUpdate.currentModeId,
						});
					}
				}
				for (const event of mapSessionUpdate(update)) {
					emitter.passthrough(requestId, event);
				}
			},
			requestPermission: async (
				params: RequestPermissionRequest,
			): Promise<RequestPermissionResponse> => {
				const ctx = getCtx();
				const requestId = ctx.activeRequestId;
				const emitter = ctx.activeEmitter;
				if (!requestId || !emitter) {
					return { outcome: { outcome: "cancelled" } };
				}
				if (ctx.activePermissionMode === "bypassPermissions") {
					const option = pickPermissionOption(params.options, "allow");
					return option
						? {
								outcome: {
									outcome: "selected",
									optionId: option.optionId,
								},
							}
						: { outcome: { outcome: "cancelled" } };
				}
				const permissionId = `copilot-${randomUUID()}`;
				const response = new Promise<RequestPermissionResponse>((resolve) => {
					this.pendingPermissions.set(permissionId, {
						sessionId: ctx.providerSessionId,
						options: params.options,
						resolve,
					});
				});
				emitter.permissionRequest(
					requestId,
					permissionId,
					toolNameForPermission(params.toolCall),
					toolInputForPermission(params.toolCall),
					undefined,
					params.toolCall.title ?? "Copilot requested permission",
				);
				return response;
			},
		};
	}
}

function buildPromptInput(
	prompt: string,
	images: readonly string[],
): Promise<ContentBlock[]> {
	const parsed = parseImageRefs(prompt, images);
	const reads = parsed.imagePaths.map(async (imagePath) => {
		try {
			const { buffer } = await readImageWithResize(imagePath);
			const block: ContentBlock = {
				type: "image",
				data: buffer.toString("base64"),
				mimeType: extToMediaType(imagePath),
				uri: imagePath,
			};
			return block;
		} catch (err) {
			logger.error("Failed to read Copilot image attachment", {
				imagePath,
				...errorDetails(err),
			});
			return null;
		}
	});
	return Promise.all(reads).then((imageBlocks) => {
		const blocks: ContentBlock[] = [];
		if (parsed.text) {
			blocks.push({ type: "text", text: parsed.text });
		}
		for (const block of imageBlocks) {
			if (block) blocks.push(block);
		}
		if (blocks.length === 0) {
			blocks.push({ type: "text", text: prompt });
		}
		return blocks;
	});
}

/// Cheap order-independent equality for the linked-directory list.
function sameDirectories(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	for (let i = 0; i < sortedA.length; i += 1) {
		if (sortedA[i] !== sortedB[i]) return false;
	}
	return true;
}

function extToMediaType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

function mapSessionUpdate(update: SessionUpdate): object[] {
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return textFromContent(update.content).map((text) => ({
				type: "copilot/assistant",
				message: { content: [{ type: "text", text }] },
			}));
		case "agent_thought_chunk":
			return textFromContent(update.content).map((text) => ({
				type: "copilot/thinking",
				text,
			}));
		case "tool_call":
			return [
				{
					type:
						update.status === "completed" || update.status === "failed"
							? "copilot/tool_call_end"
							: "copilot/tool_call_start",
					...toolCallToEvent(update),
				},
			];
		case "tool_call_update":
			return [
				{
					type:
						update.status === "completed" || update.status === "failed"
							? "copilot/tool_call_end"
							: "copilot/tool_call_start",
					...toolCallUpdateToEvent(update),
				},
			];
		case "plan":
			return [
				{
					type: "copilot/thinking",
					text: update.entries
						.map((entry) => `${entry.status}: ${entry.content}`)
						.join("\n"),
				},
			];
		case "usage_update":
			return [
				{
					type: "copilot/usage",
					used: update.used,
					size: update.size,
				},
			];
		default:
			return [];
	}
}

function textFromContent(content: ContentBlock): string[] {
	if (content.type === "text" && content.text) return [content.text];
	return [];
}

function toolCallToEvent(tool: ToolCall): Record<string, unknown> {
	return {
		call_id: tool.toolCallId,
		name: tool.title,
		args: tool.rawInput ?? {},
		result: tool.rawOutput ?? tool.content ?? null,
		status: tool.status ?? "pending",
	};
}

function toolCallUpdateToEvent(tool: ToolCallUpdate): Record<string, unknown> {
	return {
		call_id: tool.toolCallId,
		name: tool.title ?? "tool",
		args: tool.rawInput ?? {},
		result: tool.rawOutput ?? tool.content ?? null,
		status: tool.status ?? "pending",
	};
}

function toolNameForPermission(tool: ToolCallUpdate): string {
	if (tool.kind === "execute") return "Bash";
	if (tool.kind === "edit") return "apply_patch";
	if (tool.kind === "read") return "Read";
	return tool.title ?? "Copilot";
}

function toolInputForPermission(tool: ToolCallUpdate): Record<string, unknown> {
	return {
		title: tool.title,
		kind: tool.kind,
		rawInput: tool.rawInput,
		locations: tool.locations,
	};
}

/// Pick the option that matches the requested behaviour. For "deny"
/// we MUST return undefined when no reject-prefixed option exists —
/// callers fall back to a synthesized `cancelled` outcome rather than
/// silently picking the first (likely allow) option, which would
/// invert the user's intent.
function pickPermissionOption(
	options: readonly PermissionOption[],
	behavior: "allow" | "deny",
): PermissionOption | undefined {
	if (behavior === "allow") {
		return (
			options.find((option) => option.kind.startsWith("allow")) ?? options[0]
		);
	}
	return options.find((option) => option.kind.startsWith("reject"));
}
