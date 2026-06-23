import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCursorMcpServers } from "./project-mcp.js";

function writeMcp(dir: string, contents: string) {
	mkdirSync(join(dir, ".cursor"), { recursive: true });
	writeFileSync(join(dir, ".cursor", "mcp.json"), contents);
}

describe("loadCursorMcpServers", () => {
	let home: string;
	let repo: string;
	const origHome = process.env.HOME;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cursor-home-"));
		repo = mkdtempSync(join(tmpdir(), "cursor-repo-"));
		process.env.HOME = home;
	});

	afterEach(() => {
		if (origHome === undefined) delete process.env.HOME;
		else process.env.HOME = origHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(repo, { recursive: true, force: true });
	});

	test("returns undefined when nothing is configured", () => {
		expect(loadCursorMcpServers(undefined)).toBeUndefined();
		expect(loadCursorMcpServers(repo)).toBeUndefined();
	});

	test("reads user-scope ~/.cursor/mcp.json", () => {
		writeMcp(
			home,
			JSON.stringify({
				mcpServers: { linear: { url: "https://mcp.linear.app/sse" } },
			}),
		);
		expect(loadCursorMcpServers(undefined)).toEqual({
			linear: { url: "https://mcp.linear.app/sse" },
		});
	});

	test("merges project-scope on top of user-scope (project wins)", () => {
		writeMcp(
			home,
			JSON.stringify({
				mcpServers: {
					a: { url: "https://user" },
					shared: { url: "https://user-shared" },
				},
			}),
		);
		writeMcp(
			repo,
			JSON.stringify({
				mcpServers: {
					b: { command: "x" },
					shared: { url: "https://project-shared" },
				},
			}),
		);
		expect(loadCursorMcpServers(repo)).toEqual({
			a: { url: "https://user" },
			b: { command: "x" },
			shared: { url: "https://project-shared" },
		});
	});

	test("ignores malformed JSON (best-effort)", () => {
		writeMcp(home, "{ not json");
		expect(loadCursorMcpServers(undefined)).toBeUndefined();
	});

	test("ignores an empty mcpServers object", () => {
		writeMcp(home, JSON.stringify({ mcpServers: {} }));
		expect(loadCursorMcpServers(undefined)).toBeUndefined();
	});
});
