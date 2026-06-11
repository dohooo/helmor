import { describe, expect, it } from "vitest";
import {
	buildTerminalBootCommand,
	findTerminalAgent,
	presetBootCommand,
	resumeBootCommand,
} from "./terminal-presets";

describe("terminal agent specs", () => {
	it("covers claude/codex only and rejects others", () => {
		for (const key of ["claude", "codex"]) {
			expect(findTerminalAgent(key), key).not.toBeNull();
		}
		expect(findTerminalAgent("cursor")).toBeNull();
		expect(findTerminalAgent("opencode")).toBeNull();
		expect(findTerminalAgent("openclaude")).toBeNull();
		expect(findTerminalAgent(null)).toBeNull();
	});

	it("claude boot carries composer state and the prompt", () => {
		const cmd = buildTerminalBootCommand("claude", {
			prompt: "fix the bug",
			modelId: "sonnet",
			effortLevel: "high",
			permissionMode: "plan",
		});
		expect(cmd).toBe(
			"claude --model 'sonnet' --effort 'high' --permission-mode 'plan' 'fix the bug'\n",
		);
	});

	it("claude carries linked directories via --add-dir on boot and resume", () => {
		const boot = buildTerminalBootCommand("claude", {
			prompt: "hi",
			addDirs: ["/repo/a", "/with space/b"],
		});
		expect(boot).toBe(
			"claude --add-dir '/repo/a' --add-dir '/with space/b' 'hi'\n",
		);
		const resume = resumeBootCommand("claude", "id-1", {
			addDirs: ["/repo/a"],
		});
		expect(resume).toBe(
			"claude --resume 'id-1' --dangerously-skip-permissions --add-dir '/repo/a'\n",
		);
	});

	it("codex ignores addDirs (full-access sandbox reaches them anyway)", () => {
		const cmd = buildTerminalBootCommand("codex", {
			prompt: "hi",
			addDirs: ["/repo/a"],
		});
		expect(cmd).not.toContain("--add-dir");
		expect(cmd).not.toContain("/repo/a");
	});

	it("codex maps bypassPermissions to approval/sandbox flags", () => {
		const cmd = buildTerminalBootCommand("codex", {
			prompt: "hi",
			permissionMode: "bypassPermissions",
		});
		expect(cmd).toContain("--ask-for-approval never");
		expect(cmd).toContain("--sandbox danger-full-access");
	});

	it("codex maps fast mode to the service_tier config", () => {
		const fast = buildTerminalBootCommand("codex", {
			prompt: "hi",
			fastMode: true,
		});
		expect(fast).toContain(`-c 'service_tier="fast"'`);
		const slow = buildTerminalBootCommand("codex", { prompt: "hi" });
		expect(slow).not.toContain("service_tier");
	});

	it("never passes the 'default' placeholder as a real model", () => {
		for (const provider of ["claude", "codex"]) {
			const cmd = buildTerminalBootCommand(provider, {
				prompt: "hi",
				modelId: "default",
			});
			expect(cmd, provider).not.toContain("default");
		}
	});

	it("shell-quotes prompts so metacharacters can't escape", () => {
		const cmd = buildTerminalBootCommand("claude", {
			prompt: "it's; $(rm -rf /)",
		});
		expect(cmd).toBe("claude 'it'\\''s; $(rm -rf /)'\n");
	});

	it("ANSI-C quotes multi-line prompts so the boot stays one physical line", () => {
		const cmd = buildTerminalBootCommand("claude", {
			prompt: "line one\nline two\twith tab\nit's fine",
		});
		// $'...' keeps the command on a single physical line — the only newline
		// is the trailing submit; \n/\t/' are escaped, so none reach the
		// interactive shell's line editor early.
		expect(cmd).toBe(
			"claude $'line one\\nline two\\twith tab\\nit\\'s fine'\n",
		);
	});

	it("keeps plain single-line prompts on the portable single-quote path", () => {
		const cmd = buildTerminalBootCommand("codex", { prompt: "fix the bug" });
		expect(cmd).toContain("'fix the bug'");
		expect(cmd).not.toContain("$'");
	});

	it("resume quotes the session id and is null for unknown agents", () => {
		expect(resumeBootCommand("claude", "abc-123")).toBe(
			"claude --resume 'abc-123' --dangerously-skip-permissions\n",
		);
		expect(resumeBootCommand("opencode", "id")).toBeNull();
		expect(resumeBootCommand("gemini", "id")).toBeNull();
	});

	it("preset fallback launches the bare CLI", () => {
		expect(presetBootCommand("claude")).toBe(
			"claude --dangerously-skip-permissions\n",
		);
		expect(presetBootCommand(null)).toBeNull();
	});
});
