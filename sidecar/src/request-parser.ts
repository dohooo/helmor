/**
 * Strict parsing for inbound JSON Lines requests. Narrows untrusted
 * stdin input into typed values, throwing with a clear message on any
 * missing or wrong-shaped field.
 */

import type {
	GetContextUsageParams,
	ListSlashCommandsParams,
	Provider,
	SendMessageParams,
} from "./session-manager.js";

export interface RawRequest {
	readonly id: string;
	readonly method: string;
	readonly params: Record<string, unknown>;
}

export function parseRequest(line: string): RawRequest {
	const parsed = JSON.parse(line) as unknown;
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("request must be an object");
	}
	const { id, method, params } = parsed as Record<string, unknown>;
	if (typeof id !== "string") throw new Error("request.id must be a string");
	if (typeof method !== "string")
		throw new Error("request.method must be a string");
	if (typeof params !== "object" || params === null) {
		throw new Error("request.params must be an object");
	}
	return { id, method, params: params as Record<string, unknown> };
}

export function requireString(
	params: Record<string, unknown>,
	key: string,
): string {
	const value = params[key];
	if (typeof value !== "string") {
		throw new Error(`params.${key} must be a string`);
	}
	return value;
}

export function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" ? value : undefined;
}

function optionalBoolean(
	params: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = params[key];
	return typeof value === "boolean" ? value : undefined;
}

export function optionalObject(
	params: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const value = params[key];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "object") {
		return value as Record<string, unknown>;
	}
	throw new Error(`params.${key} must be an object`);
}

export function parseProvider(value: unknown): Provider {
	if (value === "claude" || value === "codex") return value;
	throw new Error(`unknown provider: ${String(value)}`);
}

export function parseSendMessageParams(
	params: Record<string, unknown>,
): SendMessageParams {
	return {
		sessionId: requireString(params, "sessionId"),
		prompt: requireString(params, "prompt"),
		model: optionalString(params, "model"),
		cwd: optionalString(params, "cwd"),
		resume: optionalString(params, "resume"),
		permissionMode: optionalString(params, "permissionMode"),
		effortLevel: optionalString(params, "effortLevel"),
		fastMode: optionalBoolean(params, "fastMode"),
		claudeEnvironment: parseOptionalStringRecord(params, "claudeEnvironment"),
		additionalDirectories: parseOptionalStringArray(
			params,
			"additionalDirectories",
		),
		sourceRepoPath: optionalString(params, "sourceRepoPath"),
		// Always normalize to an array. Symmetric with
		// `parseSteerSessionParams` so neither path needs to disambiguate
		// "field absent" vs "no images" — both mean `[]`. The structured
		// list is the single source of truth (see `parseImageRefs`).
		images: parseOptionalStringArray(params, "images") ?? [],
	};
}

export function parseOptionalStringRecord(
	params: Record<string, unknown>,
	key: string,
): Readonly<Record<string, string>> | undefined {
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`params.${key} must be an object`);
	}
	const out: Record<string, string> = {};
	for (const [recordKey, recordValue] of Object.entries(value)) {
		if (typeof recordValue !== "string") {
			throw new Error(`params.${key}.${recordKey} must be a string`);
		}
		out[recordKey] = recordValue;
	}
	return out;
}

function parseOptionalStringArray(
	params: Record<string, unknown>,
	key: string,
): readonly string[] | undefined {
	const value = params[key];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`params.${key} must be an array of strings`);
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			throw new Error(`params.${key}[] must contain strings only`);
		}
		const trimmed = item.trim();
		if (trimmed) out.push(trimmed);
	}
	return out;
}

export function parseListSlashCommandsParams(
	params: Record<string, unknown>,
): ListSlashCommandsParams {
	return {
		cwd: optionalString(params, "cwd"),
		additionalDirectories: parseOptionalStringArray(
			params,
			"additionalDirectories",
		),
	};
}

export function parseGetContextUsageParams(
	params: Record<string, unknown>,
): GetContextUsageParams {
	return {
		helmorSessionId: requireString(params, "sessionId"),
		providerSessionId: optionalString(params, "providerSessionId") ?? null,
		model: requireString(params, "model"),
		cwd: optionalString(params, "cwd"),
	};
}

export interface SteerSessionParams {
	readonly sessionId: string;
	readonly prompt: string;
	readonly files: readonly string[];
	readonly images: readonly string[];
}

export function parseSteerSessionParams(
	params: Record<string, unknown>,
): SteerSessionParams {
	const rawFiles = params.files;
	const files: string[] = Array.isArray(rawFiles)
		? rawFiles.filter((f): f is string => typeof f === "string")
		: [];
	const rawImages = params.images;
	const images: string[] = Array.isArray(rawImages)
		? rawImages.filter((i): i is string => typeof i === "string")
		: [];
	return {
		sessionId: requireString(params, "sessionId"),
		prompt: requireString(params, "prompt"),
		files,
		images,
	};
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
