#!/usr/bin/env bun
/**
 * Trace the Claude Agent SDK's raw thinking-event stream with timestamps.
 * Writes each event as `<delta_ms>\t<type>\t<payload-summary>` to stdout.
 *
 * Usage:
 *   bun run scripts/trace-thinking-events.ts [prompt]
 */

import { ClaudeSessionManager } from "../src/claude/session-manager.js";
import { createSidecarEmitter } from "../src/emitter.js";

const prompt =
	process.argv[2] ??
	"Think carefully: which is larger, 9.11 or 9.9? Explain briefly.";

const start = Date.now();
const captured: Array<{ dt: number; event: Record<string, unknown> }> = [];
const emitter = createSidecarEmitter((event) => {
	captured.push({
		dt: Date.now() - start,
		event: event as Record<string, unknown>,
	});
});

const manager = new ClaudeSessionManager();

try {
	await manager.sendMessage(
		"trace-request-1",
		{
			sessionId: "trace-session-1",
			prompt,
			model: process.env.CAPTURE_MODEL,
			cwd: process.cwd(),
			resume: undefined,
			permissionMode: "bypassPermissions",
			effortLevel: process.env.CAPTURE_EFFORT ?? "low",
		},
		emitter,
	);
} catch (err) {
	console.error(
		`[trace] error: ${err instanceof Error ? err.message : String(err)}`,
	);
}

function summarize(event: Record<string, unknown>): string {
	const t = event.type as string | undefined;
	if (t === "stream_event") {
		const inner = (event.event as Record<string, unknown>) ?? {};
		const it = inner.type as string | undefined;
		const idx = inner.index as number | undefined;
		if (it === "content_block_start") {
			const cb = (inner.content_block as Record<string, unknown>) ?? {};
			return `stream_event.content_block_start idx=${idx} type=${cb.type}`;
		}
		if (it === "content_block_delta") {
			const d = (inner.delta as Record<string, unknown>) ?? {};
			const dt = d.type as string | undefined;
			let preview = "";
			if (dt === "thinking_delta")
				preview = ` thinking="${(d.thinking as string).slice(0, 40)}..."`;
			if (dt === "text_delta")
				preview = ` text="${(d.text as string).slice(0, 40)}..."`;
			return `stream_event.content_block_delta idx=${idx} type=${dt}${preview}`;
		}
		if (it === "content_block_stop") {
			return `stream_event.content_block_stop idx=${idx}`;
		}
		return `stream_event.${it} idx=${idx ?? "-"}`;
	}
	if (t === "assistant") {
		const msg = (event.message as Record<string, unknown>) ?? {};
		const content = (msg.content as Array<Record<string, unknown>>) ?? [];
		const types = content.map((c) => c.type).join(",");
		return `assistant [${types}]`;
	}
	if (t === "user") {
		return `user`;
	}
	if (t === "result") {
		return `result ${event.subtype}`;
	}
	if (t === "system") {
		return `system ${event.subtype}`;
	}
	return `${t}`;
}

console.error(`[trace] captured ${captured.length} events`);
for (const { dt, event } of captured) {
	console.log(
		`${String(dt).padStart(6)}ms\t${event.type ?? "?"}\t${summarize(event)}`,
	);
}

process.exit(0);
