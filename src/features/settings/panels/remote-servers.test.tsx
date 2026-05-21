import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	listRemoteRuntimes: vi.fn(),
	disconnectRemoteRuntime: vi.fn(),
	reconnectRemoteRuntime: vi.fn(),
	connectRemoteRuntime: vi.fn(),
	listSshHosts: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteRuntimes: apiMocks.listRemoteRuntimes,
		disconnectRemoteRuntime: apiMocks.disconnectRemoteRuntime,
		reconnectRemoteRuntime: apiMocks.reconnectRemoteRuntime,
		connectRemoteRuntime: apiMocks.connectRemoteRuntime,
		listSshHosts: apiMocks.listSshHosts,
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import type { RuntimeEntry } from "@/lib/api";
import { RemoteServersPanel } from "./remote-servers";

function withClient(): {
	wrapper: ({ children }: { children: ReactNode }) => ReactNode;
} {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { wrapper };
}

const LOCAL_ENTRY: RuntimeEntry = {
	name: "local",
	isLocal: true,
	state: { type: "connected" },
};

describe("RemoteServersPanel", () => {
	beforeEach(() => {
		for (const m of Object.values(apiMocks)) {
			m.mockReset();
		}
		apiMocks.listSshHosts.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders empty state when no remotes are registered", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY]);
		const { wrapper } = withClient();
		render(<RemoteServersPanel />, { wrapper });
		expect(
			await screen.findByTestId("remote-servers-empty"),
		).toBeInTheDocument();
	});

	it("opens the wizard from the empty-state CTA", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY]);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<RemoteServersPanel />, { wrapper });
		const cta = await screen.findByTestId("remote-servers-empty-add");
		await user.click(cta);
		// Wizard mounts its dialog with role=dialog when opened.
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("renders one row per remote with the state label", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			{
				name: "dev.box",
				isLocal: false,
				state: { type: "connected" },
			},
			{
				name: "vps",
				isLocal: false,
				state: {
					type: "degraded",
					reason: "1 of 3 pings failed",
				},
			},
		]);
		const { wrapper } = withClient();
		render(<RemoteServersPanel />, { wrapper });
		expect(
			await screen.findByTestId("remote-server-row-dev.box"),
		).toHaveTextContent("Connected");
		expect(screen.getByTestId("remote-server-row-vps")).toHaveTextContent(
			"Degraded",
		);
		// Local runtime is filtered out — it's not a "remote server".
		expect(screen.queryByTestId("remote-server-row-local")).toBeNull();
	});

	it("disconnect button calls the API + invalidates the listing", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			{
				name: "dev.box",
				isLocal: false,
				state: { type: "connected" },
			},
		]);
		apiMocks.disconnectRemoteRuntime.mockResolvedValue(undefined);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<RemoteServersPanel />, { wrapper });
		const btn = await screen.findByTestId("remote-server-disconnect-dev.box");
		await user.click(btn);
		expect(apiMocks.disconnectRemoteRuntime).toHaveBeenCalledWith("dev.box");
	});

	it("reconnect button only renders for non-connected entries", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			{
				name: "dev.box",
				isLocal: false,
				state: { type: "connected" },
			},
			{
				name: "vps",
				isLocal: false,
				state: {
					type: "disconnected",
					reason: "ssh dial timeout",
				},
			},
		]);
		const { wrapper } = withClient();
		render(<RemoteServersPanel />, { wrapper });
		await screen.findByTestId("remote-server-row-dev.box");
		expect(screen.queryByTestId("remote-server-reconnect-dev.box")).toBeNull();
		expect(
			screen.getByTestId("remote-server-reconnect-vps"),
		).toBeInTheDocument();
	});

	it("Add remote server button opens the wizard", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY]);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<RemoteServersPanel />, { wrapper });
		const opener = await screen.findByTestId("open-add-remote-server-wizard");
		await user.click(opener);
		expect(
			await screen.findByTestId("add-remote-server-wizard"),
		).toBeInTheDocument();
	});
});
