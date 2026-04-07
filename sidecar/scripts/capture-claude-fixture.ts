#!/usr/bin/env bun
/**
 * Capture a real Claude Agent SDK stream into a jsonl fixture file.
 *
 * Drives `ClaudeSessionManager` directly (no sidecar stdin/stdout dance,
 * no Tauri, no dev server) with a capturing emitter that serializes
 * every emit to the output file. The resulting jsonl is byte-for-byte
 * what the live sidecar would have written for the same prompt.
 *
 * Usage:
 *   bun run scripts/capture-claude-fixture.ts <output-path> [prompt]
 *
 * Optional environment variables:
 *   CAPTURE_MODEL            model id (e.g. "opus", "sonnet", "haiku")
 *   CAPTURE_CWD              working directory (defaults to process.cwd())
 *   CAPTURE_PERMISSION_MODE  permission mode (default / plan / acceptEdits / ...)
 *   CAPTURE_EFFORT           effort level (low / medium / high / max)
 *
 * Example:
 *   CAPTURE_MODEL=sonnet bun run scripts/capture-claude-fixture.ts \
 *     ../src-tauri/tests/fixtures/streams/claude/todo-list.jsonl \
 *     "Use the TodoWrite tool to plan a 3-step refactor."
 *
 * Requires Claude Agent SDK credentials in the environment (typically an
 * `ANTHROPIC_API_KEY` or a Claude Code login session).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ClaudeSessionManager } from "../src/claude-session-manager.js";
import { createSidecarEmitter } from "../src/emitter.js";

const args = process.argv.slice(2);
const outputPath = args[0];
if (!outputPath) {
	console.error(
		"usage: bun run scripts/capture-claude-fixture.ts <output-path> [prompt]",
	);
	process.exit(2);
}
const prompt = args[1] ?? "Say hello.";

const outputAbs = resolve(outputPath);
mkdirSync(dirname(outputAbs), { recursive: true });

const captured: string[] = [];
const emitter = createSidecarEmitter((event) => {
	captured.push(JSON.stringify(event));
});

const manager = new ClaudeSessionManager();

console.error(`[capture] prompt: ${prompt}`);
console.error("[capture] invoking ClaudeSessionManager.sendMessage...");

try {
	await manager.sendMessage(
		"capture-request-1",
		{
			sessionId: "capture-session-1",
			prompt,
			model: process.env.CAPTURE_MODEL,
			cwd: process.env.CAPTURE_CWD ?? process.cwd(),
			resume: undefined,
			permissionMode: process.env.CAPTURE_PERMISSION_MODE,
			effortLevel: process.env.CAPTURE_EFFORT,
		},
		emitter,
	);
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[capture] sendMessage failed: ${msg}`);
	console.error(
		"[capture] partial output (if any) will still be written so you can debug",
	);
}

// Strip the sidecar-layer request id from each emitted event. The sidecar
// tests inject their own synthetic id per test run.
const lines = captured.map((line) => {
	const obj = JSON.parse(line) as Record<string, unknown>;
	const { id: _discard, ...rest } = obj;
	return JSON.stringify(rest);
});

writeFileSync(outputAbs, `${lines.join("\n")}\n`);
console.error(`[capture] wrote ${lines.length} events to ${outputAbs}`);
