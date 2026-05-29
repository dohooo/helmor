import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { buildSystemPrompt, buildTickUserMessage } from "./prompts";
import type {
	TriageCandidate,
	TriageProposal,
	TriageTickParams,
} from "./types";

type TriageDecision = {
	readonly proposals: TriageProposal[];
	readonly skips: readonly { candidateId: string; reason: string }[];
	readonly summary: string | null;
};

type CandidateBody = {
	readonly candidate: TriageCandidate;
	readonly body: string;
};

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
	promise: Promise<TriageDecision & { cancelled: boolean }>;
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
): Promise<TriageDecision & { cancelled: boolean }> {
	const tickId = params.tickId || "(no-tick-id)";
	const logTag = `triage[${tickId}]`;
	const cwd = await mkdtemp(join(tmpdir(), "helmor-triage-codex-"));
	const model = pickFastestCodexModel();

	let server: CodexAppServer | null = null;
	try {
		const candidateBodies = await readCandidateBodies(params.candidates);
		const prompt = buildCodexUserPrompt(params, candidateBodies);
		const imagePaths = await writeCandidateImages(params.candidates, cwd);
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
					input: [
						{ type: "text", text: prompt, text_elements: [] },
						...imagePaths.map((path) => ({ type: "localImage", path })),
					],
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

async function readCandidateBodies(
	candidates: readonly TriageCandidate[],
): Promise<CandidateBody[]> {
	return Promise.all(
		candidates.map(async (candidate) => {
			const isIm = candidate.source === "lark" || candidate.source === "slack";
			const response = await callHost<{ body: string }>(
				"triage.read_candidate",
				{
					candidateId: candidate.id,
					...(isIm ? { tail: 80 } : {}),
				},
			);
			return { candidate, body: response.body };
		}),
	);
}

async function writeCandidateImages(
	candidates: readonly TriageCandidate[],
	cwd: string,
): Promise<string[]> {
	const dir = join(cwd, "attachments");
	const paths: string[] = [];
	let index = 0;
	for (const candidate of candidates) {
		for (const attachment of candidate.attachments ?? []) {
			if (!attachment.dataBase64 || !attachment.mimeType.startsWith("image/")) {
				continue;
			}
			await mkdir(dir, { recursive: true });
			index += 1;
			const path = join(
				dir,
				`${index}-${safeFilePart(candidate.id)}.${extensionForMime(attachment.mimeType)}`,
			);
			await writeFile(path, Buffer.from(attachment.dataBase64, "base64"));
			paths.push(path);
		}
	}
	return paths;
}

function buildCodexUserPrompt(
	params: TriageTickParams,
	candidateBodies: readonly CandidateBody[],
): string {
	const systemPrompt = buildSystemPrompt({
		userPromptSuffix: params.systemPrompt,
		maxPerTick: params.maxPerTick,
		candidates: params.candidates,
	});
	const { text: batchSummary } = buildTickUserMessage(
		params.candidates,
		params.repos,
	);
	const bodies = candidateBodies
		.map(({ candidate, body }) => {
			return `<candidate-body id="${escapeXml(candidate.id)}">
${escapeXml(body)}
</candidate-body>`;
		})
		.join("\n\n");

	return `${systemPrompt}

${batchSummary}

<candidate-bodies>
${bodies}
</candidate-bodies>

Return ONLY a JSON object with this shape:
{
  "proposals": [
    {
      "candidateId": "candidate id",
      "taskAnchor": "message id or issue/pr id",
      "repoId": "repo id",
      "title": "short title",
      "branchName": "lowercase-hyphen-branch",
      "planMessage": "markdown plan"
    }
  ],
  "skips": [
    { "candidateId": "candidate id", "reason": "one sentence" }
  ],
  "summary": "short summary"
}

Use at most ${Math.max(1, params.maxPerTick)} proposals. Include a candidate in "skips" only when the whole candidate has no actionable task.`;
}

export function parseCodexDecision(text: string): TriageDecision {
	const jsonText = extractJsonObject(text);
	const parsed = JSON.parse(jsonText) as Record<string, unknown>;
	const proposals = Array.isArray(parsed.proposals)
		? parsed.proposals
				.map(coerceProposal)
				.filter((p): p is TriageProposal => p !== null)
		: [];
	const skips = Array.isArray(parsed.skips)
		? parsed.skips
				.map(coerceSkip)
				.filter((s): s is { candidateId: string; reason: string } => s !== null)
		: [];
	const summary =
		typeof parsed.summary === "string" && parsed.summary.trim().length > 0
			? parsed.summary.trim()
			: null;
	return { proposals, skips, summary };
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const source = fenced?.[1] ?? text;
	const start = source.indexOf("{");
	const end = source.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Codex triage response did not contain JSON");
	}
	return source.slice(start, end + 1);
}

function coerceProposal(value: unknown): TriageProposal | null {
	if (!value || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const candidateId = stringField(obj, "candidateId");
	const taskAnchor = stringField(obj, "taskAnchor");
	const repoId = stringField(obj, "repoId");
	const title = stringField(obj, "title");
	const branchName = stringField(obj, "branchName");
	const planMessage = stringField(obj, "planMessage");
	if (
		!candidateId ||
		!taskAnchor ||
		!repoId ||
		!title ||
		!branchName ||
		!planMessage
	) {
		return null;
	}
	return { candidateId, taskAnchor, repoId, title, branchName, planMessage };
}

function coerceSkip(
	value: unknown,
): { candidateId: string; reason: string } | null {
	if (!value || typeof value !== "object") return null;
	const obj = value as Record<string, unknown>;
	const candidateId = stringField(obj, "candidateId");
	const reason = stringField(obj, "reason");
	if (!candidateId || !reason) return null;
	return { candidateId, reason };
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
	const value = obj[key];
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
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

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function safeFilePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || "candidate";
}

function extensionForMime(mime: string): string {
	if (mime === "image/jpeg") return "jpg";
	if (mime === "image/webp") return "webp";
	if (mime === "image/gif") return "gif";
	return "png";
}
