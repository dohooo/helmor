/** Pure helpers for the cursor worker — kept @cursor/sdk-runtime-free (the SDK
 * is imported as types only) so unit tests can exercise them under Bun without
 * loading @cursor/sdk. The stateful Agent logic that DOES load the SDK lives in
 * `cursor-core.ts`, which only ever runs in the Node worker. */

import { basename, extname } from "node:path";
import type {
	ModelListItem,
	ModelParameterValue,
	SDKImage,
	SDKMessage,
	SDKUserMessage,
} from "@cursor/sdk";
import { readImageWithResize } from "../../image-resize.js";
import { errorDetails, logger } from "../../logger.js";
import type {
	CursorModelParameter,
	ProviderModelInfo,
} from "../../session-manager.js";

/// Map Helmor's permissionMode to Cursor's conversation mode. Plan mode
/// runs Cursor read-only; everything else is the normal agent mode.
export function toCursorMode(
	permissionMode: string | undefined,
): "agent" | "plan" {
	return permissionMode === "plan" ? "plan" : "agent";
}

/// Pull the plan markdown out of a `createPlan` tool_call event
/// (`args.plan`). Returns null when absent/blank so `planCaptured` falls
/// back to a bare marker rather than an empty plan card.
export function extractCreatePlanText(
	e: Record<string, unknown>,
): string | null {
	const args = e.args as Record<string, unknown> | undefined;
	const plan = args?.plan;
	return typeof plan === "string" && plan.trim() !== "" ? plan : null;
}

export function extToMimeType(filePath: string): string {
	switch (extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return "image/png";
	}
}

/// Build the `agent.send` payload. Returns a plain string when there are
/// no attachments (cheapest path); otherwise an SDKUserMessage carrying
/// base64 images. Unreadable files degrade to a `[Image not found]` note
/// appended to the text so the turn still goes through.
export async function buildCursorMessage(
	text: string,
	imagePaths: readonly string[],
): Promise<string | SDKUserMessage> {
	if (imagePaths.length === 0) return text;
	const images: SDKImage[] = [];
	const notes: string[] = [];
	for (const imgPath of imagePaths) {
		try {
			const { buffer } = await readImageWithResize(imgPath);
			images.push({
				data: buffer.toString("base64"),
				mimeType: extToMimeType(imgPath),
			});
		} catch (err) {
			logger.error("Failed to read Cursor image attachment", {
				imageName: basename(imgPath),
				...errorDetails(err),
			});
			notes.push(`[Image not found: ${imgPath}]`);
		}
	}
	const finalText = [text, ...notes].filter(Boolean).join("\n");
	if (images.length === 0) return finalText;
	return { text: finalText, images };
}

/// Prefix `type` with `cursor/` so Rust dispatch doesn't collide with
/// claude/codex. `tool_call` is split into `tool_call_start` /
/// `tool_call_end` based on `status` so accumulator can branch on type.
export function namespaceEvent(event: SDKMessage): Record<string, unknown> {
	const e = event as unknown as Record<string, unknown>;
	if (e.type === "tool_call") {
		const status = typeof e.status === "string" ? e.status : "running";
		return {
			...e,
			type:
				status === "completed"
					? "cursor/tool_call_end"
					: "cursor/tool_call_start",
		};
	}
	return { ...e, type: `cursor/${String(e.type)}` };
}

/// Effort wire ids in priority order: Claude uses `effort`, GPT/Codex
/// uses `reasoning`. Both can carry levels; when both present, `effort`
/// wins (Claude has effort + thinking; thinking is the boolean one).
const CURSOR_EFFORT_PARAM_IDS = ["effort", "reasoning"] as const;

/// Build agent.send params from composer toolbar state. Toolbar surfaces
/// effort + fast; `thinking` is auto-enabled when the model exposes it.
export function computeModelParameterValues(
	parameters: readonly CursorModelParameter[],
	effortLevel: string | undefined,
	fastMode: boolean | undefined,
): ModelParameterValue[] {
	const out: ModelParameterValue[] = [];

	if (typeof effortLevel === "string" && effortLevel !== "") {
		for (const id of CURSOR_EFFORT_PARAM_IDS) {
			const param = parameters.find((p) => p.id === id);
			if (!param) continue;
			// Reject out-of-band values — API rejects unknown values.
			if (param.values.some((v) => v.value === effortLevel)) {
				out.push({ id: param.id, value: effortLevel });
			}
			break;
		}
	}

	// Auto-enable `thinking` when present (Claude extended thinking).
	const thinkingParam = parameters.find((p) => p.id === "thinking");
	if (thinkingParam?.values.some((v) => v.value === "true")) {
		out.push({ id: "thinking", value: "true" });
	}

	// Always forward an explicit fast value when the model exposes it.
	// Omitting it lets Cursor fall back to a model-specific server default
	// (Composer 2.5 defaults to fast), so OFF must be sent as fast=false.
	const fastParam = parameters.find((p) => p.id === "fast");
	if (fastParam) {
		const desired = fastMode === true ? "true" : "false";
		if (fastParam.values.some((v) => v.value === desired)) {
			out.push({ id: "fast", value: desired });
		}
	}

	return out;
}

export function modelInfoToProviderInfo(
	model: ModelListItem,
): ProviderModelInfo {
	const params = model.parameters ?? [];
	const effortParam = CURSOR_EFFORT_PARAM_IDS.map((id) =>
		params.find((p) => p.id === id),
	).find((p): p is NonNullable<typeof p> => p !== undefined);
	const fastParam = params.find((p) => p.id === "fast");
	const effortLevels = effortParam?.values
		.map((v) => v.value)
		.filter((v): v is string => typeof v === "string");
	const supportsFastMode = Boolean(fastParam);
	const cursorParameters: CursorModelParameter[] | undefined = model.parameters
		? model.parameters.map((p) => ({
				id: p.id,
				...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
				values: p.values.map((v) => ({
					value: v.value,
					...(v.displayName !== undefined
						? { displayName: v.displayName }
						: {}),
				})),
			}))
		: undefined;
	return {
		id: model.id,
		label: model.displayName ?? model.id,
		cliModel: model.id,
		...(effortLevels && effortLevels.length > 0 ? { effortLevels } : {}),
		...(supportsFastMode ? { supportsFastMode } : {}),
		...(cursorParameters && cursorParameters.length > 0
			? { cursorParameters }
			: {}),
	};
}

/// Transient network failures worth retrying / recovering from rather than
/// surfacing as a hard failure: TLS/connection resets, timeouts, DNS hiccups.
/// `api2.cursor.sh` intermittently resets the TLS handshake from some networks,
/// and the SDK's HTTP/2 client throws that as a ConnectError whose `cause` is a
/// Node socket error. We match by error `code`, nested `cause.code`, and the
/// message text so it works across ConnectError and raw socket errors.
const RETRYABLE_NET_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);

const RETRYABLE_NET_MESSAGES = [
	"socket disconnected",
	"before secure tls",
	"socket hang up",
	"econnreset",
	"etimedout",
	"timed out",
	"network socket disconnected",
];

export function isRetryableCursorError(err: unknown, depth = 0): boolean {
	if (!err || typeof err !== "object" || depth > 4) return false;
	const o = err as { code?: unknown; message?: unknown; cause?: unknown };
	if (typeof o.code === "string" && RETRYABLE_NET_CODES.has(o.code))
		return true;
	if (typeof o.message === "string") {
		const m = o.message.toLowerCase();
		if (RETRYABLE_NET_MESSAGES.some((needle) => m.includes(needle)))
			return true;
	}
	return isRetryableCursorError(o.cause, depth + 1);
}

/// "Agent already has an active run" conflict (SDK AgentBusyError / 409). A run
/// left non-terminal in the cwd-scoped local store — e.g. the worker was killed
/// mid-turn before it could cancel — blocks every follow-up `agent.send`. The
/// local store throws it as a plain `Error("Agent <id> already has active run")`;
/// the cloud path wraps it as AgentBusyError. Match both, walking `cause`.
export function isAgentBusyError(err: unknown, depth = 0): boolean {
	if (!err || typeof err !== "object" || depth > 4) return false;
	const o = err as {
		name?: unknown;
		errorName?: unknown;
		message?: unknown;
		cause?: unknown;
	};
	if (o.name === "AgentBusyError" || o.errorName === "AgentBusyError")
		return true;
	if (
		typeof o.message === "string" &&
		/already has (an )?active run/i.test(o.message)
	)
		return true;
	return isAgentBusyError(o.cause, depth + 1);
}

/// Authentication failures (SDK AuthenticationError / 401). Raw ConnectErrors
/// from the SDK's background streaming tasks surface as `[unauthenticated] …`
/// and never get wrapped, so match by ConnectError `code` and message text in
/// addition to the wrapped class name. Walks `cause`.
const AUTH_ERROR_CODES = new Set([
	"unauthenticated",
	"unauthorized",
	"permission_denied",
]);

export function isAuthError(err: unknown, depth = 0): boolean {
	if (!err || typeof err !== "object" || depth > 4) return false;
	const o = err as {
		name?: unknown;
		errorName?: unknown;
		code?: unknown;
		message?: unknown;
		cause?: unknown;
	};
	if (o.name === "AuthenticationError" || o.errorName === "AuthenticationError")
		return true;
	if (typeof o.code === "string" && AUTH_ERROR_CODES.has(o.code.toLowerCase()))
		return true;
	if (typeof o.message === "string") {
		const m = o.message.toLowerCase();
		if (
			m.includes("[unauthenticated]") ||
			m.includes("[unauthorized]") ||
			m.includes("invalid api key")
		)
			return true;
	}
	return isAuthError(o.cause, depth + 1);
}

// Test-only export.
export const __CURSOR_INTERNAL = {
	namespaceEvent,
	modelInfoToProviderInfo,
	computeModelParameterValues,
	buildCursorMessage,
	extToMimeType,
	toCursorMode,
	extractCreatePlanText,
	isRetryableCursorError,
	isAgentBusyError,
	isAuthError,
};
