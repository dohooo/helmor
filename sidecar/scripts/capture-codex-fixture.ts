#!/usr/bin/env bun
/**
 * Capture a real Codex App Server stream into a jsonl fixture file.
 *
 * Drives `CodexAppServerManager` directly (no Tauri, no dev server)
 * with a capturing emitter. The resulting jsonl is byte-for-byte what
 * the live sidecar would have written for the same prompt.
 *
 * Usage:
 *   bun run scripts/capture-codex-fixture.ts <output-path> [prompt]
 *
 * Optional environment variables:
 *   CAPTURE_MODEL            model id
 *   CAPTURE_CWD              working directory (defaults to process.cwd())
 *   CAPTURE_EFFORT           reasoning effort (minimal / low / medium / high / xhigh)
 *
 * Example:
 *   CAPTURE_EFFORT=high bun run scripts/capture-codex-fixture.ts \
 *     ../src-tauri/tests/fixtures/streams/codex/reasoning.jsonl \
 *     "Carefully reason through 23 * 47."
 *
 * Requires Codex credentials in the environment (OPENAI_API_KEY or login session).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CodexAppServerManager } from "../src/codex-app-server-manager.js";
import { createSidecarEmitter } from "../src/emitter.js";

const args = process.argv.slice(2);
const outputPath = args[0];
if (!outputPath) {
	console.error(
		"usage: bun run scripts/capture-codex-fixture.ts <output-path> [prompt]",
	);
	process.exit(2);
}
const prompt = args[1] ?? "List the files in the current directory.";

const outputAbs = resolve(outputPath);
mkdirSync(dirname(outputAbs), { recursive: true });

const captured: string[] = [];
const emitter = createSidecarEmitter((event) => {
	captured.push(JSON.stringify(event));
});

const manager = new CodexAppServerManager();

console.error(`[capture] prompt: ${prompt}`);
console.error("[capture] invoking CodexAppServerManager.sendMessage...");

try {
	await manager.sendMessage(
		"capture-request-1",
		{
			sessionId: "capture-session-1",
			prompt,
			model: process.env.CAPTURE_MODEL,
			cwd: process.env.CAPTURE_CWD ?? process.cwd(),
			resume: undefined,
			permissionMode: undefined,
			effortLevel: process.env.CAPTURE_EFFORT,
		},
		emitter,
	);
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[capture] sendMessage failed: ${msg}`);
	console.error("[capture] partial output will still be written for debugging");
}

await manager.shutdown();

// Strip the synthetic request id — tests inject their own per run.
const lines = captured.map((line) => {
	const obj = JSON.parse(line) as Record<string, unknown>;
	const { id: _discard, ...rest } = obj;
	return JSON.stringify(rest);
});

writeFileSync(outputAbs, `${lines.join("\n")}\n`);
console.error(`[capture] wrote ${lines.length} events to ${outputAbs}`);
