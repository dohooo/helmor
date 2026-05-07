/**
 * Project-scope MCP server discovery for Claude.
 *
 * Claude Agent SDK looks up project-scope MCP servers in
 * `~/.claude.json` keyed by `cwd`. Helmor sessions run in the workspace
 * worktree (never matches the user's registered project path), so the
 * SDK only surfaces user-scope MCPs by default. Helmor passes the
 * source repo `root_path` separately and we pull `projects[<root>]
 * .mcpServers` here, then inject via `options.mcpServers`.
 *
 * `CLAUDE_CONFIG_DIR` env override is honored to mirror SDK behavior.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

import { errorDetails, logger } from "./logger.js";

export type ProjectMcpServers = Record<string, McpServerConfig>;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveClaudeConfigPath(): string {
	const dir = process.env.CLAUDE_CONFIG_DIR ?? homedir();
	return join(dir, ".claude.json");
}

/**
 * Read project-scope `mcpServers` for the given source-repo path.
 * Returns `undefined` when the file is missing/unreadable, when the
 * project key isn't registered, or when no MCPs are configured for it.
 * Malformed JSON logs a warning then returns `undefined` — best-effort.
 */
export function loadProjectMcpServers(
	sourceRepoPath: string | undefined,
): ProjectMcpServers | undefined {
	if (!sourceRepoPath) return undefined;
	const configPath = resolveClaudeConfigPath();

	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		// File absent / no read permission — both legit on a fresh box.
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		logger.info("Failed to parse ~/.claude.json — skipping project MCPs", {
			configPath,
			...errorDetails(err),
		});
		return undefined;
	}

	if (!isObject(parsed)) return undefined;
	const projects = parsed.projects;
	if (!isObject(projects)) return undefined;
	const project = projects[sourceRepoPath];
	if (!isObject(project)) return undefined;
	const mcpServers = project.mcpServers;
	if (!isObject(mcpServers) || Object.keys(mcpServers).length === 0) {
		return undefined;
	}
	// Trust the SDK to validate per-server shape — we only guarantee it's
	// a non-empty object keyed by server name.
	return mcpServers as ProjectMcpServers;
}
