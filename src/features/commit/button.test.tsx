import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceCommitButton } from "./button";

afterEach(() => {
	cleanup();
});

// Regression guard: 17134e3 originally rendered merged + closed as ghost
// (transparent bg + accent border/text). 380febc accidentally flipped
// merged to filled `#8957E5`, closed followed. Both must stay outline +
// transparent + pure accent so they read as "settled" alongside the
// matching PR badge / Continue button instead of as a loud filled CTA.
describe("WorkspaceCommitButton ghost variants", () => {
	it("renders merged as accent ghost (outline + transparent bg + pure accent)", () => {
		render(<WorkspaceCommitButton mode="merged" state="idle" />);
		const btn = screen.getByRole("button", { name: /merged/i });
		expect(btn).toHaveAttribute("data-variant", "outline");
		expect(btn.className).toContain("bg-transparent");
		expect(btn.className).toContain(
			"border-[var(--workspace-pr-merged-accent)]",
		);
		expect(btn.className).toContain("text-[var(--workspace-pr-merged-accent)]");
	});

	it("renders closed as accent ghost (outline + transparent bg + pure accent)", () => {
		render(<WorkspaceCommitButton mode="closed" state="idle" />);
		const btn = screen.getByRole("button", { name: /closed/i });
		expect(btn).toHaveAttribute("data-variant", "outline");
		expect(btn.className).toContain("bg-transparent");
		expect(btn.className).toContain(
			"border-[var(--workspace-pr-closed-accent)]",
		);
		expect(btn.className).toContain("text-[var(--workspace-pr-closed-accent)]");
	});

	it("renders merge + disabled as green ghost (mergeability computing)", () => {
		render(<WorkspaceCommitButton mode="merge" state="disabled" />);
		const btn = screen.getByRole("button", { name: /merge/i });
		// Same shape as merged/closed — outline + transparent + pure accent.
		expect(btn).toHaveAttribute("data-variant", "outline");
		expect(btn.className).toContain("bg-transparent");
		expect(btn.className).toContain("border-[var(--workspace-pr-open-accent)]");
		expect(btn.className).toContain("text-[var(--workspace-pr-open-accent)]");
	});

	it("renders merge + idle as filled green CTA (actionable)", () => {
		render(<WorkspaceCommitButton mode="merge" state="idle" />);
		const btn = screen.getByRole("button", { name: /merge/i });
		expect(btn).toHaveAttribute("data-variant", "default");
		expect(btn.className).toContain("workspace-pr-open-accent");
		// Filled CTA — no transparent bg.
		expect(btn.className).not.toContain("bg-transparent");
	});

	it("renders running checks as a warning ghost", () => {
		render(<WorkspaceCommitButton mode="checks-running" state="idle" />);
		const btn = screen.getByRole("button", { name: /checks running/i });
		expect(btn).toHaveAttribute("data-variant", "outline");
		expect(btn.className).toContain("bg-transparent");
		expect(btn.className).toContain(
			"border-[var(--workspace-pr-checks-running-accent)]",
		);
		expect(btn.className).toContain(
			"text-[var(--workspace-pr-checks-running-accent)]",
		);
	});

	it("renders blocked merge as a red ghost", () => {
		render(<WorkspaceCommitButton mode="merge-blocked" state="idle" />);
		const btn = screen.getByRole("button", { name: /merge blocked/i });
		expect(btn).toHaveAttribute("data-variant", "outline");
		expect(btn.className).toContain("bg-transparent");
		expect(btn.className).toContain(
			"border-[var(--workspace-pr-closed-accent)]",
		);
		expect(btn.className).toContain("text-[var(--workspace-pr-closed-accent)]");
	});
});
