import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/render-with-providers";
import { ArchiveCleanupPanel } from "./archive-cleanup";

const apiMocks = vi.hoisted(() => ({
	cleanupArchivedWorkspaces: vi.fn(),
	loadArchivedWorkspaces: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		cleanupArchivedWorkspaces: apiMocks.cleanupArchivedWorkspaces,
		loadArchivedWorkspaces: apiMocks.loadArchivedWorkspaces,
	};
});

const toastMocks = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: toastMocks.success, error: toastMocks.error },
}));

describe("ArchiveCleanupPanel", () => {
	beforeEach(() => {
		// The panel only reads the list length — minimal stubs are enough.
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([
			{ id: "w1" },
			{ id: "w2" },
		]);
		apiMocks.cleanupArchivedWorkspaces.mockResolvedValue({
			deletedCount: 2,
			failures: [],
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("disables the button when there are no archived workspaces", async () => {
		apiMocks.loadArchivedWorkspaces.mockResolvedValue([]);
		renderWithProviders(<ArchiveCleanupPanel />);

		const button = screen.getByRole("button", { name: /clean up/i });
		await waitFor(() => expect(button).toBeDisabled());
		expect(screen.getByText("No archived workspaces.")).toBeInTheDocument();
	});

	it("requires confirmation before starting the cleanup", async () => {
		renderWithProviders(<ArchiveCleanupPanel />);

		const button = screen.getByRole("button", { name: /clean up/i });
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);

		expect(apiMocks.cleanupArchivedWorkspaces).not.toHaveBeenCalled();
		expect(
			screen.getByText("Clean up archived workspaces?"),
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Delete All" }));

		await waitFor(() =>
			expect(apiMocks.cleanupArchivedWorkspaces).toHaveBeenCalledTimes(1),
		);
		await waitFor(() =>
			expect(toastMocks.success).toHaveBeenCalledWith(
				"Cleaned up 2 archived workspaces",
			),
		);
	});

	it("keeps the dialog open and locked while the cleanup runs", async () => {
		let resolveCleanup: (value: {
			deletedCount: number;
			failures: never[];
		}) => void = () => {};
		apiMocks.cleanupArchivedWorkspaces.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCleanup = resolve;
				}),
		);
		renderWithProviders(<ArchiveCleanupPanel />);

		const button = screen.getByRole("button", { name: /clean up/i });
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);
		fireEvent.click(screen.getByRole("button", { name: "Delete All" }));

		// Both dialog buttons lock while the run is in flight.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Delete All" })).toBeDisabled(),
		);
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

		resolveCleanup({ deletedCount: 2, failures: [] });
		await waitFor(() =>
			expect(
				screen.queryByText("Clean up archived workspaces?"),
			).not.toBeInTheDocument(),
		);
	});

	it("surfaces partial failures in an error toast", async () => {
		apiMocks.cleanupArchivedWorkspaces.mockResolvedValue({
			deletedCount: 1,
			failures: [
				{
					workspaceId: "w2",
					title: "Stuck Workspace",
					message: "branch is checked out elsewhere",
				},
			],
		});
		renderWithProviders(<ArchiveCleanupPanel />);

		const button = screen.getByRole("button", { name: /clean up/i });
		await waitFor(() => expect(button).toBeEnabled());
		fireEvent.click(button);
		fireEvent.click(screen.getByRole("button", { name: "Delete All" }));

		await waitFor(() =>
			expect(toastMocks.error).toHaveBeenCalledWith(
				"Cleaned up 1, but 1 workspace could not be deleted",
				{
					description: "Stuck Workspace: branch is checked out elsewhere",
				},
			),
		);
	});
});
