/**
 * Strict parsing for inbound JSON Lines requests. Narrows untrusted
 * stdin input into typed values, throwing with a clear message on any
 * missing or wrong-shaped field.
 */

import type { ElicitationResult } from "@anthropic-ai/claude-agent-sdk";
import type {
	ListSlashCommandsParams,
	Provider,
	SendMessageParams,
} from "./session-manager.js";

type ElicitationContent = NonNullable<ElicitationResult["content"]>;

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

function optionalObject(
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

function isElicitationContentValue(
	value: unknown,
): value is ElicitationContent[string] {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		(Array.isArray(value) && value.every((item) => typeof item === "string"))
	);
}

export function parseElicitationResultContent(
	params: Record<string, unknown>,
	key: string,
): ElicitationResult["content"] | undefined {
	const content = optionalObject(params, key);
	if (!content) {
		return undefined;
	}

	const parsedContent: ElicitationContent = {};
	for (const [contentKey, value] of Object.entries(content)) {
		if (!isElicitationContentValue(value)) {
			throw new Error(
				`params.${key}.${contentKey} must be a string, number, boolean, or string[]`,
			);
		}
		parsedContent[contentKey] = value;
	}

	return parsedContent;
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
	};
}

export function parseListSlashCommandsParams(
	params: Record<string, unknown>,
): ListSlashCommandsParams {
	return {
		cwd: optionalString(params, "cwd"),
		model: optionalString(params, "model"),
	};
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
