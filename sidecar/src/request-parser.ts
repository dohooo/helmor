/**
 * Strict parsing for inbound JSON Lines requests. Narrows untrusted
 * stdin input into typed values, throwing with a clear message on any
 * missing or wrong-shaped field.
 */

import type { Provider, SendMessageParams } from "./session-manager.js";

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
	};
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
