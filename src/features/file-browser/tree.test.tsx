import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "@/lib/api";

import { Tree } from "./tree";

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		listWorkspaceDirectory: vi.fn(),
	};
});

const mockedList = api.listWorkspaceDirectory as unknown as ReturnType<
	typeof vi.fn
>;

function renderWithClient(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

beforeEach(() => {
	mockedList.mockReset();
});

describe("Tree", () => {
	it("renders top-level entries from list_workspace_directory", async () => {
		mockedList.mockResolvedValueOnce([
			{
				kind: "directory",
				name: "src",
				path: "src",
				absolutePath: "/root/src",
			},
			{
				kind: "file",
				name: "README.md",
				path: "README.md",
				absolutePath: "/root/README.md",
			},
		]);
		renderWithClient(
			<Tree
				workspaceRootPath="/root"
				workspaceId="ws-1"
				onOpenFile={() => {}}
				activeAbsolutePath={null}
				changedPaths={{ files: new Map(), folders: new Map() }}
			/>,
		);
		await waitFor(() => screen.getByText("src"));
		expect(screen.getByText("README.md")).toBeInTheDocument();
	});

	it("expands a folder on click and lazily loads its children", async () => {
		mockedList
			.mockResolvedValueOnce([
				{
					kind: "directory",
					name: "src",
					path: "src",
					absolutePath: "/root/src",
				},
			])
			.mockResolvedValueOnce([
				{
					kind: "file",
					name: "index.ts",
					path: "src/index.ts",
					absolutePath: "/root/src/index.ts",
				},
			]);
		renderWithClient(
			<Tree
				workspaceRootPath="/root"
				workspaceId="ws-1"
				onOpenFile={() => {}}
				activeAbsolutePath={null}
				changedPaths={{ files: new Map(), folders: new Map() }}
			/>,
		);
		await waitFor(() => screen.getByText("src"));
		fireEvent.click(screen.getByText("src"));
		await waitFor(() => expect(mockedList).toHaveBeenCalledTimes(2));
		expect(screen.getByText("index.ts")).toBeInTheDocument();
	});

	it("calls onOpenFile when a file row is clicked", async () => {
		mockedList.mockResolvedValueOnce([
			{
				kind: "file",
				name: "a.ts",
				path: "a.ts",
				absolutePath: "/root/a.ts",
			},
		]);
		const onOpenFile = vi.fn();
		renderWithClient(
			<Tree
				workspaceRootPath="/root"
				workspaceId="ws-1"
				onOpenFile={onOpenFile}
				activeAbsolutePath={null}
				changedPaths={{ files: new Map(), folders: new Map() }}
			/>,
		);
		await waitFor(() => screen.getByText("a.ts"));
		fireEvent.click(screen.getByText("a.ts"));
		expect(onOpenFile).toHaveBeenCalledWith({
			absolutePath: "/root/a.ts",
			relativePath: "a.ts",
			fileName: "a.ts",
		});
	});

	it("highlights the active file row", async () => {
		mockedList.mockResolvedValueOnce([
			{
				kind: "file",
				name: "a.ts",
				path: "a.ts",
				absolutePath: "/root/a.ts",
			},
		]);
		renderWithClient(
			<Tree
				workspaceRootPath="/root"
				workspaceId="ws-1"
				onOpenFile={() => {}}
				activeAbsolutePath="/root/a.ts"
				changedPaths={{ files: new Map(), folders: new Map() }}
			/>,
		);
		await waitFor(() => screen.getByText("a.ts"));
		const row = screen.getByText("a.ts").closest("[data-active]");
		expect(row?.getAttribute("data-active")).toBe("true");
	});
});
