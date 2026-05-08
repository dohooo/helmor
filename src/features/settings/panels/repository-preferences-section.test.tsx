import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepositoryPreferencesSection } from "./repository-preferences-section";

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		loadRepoPreferences: vi.fn(),
		updateRepoPreferences: vi.fn().mockResolvedValue(undefined),
	};
});

import { loadRepoPreferences, updateRepoPreferences } from "@/lib/api";

const baseResolved = {
	overrides: { review: null },
	inherit: {
		createPr: true,
		review: true,
		fixErrors: true,
		resolveConflicts: true,
		branchRename: true,
		general: true,
	},
	global: { review: "Global review prompt" },
	effective: { review: "Global review prompt" },
};

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<RepositoryPreferencesSection repoId="r1" />
		</QueryClientProvider>,
	);
}

describe("RepositoryPreferencesSection", () => {
	beforeEach(() => {
		vi.mocked(loadRepoPreferences).mockResolvedValue(baseResolved as never);
		vi.mocked(updateRepoPreferences).mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it("renders 'Following global' badge when inherit is true", async () => {
		renderSection();
		const reviewTrigger = await screen.findByRole("button", {
			name: /Review preferences/i,
		});
		fireEvent.click(reviewTrigger);
		expect(await screen.findAllByText(/Following global/i)).not.toHaveLength(0);
	});

	it("auto-detaches inherit when user types into the textarea", async () => {
		renderSection();
		const reviewTrigger = await screen.findByRole("button", {
			name: /Review preferences/i,
		});
		fireEvent.click(reviewTrigger);
		const textarea =
			await screen.findByPlaceholderText(/Global review prompt/i);
		fireEvent.change(textarea, { target: { value: "my override" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(updateRepoPreferences).toHaveBeenCalled();
		});
		const [, overrides, inherit] = vi.mocked(updateRepoPreferences).mock
			.calls[0];
		expect(overrides.review).toBe("my override");
		expect(inherit.review).toBe(false);
	});

	it("reset-to-global re-attaches and clears the editable value", async () => {
		vi.mocked(loadRepoPreferences).mockResolvedValueOnce({
			...baseResolved,
			inherit: { ...baseResolved.inherit, review: false },
			overrides: { review: "old override" },
			effective: { review: "old override" },
		} as never);

		renderSection();
		const reviewTrigger = await screen.findByRole("button", {
			name: /Review preferences/i,
		});
		fireEvent.click(reviewTrigger);
		fireEvent.click(
			await screen.findByRole("button", { name: /Reset to global/i }),
		);
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(updateRepoPreferences).toHaveBeenCalled();
		});
		const [, , inherit] = vi.mocked(updateRepoPreferences).mock.calls[0];
		expect(inherit.review).toBe(true);
	});
});
