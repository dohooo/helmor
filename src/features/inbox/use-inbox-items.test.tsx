import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AppSettings,
	DEFAULT_INBOX_ACCOUNT_TOGGLES,
	DEFAULT_INBOX_REPO_CONFIG,
	DEFAULT_SETTINGS,
	SettingsContext,
} from "@/lib/settings";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { useInboxItems } from "./use-inbox-items";

const listInboxItemsMock = vi.fn();

vi.mock("@/lib/api", () => ({
	listInboxItems: (...args: unknown[]) => listInboxItemsMock(...args),
}));

vi.mock("@/lib/use-forge-accounts", () => ({
	useForgeAccountsAll: () => ({
		data: [{ provider: "github", login: "dohooo" }],
		isFetched: true,
		isSuccess: true,
	}),
}));

function wrapperFor(
	queryClient: QueryClient,
	settings: AppSettings = {
		...DEFAULT_SETTINGS,
		inboxSourceConfig: {
			accounts: {
				"github:dohooo": {
					...DEFAULT_INBOX_ACCOUNT_TOGGLES,
					repos: {
						"dohooo/helmor": {
							...DEFAULT_INBOX_REPO_CONFIG,
							enabled: true,
						},
					},
				},
			},
		},
	},
) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return (
			<QueryClientProvider client={queryClient}>
				<SettingsContext.Provider
					value={{
						settings,
						isLoaded: true,
						updateSettings: vi.fn(),
					}}
				>
					<WorkspaceToastProvider value={vi.fn()}>
						{children}
					</WorkspaceToastProvider>
				</SettingsContext.Provider>
			</QueryClientProvider>
		);
	};
}

describe("useInboxItems", () => {
	beforeEach(() => {
		listInboxItemsMock.mockReset();
	});

	it("stops pagination when the backend returns an empty page with a cursor", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		listInboxItemsMock.mockResolvedValueOnce({
			items: [],
			nextCursor: "stuck-cursor",
		});

		const { result } = renderHook(
			() => useInboxItems("issues", "dohooo/helmor", null),
			{ wrapper: wrapperFor(queryClient) },
		);

		await waitFor(() => expect(result.current.hasResolved).toBe(true));

		expect(result.current.items).toEqual([]);
		expect(result.current.hasNextPage).toBe(false);
		expect(listInboxItemsMock).toHaveBeenCalledTimes(1);
	});

	it("keeps an explicit all-state filter instead of falling back to open", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		listInboxItemsMock.mockResolvedValueOnce({
			items: [],
			nextCursor: null,
		});

		const { result } = renderHook(
			() => useInboxItems("issues", "dohooo/helmor", { state: null }),
			{ wrapper: wrapperFor(queryClient) },
		);

		await waitFor(() => expect(result.current.hasResolved).toBe(true));

		expect(listInboxItemsMock).toHaveBeenCalledWith(
			expect.objectContaining({
				filters: expect.objectContaining({ state: null }),
			}),
		);
	});

	it("ignores legacy repository enabled=false once the repository master switch is removed", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		listInboxItemsMock.mockResolvedValueOnce({
			items: [],
			nextCursor: null,
		});

		const { result } = renderHook(
			() => useInboxItems("issues", "dohooo/helmor", null),
			{
				wrapper: wrapperFor(queryClient, {
					...DEFAULT_SETTINGS,
					inboxSourceConfig: {
						accounts: {
							"github:dohooo": {
								...DEFAULT_INBOX_ACCOUNT_TOGGLES,
								repos: {
									"dohooo/helmor": {
										...DEFAULT_INBOX_REPO_CONFIG,
										enabled: false,
										issues: true,
									},
								},
							},
						},
					},
				}),
			},
		);

		await waitFor(() => expect(result.current.hasResolved).toBe(true));

		expect(result.current.kindEnabled).toBe(true);
		expect(listInboxItemsMock).toHaveBeenCalledTimes(1);
	});
});
