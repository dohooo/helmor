import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	discardWorkspaceFile,
	stageWorkspaceFile,
	unstageWorkspaceFile,
} from "@/lib/api";
import type { InspectorFileItem } from "@/lib/editor-session";
import { renderWithProviders } from "@/test/render-with-providers";
import { ChangesSection } from "./changes";

vi.mock("@tauri-apps/plugin-opener", () => ({
	openUrl: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		discardWorkspaceFile: vi.fn().mockResolvedValue(undefined),
		revealPathInFinder: vi.fn().mockResolvedValue(undefined),
		stageWorkspaceFile: vi.fn().mockResolvedValue(undefined),
		unstageWorkspaceFile: vi.fn().mockResolvedValue(undefined),
	};
});

const stageWorkspaceFileMock = vi.mocked(stageWorkspaceFile);
const unstageWorkspaceFileMock = vi.mocked(unstageWorkspaceFile);
const discardWorkspaceFileMock = vi.mocked(discardWorkspaceFile);

function change(
	path: string,
	patch: Partial<InspectorFileItem> = {},
): InspectorFileItem {
	return {
		path,
		absolutePath: `/workspace/${path}`,
		name: path.split("/").at(-1) ?? path,
		status: "M",
		stagedInsertions: 0,
		stagedDeletions: 0,
		unstagedInsertions: 3,
		unstagedDeletions: 1,
		committedInsertions: 0,
		committedDeletions: 0,
		stagedStatus: null,
		unstagedStatus: "M",
		committedStatus: null,
		...patch,
	};
}

function renderChanges(
	changes: InspectorFileItem[],
	overrides: Partial<React.ComponentProps<typeof ChangesSection>> = {},
) {
	return renderWithProviders(
		<ChangesSection
			workspaceId={null}
			workspaceRootPath="/workspace"
			workspaceBranch="feature"
			workspaceRemoteUrl={null}
			workspaceTargetBranch="main"
			changes={changes}
			editorMode={false}
			activeEditorPath={null}
			onOpenEditorFile={vi.fn()}
			flashingPaths={new Set()}
			changeRequest={null}
			bodyHeight={320}
			hideGitSectionHeader
			{...overrides}
		/>,
	);
}

describe("ChangesSection change group actions", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("keeps the bulk action icons clickable without opening or collapsing the group", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		const onOpenEditorFile = vi.fn();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderChanges(
			[
				change("src/app.tsx"),
				change("src/ready.ts", {
					stagedInsertions: 2,
					stagedDeletions: 0,
					unstagedInsertions: 0,
					unstagedDeletions: 0,
					stagedStatus: "M",
					unstagedStatus: null,
				}),
			],
			{ onOpenEditorFile },
		);

		const stageAll = screen.getByRole("button", { name: "Stage all" });
		const unstageAll = screen.getByRole("button", { name: "Unstage all" });
		const revertChanges = screen.getByRole("button", {
			name: "Revert changes",
		});
		expect(stageAll).not.toHaveAttribute("aria-disabled", "true");
		expect(unstageAll).not.toHaveAttribute("aria-disabled", "true");
		expect(revertChanges).not.toHaveAttribute("aria-disabled", "true");

		await user.click(stageAll);
		await user.click(unstageAll);
		await user.click(revertChanges);

		await waitFor(() => {
			expect(stageWorkspaceFileMock).toHaveBeenCalledWith(
				"/workspace",
				"src/app.tsx",
			);
			expect(unstageWorkspaceFileMock).toHaveBeenCalledWith(
				"/workspace",
				"src/ready.ts",
			);
			expect(discardWorkspaceFileMock).toHaveBeenCalledWith(
				"/workspace",
				"src/app.tsx",
			);
		});
		expect(confirm).toHaveBeenCalled();
		expect(onOpenEditorFile).not.toHaveBeenCalled();
		expect(screen.getByText("app.tsx")).toBeInTheDocument();
		expect(screen.getByText("ready.ts")).toBeInTheDocument();
	});

	it("makes the group collapse target fill the header space before the action icons", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderChanges([change("src/app.tsx")]);

		const collapseButton = screen.getByRole("button", {
			name: "Collapse group",
		});
		expect(collapseButton).toHaveClass("flex-1");

		await user.click(collapseButton);

		expect(screen.queryByText("app.tsx")).not.toBeInTheDocument();
	});

	it("keeps per-file icons clickable without opening the file row", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		const onOpenEditorFile = vi.fn();
		renderChanges([change("src/app.tsx")], { onOpenEditorFile });

		await user.click(screen.getByRole("button", { name: "Stage file" }));
		await user.click(
			screen.getByRole("button", { name: "Discard file changes" }),
		);

		await waitFor(() => {
			expect(stageWorkspaceFileMock).toHaveBeenCalledWith(
				"/workspace",
				"src/app.tsx",
			);
			expect(discardWorkspaceFileMock).toHaveBeenCalledWith(
				"/workspace",
				"src/app.tsx",
			);
		});
		expect(onOpenEditorFile).not.toHaveBeenCalled();
	});

	it("renders group action icons for branch-only diff entries", () => {
		renderChanges(
			[
				change("src/app.tsx", {
					unstagedInsertions: 0,
					unstagedDeletions: 0,
					unstagedStatus: null,
					committedInsertions: 4,
					committedDeletions: 0,
					committedStatus: "M",
				}),
			],
			{ filter: "all" },
		);

		const stageAll = screen.getByRole("button", { name: "Stage all" });
		const revertChanges = screen.getByRole("button", {
			name: "Revert changes",
		});
		expect(stageAll).not.toHaveAttribute("aria-disabled", "true");
		expect(revertChanges).not.toHaveAttribute("aria-disabled", "true");
	});
});
