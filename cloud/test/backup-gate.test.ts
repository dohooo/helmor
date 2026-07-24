/// <reference types="@cloudflare/vitest-pool-workers/types" />
// DF-4 backup gate suite. Every agent-stream close used to trigger an
// unconditional /home/helmor snapshot (measured at 48MB×3s) — including
// streams that did NO work. After the DF-4 error-surface fix, a failed turn
// carries exactly one `{"kind":"error"}` terminal event, so a byte-based
// "did anything flow?" predicate would immediately re-qualify empty turns
// for backup. The gate therefore classifies LINES: keepalive blanks and
// error events are not backup-worthy; any other event (update/done/…) is.
//
// The interlock test pins the架构师-mandated pair: a failed turn EMITS an
// error event (companion side, anchored in companion/stream.rs tests) AND
// still SKIPS the backup (this suite).

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { backupAfterStream, isBackupWorthyLine } from "../src/index";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
		}
	}
}

type SandboxParam = Parameters<typeof backupAfterStream>[1];

const ERROR_EVENT =
	'{"kind":"error","message":"workingDirectory is required but was not provided","persisted":false,"internal":false}';
const UPDATE_EVENT = '{"kind":"update","messages":[]}';
const DONE_EVENT = '{"kind":"done","provider":"claude","persisted":true}';

function makeEnv(): Env {
	return {
		DB: env.DB,
		HELMOR_SANDBOX_ID: "helmor-team-test",
	} as unknown as Env;
}

function makeSandbox(calls: string[]): SandboxParam {
	return {
		createBackup: async (opts: { name: string }) => {
			calls.push(opts.name);
			return { backupId: "b1" };
		},
	} as unknown as SandboxParam;
}

/** NDJSON body from chunks — one enqueue per element, like the real tee. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

beforeEach(async () => {
	await env.DB.exec(
		"CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, sandbox_id TEXT, backup_handle TEXT)",
	);
	await env.DB.exec("DELETE FROM teams");
});

describe("post-stream backup gate (DF-4)", () => {
	it("failed turn: terminal error event + keepalives only → backup SKIPPED", async () => {
		// The DF-4 interlock: the error event that makes the failure VISIBLE
		// must not re-qualify the empty turn for a snapshot.
		const calls: string[] = [];
		await backupAfterStream(
			streamOf(["\n", `${ERROR_EVENT}\n`, "\n"]),
			makeSandbox(calls),
			makeEnv(),
		);
		expect(calls).toEqual([]);
	});

	it("keepalive-only stream → backup skipped", async () => {
		const calls: string[] = [];
		await backupAfterStream(
			streamOf(["\n", "\n", "\n"]),
			makeSandbox(calls),
			makeEnv(),
		);
		expect(calls).toEqual([]);
	});

	it("real turn (update/done events) → backup runs once", async () => {
		const calls: string[] = [];
		await backupAfterStream(
			streamOf(["\n", `${UPDATE_EVENT}\n`, `${DONE_EVENT}\n`]),
			makeSandbox(calls),
			makeEnv(),
		);
		expect(calls).toHaveLength(1);
	});

	it("event split across chunks still counts as work", async () => {
		const calls: string[] = [];
		const half = Math.floor(UPDATE_EVENT.length / 2);
		await backupAfterStream(
			streamOf([UPDATE_EVENT.slice(0, half), `${UPDATE_EVENT.slice(half)}\n`]),
			makeSandbox(calls),
			makeEnv(),
		);
		expect(calls).toHaveLength(1);
	});

	it("aborted stream → conservative backup (stale snapshot beats none)", async () => {
		const calls: string[] = [];
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("\n"));
				controller.error(new Error("client dropped"));
			},
		});
		await backupAfterStream(body, makeSandbox(calls), makeEnv());
		expect(calls).toHaveLength(1);
	});
});

describe("isBackupWorthyLine", () => {
	it("classifies keepalives and error events as not worthy", () => {
		expect(isBackupWorthyLine("")).toBe(false);
		expect(isBackupWorthyLine("  ")).toBe(false);
		expect(isBackupWorthyLine(ERROR_EVENT)).toBe(false);
		expect(isBackupWorthyLine(UPDATE_EVENT)).toBe(true);
		expect(isBackupWorthyLine(DONE_EVENT)).toBe(true);
	});
});
