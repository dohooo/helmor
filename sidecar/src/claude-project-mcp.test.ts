import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadProjectMcpServers } from "./claude-project-mcp.js";

const REPO = "/Users/test/projects/sample";

describe("loadProjectMcpServers", () => {
	let dir: string;
	let prev: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "claude-mcp-test-"));
		prev = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = dir;
	});

	afterEach(() => {
		if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	const writeConfig = (content: string) => {
		writeFileSync(join(dir, ".claude.json"), content);
	};

	it("returns undefined when sourceRepoPath is missing", () => {
		writeConfig(
			JSON.stringify({ projects: { [REPO]: { mcpServers: { x: {} } } } }),
		);
		expect(loadProjectMcpServers(undefined)).toBeUndefined();
	});

	it("returns undefined when ~/.claude.json is absent", () => {
		expect(loadProjectMcpServers(REPO)).toBeUndefined();
	});

	it("returns undefined for malformed JSON", () => {
		writeConfig("not-json");
		expect(loadProjectMcpServers(REPO)).toBeUndefined();
	});

	it("returns undefined when project key is unknown", () => {
		writeConfig(JSON.stringify({ projects: {} }));
		expect(loadProjectMcpServers(REPO)).toBeUndefined();
	});

	it("returns undefined when mcpServers is empty", () => {
		writeConfig(JSON.stringify({ projects: { [REPO]: { mcpServers: {} } } }));
		expect(loadProjectMcpServers(REPO)).toBeUndefined();
	});

	it("returns the project's mcpServers when configured", () => {
		const server = {
			type: "stdio" as const,
			command: "node",
			args: ["/abs/server.js"],
			env: {},
		};
		writeConfig(
			JSON.stringify({
				projects: { [REPO]: { mcpServers: { demo: server } } },
			}),
		);
		expect(loadProjectMcpServers(REPO)).toEqual({ demo: server });
	});

	it("ignores unrelated keys at the project entry", () => {
		writeConfig(
			JSON.stringify({
				projects: {
					[REPO]: {
						allowedTools: [],
						mcpServers: { demo: { type: "stdio", command: "x" } },
					},
				},
			}),
		);
		expect(loadProjectMcpServers(REPO)).toEqual({
			demo: { type: "stdio" as const, command: "x" },
		});
	});

	it("uses CLAUDE_CONFIG_DIR override", () => {
		// Different dir written to via CLAUDE_CONFIG_DIR set in beforeEach.
		const altDir = mkdtempSync(join(tmpdir(), "claude-mcp-alt-"));
		try {
			mkdirSync(altDir, { recursive: true });
			writeFileSync(
				join(altDir, ".claude.json"),
				JSON.stringify({
					projects: {
						[REPO]: { mcpServers: { x: { type: "stdio", command: "alt" } } },
					},
				}),
			);
			process.env.CLAUDE_CONFIG_DIR = altDir;
			expect(loadProjectMcpServers(REPO)).toEqual({
				x: { type: "stdio" as const, command: "alt" },
			});
		} finally {
			rmSync(altDir, { recursive: true, force: true });
		}
	});
});
