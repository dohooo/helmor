import { describe, expect, test } from "bun:test";
import {
	applyWindowsPathFromRegistry,
	parseWindowsRegistryPathValue,
	prependPathSegment,
} from "../src/agent-path-env.js";
import { buildClaudeBaseEnv } from "../src/claude/session-manager.js";
import { buildOpencodeEnv } from "../src/opencode-protocol/server.js";

describe("agent PATH env helpers", () => {
	test("merges Windows machine, user, and current PATH with expansion", () => {
		const env = applyWindowsPathFromRegistry(
			{
				Path: "C:\\Existing\\bin;C:\\Users\\dildev\\bin",
				SystemRoot: "C:\\Windows",
				USERPROFILE: "C:\\Users\\dildev",
			},
			{
				platform: "win32",
				readWindowsRegistryPath: (scope) =>
					scope === "machine"
						? "%SystemRoot%\\System32;C:\\Machine\\Tools"
						: "%USERPROFILE%\\bin;C:\\Existing\\bin",
			},
		);

		expect(env.Path?.split(";")).toEqual([
			"C:\\Windows\\System32",
			"C:\\Machine\\Tools",
			"C:\\Users\\dildev\\bin",
			"C:\\Existing\\bin",
		]);
		expect(env.PATH).toBeUndefined();
	});

	test("prepends provider tool paths without duplicating existing PATH entries", () => {
		const env = { Path: "C:\\Tools;C:\\Windows\\System32" };
		prependPathSegment(env, "c:\\tools", "win32");

		expect(env.Path?.split(";")).toEqual([
			"c:\\tools",
			"C:\\Windows\\System32",
		]);
	});

	test("keeps non-Windows env untouched", () => {
		const env = applyWindowsPathFromRegistry(
			{ PATH: "/usr/bin" },
			{
				platform: "darwin",
				readWindowsRegistryPath: () => {
					throw new Error("registry should not be read");
				},
			},
		);

		expect(env.PATH).toBe("/usr/bin");
	});

	test("parses Windows registry PATH query output", () => {
		expect(
			parseWindowsRegistryPathValue(`
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment
    Path    REG_EXPAND_SZ    %SystemRoot%\\System32;C:\\Tools
`),
		).toBe("%SystemRoot%\\System32;C:\\Tools");
	});
});

describe("provider env builders", () => {
	test("Claude query env includes Windows PATH merge even with no overrides", () => {
		const env = buildClaudeBaseEnv(
			{ Path: "C:\\Claude\\bin" },
			{
				platform: "win32",
				readWindowsRegistryPath: (scope) =>
					scope === "machine" ? "C:\\Windows\\System32" : "C:\\User\\bin",
			},
		);

		expect(env?.Path?.split(";")).toContain("C:\\Claude\\bin");
	});

	test("OpenCode server env includes Windows PATH merge", () => {
		const env = buildOpencodeEnv(
			{ Path: "C:\\OpenCode\\bin" },
			{
				platform: "win32",
				readWindowsRegistryPath: (scope) =>
					scope === "machine" ? "C:\\Windows\\System32" : "C:\\User\\bin",
			},
		);

		expect(env.Path?.split(";")).toContain("C:\\OpenCode\\bin");
	});
});
