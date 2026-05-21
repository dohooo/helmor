import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import type { ChangeListGroup, ChangeRow } from "./types";
import { VirtualizedChangesList } from "./virtualized-changes-list";

vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: (opts: {
		count: number;
		estimateSize: (index: number) => number;
		getItemKey: (index: number) => string | number;
	}) => {
		let offset = 0;
		const items = Array.from(
			{ length: Math.min(opts.count, 8) },
			(_, index) => {
				const size = opts.estimateSize(index);
				const start = offset;
				offset += size;
				return { index, key: opts.getItemKey(index), size, start };
			},
		);
		return {
			getVirtualItems: () => items,
			getTotalSize: () => opts.count * 21,
			scrollToIndex: () => {},
		};
	},
}));

describe("VirtualizedChangesList", () => {
	it("renders only the virtual window for a large expanded tree", () => {
		const onOpenEditorFile = vi.fn();
		const changes = Array.from({ length: 500 }, (_, index) =>
			makeChange(`src/dir-${Math.floor(index / 10)}/file-${index}.ts`, index),
		);
		const groups: ChangeListGroup[] = [
			{
				id: "branch",
				label: "Remote",
				count: changes.length,
				open: true,
				changes,
				treeView: true,
				onToggle: vi.fn(),
				onToggleTreeView: vi.fn(),
				originalRef: "main",
				modifiedRef: "HEAD",
			},
		];

		renderWithProviders(
			<VirtualizedChangesList
				groups={groups}
				editorMode={false}
				onOpenEditorFile={onOpenEditorFile}
				onOpenExternalEditor={vi.fn()}
				flashingPaths={new Set()}
				workspaceBranch="feature"
				workspaceRemoteUrl="https://github.com/acme/repo.git"
			/>,
		);

		expect(screen.getByRole("button", { name: /Remote/ })).toBeInTheDocument();
		expect(screen.getByRole("treeitem", { name: "src" })).toHaveStyle({
			paddingLeft: "20px",
		});
		expect(screen.getByText("file-0.ts")).toBeInTheDocument();
		expect(screen.queryByText("file-499.ts")).not.toBeInTheDocument();

		fireEvent.click(screen.getByText("file-0.ts"));

		expect(onOpenEditorFile).toHaveBeenCalledWith(
			"/tmp/workspace/src/dir-0/file-0.ts",
			{
				fileStatus: "M",
				originalRef: "main",
				modifiedRef: "HEAD",
			},
		);
	});

	it("keeps flat file rows indented under the group header", () => {
		const changes = [makeChange("src/file.ts", 0)];
		const groups: ChangeListGroup[] = [
			{
				id: "unstaged",
				label: "Changes",
				count: changes.length,
				open: true,
				changes,
				treeView: false,
				onToggle: vi.fn(),
				onToggleTreeView: vi.fn(),
				originalRef: ":0",
			},
		];

		renderWithProviders(
			<VirtualizedChangesList
				groups={groups}
				editorMode={false}
				onOpenEditorFile={vi.fn()}
				onOpenExternalEditor={vi.fn()}
				flashingPaths={new Set()}
				workspaceBranch="feature"
				workspaceRemoteUrl="https://github.com/acme/repo.git"
			/>,
		);

		expect(screen.getByText("file.ts").closest('[role="button"]')).toHaveClass(
			"pl-5",
		);
	});

	it("dims loading group content without dimming the group header", () => {
		const changes = [makeChange("src/file.ts", 0)];
		const groups: ChangeListGroup[] = [
			{
				id: "branch",
				label: "Remote",
				count: changes.length,
				open: true,
				loading: true,
				changes,
				treeView: false,
				onToggle: vi.fn(),
				onToggleTreeView: vi.fn(),
				originalRef: "main",
				modifiedRef: "HEAD",
			},
		];

		renderWithProviders(
			<VirtualizedChangesList
				groups={groups}
				editorMode={false}
				onOpenEditorFile={vi.fn()}
				onOpenExternalEditor={vi.fn()}
				flashingPaths={new Set()}
				workspaceBranch="feature"
				workspaceRemoteUrl="https://github.com/acme/repo.git"
			/>,
		);

		const remoteHeaderButton = screen
			.getAllByRole("button", { name: /Remote/ })
			.at(-1);
		const fileRow = screen.getAllByText("file.ts").at(-1);

		expect(remoteHeaderButton?.parentElement).not.toHaveClass("opacity-40");
		expect(fileRow?.closest('[role="button"]')?.parentElement).toHaveClass(
			"transition-opacity",
			"duration-150",
			"opacity-40",
		);
	});
});

function makeChange(path: string, index: number): ChangeRow {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		name,
		path,
		absolutePath: `/tmp/workspace/${path}`,
		status: "M",
		insertions: index + 1,
		deletions: 0,
		stagedStatus: null,
		unstagedStatus: null,
		committedStatus: "M",
		stagedInsertions: 0,
		stagedDeletions: 0,
		unstagedInsertions: 0,
		unstagedDeletions: 0,
		committedInsertions: index + 1,
		committedDeletions: 0,
		isBinary: false,
	};
}
