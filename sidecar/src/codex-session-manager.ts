/**
 * `SessionManager` implementation backed by the Codex SDK.
 */

import {
	Codex,
	type Input,
	type ThreadOptions,
	type UserInput,
} from "@openai/codex-sdk";
import { isAbortError } from "./abort.js";
import { scanCodexSkills } from "./codex-skill-scanner.js";
import type { SidecarEmitter } from "./emitter.js";
import { parseImageRefs } from "./images.js";
import type {
	ListSlashCommandsParams,
	SendMessageParams,
	SessionManager,
	SlashCommandInfo,
} from "./session-manager.js";
import {
	buildTitlePrompt,
	parseTitleAndBranch,
	TITLE_GENERATION_TIMEOUT_MS,
} from "./title.js";

const VALID_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type CodexEffort = (typeof VALID_EFFORTS)[number];

function parseEffort(value: string | undefined): CodexEffort | undefined {
	if (value && (VALID_EFFORTS as readonly string[]).includes(value)) {
		return value as CodexEffort;
	}
	return undefined;
}

function buildCodexInput(prompt: string): Input {
	const { text, imagePaths } = parseImageRefs(prompt);
	if (imagePaths.length === 0) {
		return prompt;
	}
	const parts: UserInput[] = [];
	if (text) {
		parts.push({ type: "text", text });
	}
	for (const p of imagePaths) {
		parts.push({ type: "local_image", path: p });
	}
	return parts;
}

export class CodexSessionManager implements SessionManager {
	private readonly abortControllers = new Map<string, AbortController>();

	async sendMessage(
		requestId: string,
		params: SendMessageParams,
		emitter: SidecarEmitter,
	): Promise<void> {
		const {
			sessionId,
			prompt,
			model,
			cwd,
			resume,
			effortLevel,
			permissionMode,
		} = params;
		const abortController = new AbortController();
		this.abortControllers.set(sessionId, abortController);

		try {
			const codex = new Codex();
			const effort = parseEffort(effortLevel);
			const threadOpts: ThreadOptions = {
				...(model ? { model } : {}),
				...(cwd ? { workingDirectory: cwd } : {}),
				skipGitRepoCheck: true,
				...(effort ? { modelReasoningEffort: effort } : {}),
				...(permissionMode === "plan"
					? { approvalPolicy: "never" as const }
					: {}),
			};

			const thread = resume
				? codex.resumeThread(resume, threadOpts)
				: codex.startThread(threadOpts);

			const streamedTurn = await thread.runStreamed(buildCodexInput(prompt), {
				signal: abortController.signal,
			});

			// Codex events don't carry the thread id natively. Inject it as
			// `session_id` (snake_case) so the on-the-wire format matches Claude.
			for await (const event of streamedTurn.events) {
				const threadId = thread.id;
				const enriched: object = threadId
					? { ...(event as object), session_id: threadId }
					: (event as object);
				emitter.passthrough(requestId, enriched);
			}

			emitter.end(requestId);
		} catch (err) {
			if (isAbortError(err)) {
				emitter.aborted(requestId, "user_requested");
				return;
			}
			throw err;
		} finally {
			this.abortControllers.delete(sessionId);
		}
	}

	async generateTitle(
		requestId: string,
		userMessage: string,
		emitter: SidecarEmitter,
	): Promise<void> {
		const codex = new Codex();
		const abortController = new AbortController();
		const timeout = setTimeout(
			() => abortController.abort(),
			TITLE_GENERATION_TIMEOUT_MS,
		);

		try {
			const thread = codex.startThread({ model: "gpt-5.3-codex-spark" });
			const streamedTurn = await thread.runStreamed(
				buildTitlePrompt(userMessage),
				{ signal: abortController.signal },
			);

			let raw = "";
			for await (const event of streamedTurn.events) {
				const text = extractAgentMessageText(event);
				if (text !== undefined) {
					raw += text;
				}
			}

			const { title, branchName } = parseTitleAndBranch(raw);
			emitter.titleGenerated(requestId, title, branchName);
		} finally {
			clearTimeout(timeout);
		}
	}

	/**
	 * The Codex SDK exposes no command-discovery API, so we substitute by
	 * scanning the documented Codex skill directories on disk and surfacing
	 * each `SKILL.md` as a slash entry. This gives Codex sessions the same
	 * unified popup experience as Claude.
	 */
	async listSlashCommands(
		params: ListSlashCommandsParams,
	): Promise<readonly SlashCommandInfo[]> {
		return scanCodexSkills(params.cwd);
	}

	async stopSession(sessionId: string): Promise<void> {
		const controller = this.abortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this.abortControllers.delete(sessionId);
		}
	}

	async shutdown(): Promise<void> {
		// Codex SDK has no Query.close() / dispose() — abort is the only
		// teardown primitive. The signal is forwarded to the spawned
		// `codex exec` child via Node's child_process abort contract.
		const snapshot = Array.from(this.abortControllers.values());
		for (const controller of snapshot) {
			try {
				controller.abort();
			} catch {
				// best-effort
			}
		}
		this.abortControllers.clear();
	}
}

/**
 * Narrow a Codex `ThreadEvent` to the `agent_message` text payload, if any.
 * The Codex SDK doesn't export the discriminated event types, so we do a
 * structural check rather than relying on type narrowing.
 */
function extractAgentMessageText(event: unknown): string | undefined {
	if (typeof event !== "object" || event === null) return undefined;
	const ev = event as { type?: unknown; item?: unknown };
	if (ev.type !== "item.completed") return undefined;
	if (typeof ev.item !== "object" || ev.item === null) return undefined;
	const item = ev.item as { type?: unknown; text?: unknown };
	if (item.type !== "agent_message") return undefined;
	if (typeof item.text !== "string") return undefined;
	return item.text;
}
