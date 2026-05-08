import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalPreferencesPanel } from "./global-preferences";

vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		...actual,
		loadGlobalPreferences: vi.fn().mockResolvedValue({}),
		updateGlobalPreferences: vi.fn(),
	};
});

import { loadGlobalPreferences, updateGlobalPreferences } from "@/lib/api";

function renderPanel() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<Toaster />
			<GlobalPreferencesPanel />
		</QueryClientProvider>,
	);
}

describe("GlobalPreferencesPanel", () => {
	beforeEach(() => {
		vi.mocked(loadGlobalPreferences).mockResolvedValue({});
		vi.mocked(updateGlobalPreferences).mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("toasts the affected count after save (non-zero)", async () => {
		vi.mocked(updateGlobalPreferences).mockResolvedValue({ reposAffected: 5 });
		renderPanel();
		fireEvent.click(await screen.findByText("Review preferences"));
		const textarea = await screen.findByRole("textbox");
		fireEvent.change(textarea, { target: { value: "new global review" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(screen.getByText(/5 repositories/i)).toBeInTheDocument();
		});
	});

	it("suppresses toast when zero repos are affected", async () => {
		vi.mocked(updateGlobalPreferences).mockResolvedValue({ reposAffected: 0 });
		renderPanel();
		fireEvent.click(await screen.findByText("Review preferences"));
		const textarea = await screen.findByRole("textbox");
		fireEvent.change(textarea, { target: { value: "x" } });
		fireEvent.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => {
			expect(updateGlobalPreferences).toHaveBeenCalled();
		});
		expect(screen.queryByText(/repositories/i)).not.toBeInTheDocument();
	});
});
