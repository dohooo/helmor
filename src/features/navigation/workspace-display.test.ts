import { describe, expect, it } from "vitest";
import type { WorkspaceRow } from "@/lib/api";
import { deriveWorkspaceDisplay } from "./workspace-display";

function makeRow(extra?: Partial<WorkspaceRow>): WorkspaceRow {
	return { id: "ws-1", title: "row-title", ...extra };
}

describe("deriveWorkspaceDisplay", () => {
	it("uses PR title when present (whitespace trimmed)", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({
				prTitle: "  feat: Arc switcher  ",
				primarySessionTitle: "session title",
				branch: "feature/x",
			}),
		);
		expect(display.title).toBe("feat: Arc switcher");
		expect(display.prTitle).toBe("feat: Arc switcher");
	});

	it("falls back to primary session title when PR is missing", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({
				primarySessionTitle: "primary",
				activeSessionTitle: "active",
			}),
		);
		expect(display.title).toBe("primary");
	});

	it("falls back to active session title when primary is missing", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({ activeSessionTitle: "active" }),
		);
		expect(display.title).toBe("active");
	});

	it("treats 'Untitled' session titles as missing", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({
				primarySessionTitle: "Untitled",
				activeSessionTitle: "Untitled",
				branch: "feature/x",
			}),
		);
		expect(display.title).toBe("X");
	});

	it("falls back to humanized branch when no session/PR title", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({ branch: "feature/cmd-tab-switcher" }),
		);
		expect(display.title).toBe("Cmd Tab Switcher");
	});

	it("falls back to raw row.title only as last resort", () => {
		const display = deriveWorkspaceDisplay(makeRow({ title: "raw-row" }));
		expect(display.title).toBe("raw-row");
	});

	it("subtitle = 'repo › branch' when both present", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({ repoName: "helmor", branch: "feature/x" }),
		);
		expect(display.subtitle).toBe("helmor › feature/x");
	});

	it("subtitle falls back to directoryName when repoName missing", () => {
		const display = deriveWorkspaceDisplay(
			makeRow({ directoryName: "dir", branch: "feature/x" }),
		);
		expect(display.subtitle).toBe("dir › feature/x");
	});

	it("subtitle = repo only when branch missing", () => {
		const display = deriveWorkspaceDisplay(makeRow({ repoName: "helmor" }));
		expect(display.subtitle).toBe("helmor");
	});

	it("subtitle = branch only when repo missing", () => {
		const display = deriveWorkspaceDisplay(makeRow({ branch: "feature/x" }));
		expect(display.subtitle).toBe("feature/x");
	});

	it("subtitle is null when neither repo nor branch present", () => {
		const display = deriveWorkspaceDisplay(makeRow());
		expect(display.subtitle).toBeNull();
	});
});
