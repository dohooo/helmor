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

	it("codex maps bypassPermissions to approval/sandbox flags", () => {
		const cmd = buildTerminalBootCommand("codex", {
			prompt: "hi",
			permissionMode: "bypassPermissions",
		});
		expect(cmd).toContain("--ask-for-approval never");
		expect(cmd).toContain("--sandbox danger-full-access");
	});

	it("shell-quotes prompts so metacharacters can't escape", () => {
		const cmd = buildTerminalBootCommand("claude", {
			prompt: "it's; $(rm -rf /)",
		});
		expect(cmd).toBe("claude 'it'\\''s; $(rm -rf /)'\n");
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
