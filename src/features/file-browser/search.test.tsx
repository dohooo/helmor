import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "@/lib/api";

import { SearchResults } from "./search-results";

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		searchWorkspacePaths: vi.fn(),
	};
});

const mocked = api.searchWorkspacePaths as unknown as ReturnType<typeof vi.fn>;

function renderWithClient(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

beforeEach(() => mocked.mockReset());

describe("SearchResults", () => {
	it("shows empty state when no query", () => {
		renderWithClient(
			<SearchResults
				workspaceRootPath="/root"
				query=""
				onOpenFile={() => {}}
			/>,
		);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("shows results when query has matches", async () => {
		mocked.mockResolvedValueOnce([
			{
				kind: "file",
				name: "login.tsx",
				path: "src/login.tsx",
				absolutePath: "/root/src/login.tsx",
			},
		]);
		renderWithClient(
			<SearchResults
				workspaceRootPath="/root"
				query="login"
				onOpenFile={() => {}}
			/>,
		);
		await waitFor(() => screen.getByText("login.tsx"));
		expect(screen.getByText("src/login.tsx")).toBeInTheDocument();
	});

	it("shows no-results message when search returns empty", async () => {
		mocked.mockResolvedValueOnce([]);
		renderWithClient(
			<SearchResults
				workspaceRootPath="/root"
				query="zzz"
				onOpenFile={() => {}}
			/>,
		);
		await waitFor(() => screen.getByText(/no matches/i));
	});

	it("invokes onOpenFile when a result is clicked", async () => {
		mocked.mockResolvedValueOnce([
			{
				kind: "file",
				name: "a.ts",
				path: "a.ts",
				absolutePath: "/root/a.ts",
			},
		]);
		const onOpenFile = vi.fn();
		renderWithClient(
			<SearchResults
				workspaceRootPath="/root"
				query="a"
				onOpenFile={onOpenFile}
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
});
