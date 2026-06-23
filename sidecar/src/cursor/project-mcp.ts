/**
 * MCP server discovery for Cursor.
 *
 * Helmor runs `@cursor/sdk` without `settingSources`, so the SDK never
 * auto-loads `~/.cursor/mcp.json` (user) or `<repo>/.cursor/mcp.json`
 * (project). We read them here and inject via `mcpServers` — the same
 * approach as Claude's `project-mcp`. User scope is the common case
 * (Linear etc. live in `~/.cursor/mcp.json`); project scope merges on top
 * when a source-repo path is known.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@cursor/sdk";

import { errorDetails, logger } from "../logger.js";

export type CursorMcpServers = Record<string, McpServerConfig>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read `mcpServers` from one `mcp.json`. Missing file → `undefined`
 *  (silent — legit on a fresh box); malformed JSON → warn + `undefined`.
 *  Best-effort. */
function readMcpFile(configPath: string): CursorMcpServers | undefined {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		logger.info(`Failed to parse ${configPath} — skipping its MCPs`, {
			configPath,
			...errorDetails(err),
		});
		return undefined;
	}

	if (!isObject(parsed) || !isObject(parsed.mcpServers)) return undefined;
	const servers = parsed.mcpServers;
	if (Object.keys(servers).length === 0) return undefined;
	// Trust the SDK to validate per-server shape — we only guarantee a
	// non-empty object keyed by server name.
	return servers as CursorMcpServers;
}

/**
 * Merge Cursor's user-scope (`~/.cursor/mcp.json`) and project-scope
 * (`<sourceRepoPath>/.cursor/mcp.json`) MCP servers. Project entries win on
 * a name collision, matching Cursor's own precedence. Returns `undefined`
 * when neither file contributes a server.
 */
export function loadCursorMcpServers(
	sourceRepoPath: string | undefined,
): CursorMcpServers | undefined {
	// POSIX `$HOME` first (matches Cursor + Node's homedir on macOS/Linux);
	// `homedir()` is the fallback.
	const home = process.env.HOME || homedir();
	const user = readMcpFile(join(home, ".cursor", "mcp.json"));
	const project = sourceRepoPath
		? readMcpFile(join(sourceRepoPath, ".cursor", "mcp.json"))
		: undefined;
	if (!user && !project) return undefined;
	return { ...user, ...project };
}
