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
 *   CAPTURE_THINKING_DISPLAY thinking display (summarized / omitted)
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
import { ClaudeSessionManager } from "../src/claude/session-manager.js";
import { createSidecarEmitter } from "../src/emitter.js";

function createStableMapper(prefix: string) {
	const seen = new Map<string, string>();
	let next = 1;
	return (value: string) => {
		if (!seen.has(value)) {
			seen.set(value, `${prefix}_${next}`);
			next += 1;
		}
		return seen.get(value)!;
	};
}

function sanitizeFixtureText(
	raw: string,
	appRepoRoot: string,
	dummyRepoRoot: string,
) {
	const mapUuid = createStableMapper("uuid");
	const mapSession = createStableMapper("session");
	const mapThread = createStableMapper("thread");
	const mapTurn = createStableMapper("turn");
	const mapMsg = createStableMapper("msg");
	const mapReasoning = createStableMapper("rs");
	const mapCall = createStableMapper("call");
	const mapToolUse = createStableMapper("toolu");
	const mapEmail = createStableMapper("redacted_email");
	const homeDir = process.env.HOME ?? "";
	const homeUser = homeDir.split("/").filter(Boolean).at(-1) ?? "";

	let text = String(raw);
	text = text.replaceAll(appRepoRoot, "$APP_REPO_ROOT");
	text = text.replaceAll(dummyRepoRoot, "$DUMMY_REPO");
	text = text.replaceAll(`${homeDir}/.claude`, "$CLAUDE_HOME");
	text = text.replaceAll(`${homeDir}/.codex`, "$CODEX_HOME");
	text = text.replaceAll(homeDir, "$HOME");
	text = text.replaceAll("/private/tmp/codex-home", "$CODEX_HOME");
	text = text.replaceAll("/tmp/codex-home", "$CODEX_HOME");
	text = text.replaceAll("/private/tmp/helmor-sidecar-logs", "$HELMOR_LOG_DIR");
	text = text.replaceAll("/tmp/helmor-sidecar-logs", "$HELMOR_LOG_DIR");
	text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (match) =>
		mapEmail(match),
	);
	if (homeUser) {
		text = text.replace(new RegExp(`\\b${homeUser}\\b`, "gi"), "fixture-user");
	}
	text = text.replace(/\b[a-z][a-z0-9_-]{2,}\s+staff\b/g, "fixture-user staff");
	text = text.replace(
		/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
		(match) => mapUuid(match),
	);
	text = text.replace(/\btoolu_[A-Za-z0-9]+\b/g, (match) => mapToolUse(match));
	text = text.replace(/\bcall_[A-Za-z0-9]+\b/g, (match) => mapCall(match));
	text = text.replace(/\bmsg_[A-Za-z0-9]+\b/g, (match) => mapMsg(match));
	text = text.replace(/\brs_[A-Za-z0-9]+\b/g, (match) => mapReasoning(match));
	text = text.replace(
		/"session_id"\s*:\s*"([^"]+)"/g,
		(_, value) => `"session_id":"${mapSession(value)}"`,
	);
	text = text.replace(
		/"threadId"\s*:\s*"([^"]+)"/g,
		(_, value) => `"threadId":"${mapThread(value)}"`,
	);
	text = text.replace(
		/"turnId"\s*:\s*"([^"]+)"/g,
		(_, value) => `"turnId":"${mapTurn(value)}"`,
	);
	text = text.replace(
		/-Users-[A-Za-z0-9-]+-testdata-fixture-dummy-repo/g,
		"-dummy-repo",
	);
	return text;
}

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
const captureCwd = process.env.CAPTURE_CWD ?? process.cwd();
const appRepoRoot = resolve(import.meta.dir, "../..");

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
			cwd: captureCwd,
			resume: undefined,
			permissionMode: process.env.CAPTURE_PERMISSION_MODE,
			effortLevel: process.env.CAPTURE_EFFORT,
			claudeThinkingDisplay:
				process.env.CAPTURE_THINKING_DISPLAY === "omitted" ||
				process.env.CAPTURE_THINKING_DISPLAY === "summarized"
					? process.env.CAPTURE_THINKING_DISPLAY
					: undefined,
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

// Sanitize the whole file in ONE pass so id mappers stay consistent across
// lines (per-line mapping used to collapse every toolu_*/msg_* to *_1,
// destroying tool_use/tool_result pairing).
const sanitized = sanitizeFixtureText(
	lines.join("\n"),
	appRepoRoot,
	captureCwd,
);

writeFileSync(outputAbs, `${sanitized}\n`);
console.error(`[capture] wrote ${lines.length} events to ${outputAbs}`);
