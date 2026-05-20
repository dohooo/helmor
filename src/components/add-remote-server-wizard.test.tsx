import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	connectRemoteRuntime: vi.fn(),
	listSshHosts: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		connectRemoteRuntime: apiMocks.connectRemoteRuntime,
		listSshHosts: apiMocks.listSshHosts,
	};
});

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { AddRemoteServerWizard } from "./add-remote-server-wizard";

function withClient(): {
	wrapper: ({ children }: { children: ReactNode }) => ReactNode;
	queryClient: QueryClient;
} {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return { wrapper, queryClient };
}

describe("AddRemoteServerWizard", () => {
	beforeEach(() => {
		apiMocks.connectRemoteRuntime.mockReset();
		apiMocks.listSshHosts.mockReset();
		apiMocks.listSshHosts.mockResolvedValue([]);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders the form step when open", async () => {
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		expect(
			await screen.findByTestId("add-remote-server-name"),
		).toBeInTheDocument();
		expect(screen.getByTestId("add-remote-server-host")).toBeInTheDocument();
		expect(screen.getByTestId("add-remote-server-connect")).toBeDisabled();
	});

	it("disables the connect button until both fields are filled", async () => {
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		const connect = await screen.findByTestId("add-remote-server-connect");
		expect(connect).toBeDisabled();
		await user.type(screen.getByTestId("add-remote-server-name"), "dev-stage");
		expect(connect).toBeDisabled();
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"dev.example.com",
		);
		expect(connect).toBeEnabled();
	});

	it("transitions through form → connecting → done on a successful connect", async () => {
		// Block the mutation until the test releases it so we can
		// assert the in-flight "connecting" step.
		let release: (() => void) | null = null;
		apiMocks.connectRemoteRuntime.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					release = () => resolve();
				}),
		);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		const onConnected = vi.fn();
		render(
			<AddRemoteServerWizard
				open={true}
				onOpenChange={() => {}}
				onConnected={onConnected}
			/>,
			{ wrapper },
		);
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"dev.example.com",
		);
		await user.click(screen.getByTestId("add-remote-server-connect"));

		expect(
			await screen.findByTestId("add-remote-server-connecting"),
		).toBeInTheDocument();
		expect(apiMocks.connectRemoteRuntime).toHaveBeenCalledWith(
			"dev",
			"dev.example.com",
			"$HOME/.helmor/server/helmor-server",
		);

		release?.();
		expect(
			await screen.findByTestId("add-remote-server-success"),
		).toBeInTheDocument();
		expect(onConnected).toHaveBeenCalledWith({
			name: "dev",
			host: "dev.example.com",
		});
	});

	it("surfaces an error + lets the user retry", async () => {
		apiMocks.connectRemoteRuntime
			.mockRejectedValueOnce(new Error("ssh: connect refused"))
			.mockResolvedValueOnce(undefined);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(screen.getByTestId("add-remote-server-host"), "bad.host");
		await user.click(screen.getByTestId("add-remote-server-connect"));

		const errorRegion = await screen.findByTestId("add-remote-server-error");
		expect(errorRegion.textContent).toContain("connect refused");

		await user.click(screen.getByTestId("add-remote-server-retry"));
		expect(
			await screen.findByTestId("add-remote-server-success"),
		).toBeInTheDocument();
		expect(apiMocks.connectRemoteRuntime).toHaveBeenCalledTimes(2);
	});

	it("resets to the form step when reopened after a successful connect", async () => {
		apiMocks.connectRemoteRuntime.mockResolvedValue(undefined);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		const { rerender } = render(
			<AddRemoteServerWizard open={true} onOpenChange={() => {}} />,
			{ wrapper },
		);
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"dev.example.com",
		);
		await user.click(screen.getByTestId("add-remote-server-connect"));
		await waitFor(() =>
			expect(
				screen.getByTestId("add-remote-server-success"),
			).toBeInTheDocument(),
		);

		// Close + reopen.
		rerender(<AddRemoteServerWizard open={false} onOpenChange={() => {}} />);
		rerender(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />);
		const nameInput = await screen.findByTestId("add-remote-server-name");
		expect((nameInput as HTMLInputElement).value).toBe("");
		expect(screen.getByTestId("add-remote-server-connect")).toBeDisabled();
	});

	it("renders ssh-config host aliases as a datalist", async () => {
		apiMocks.listSshHosts.mockResolvedValue(["dev.box", "vps", "gpu.rig"]);
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await waitFor(() => expect(apiMocks.listSshHosts).toHaveBeenCalled());
		// `datalist` doesn't fire user-visible role events, so assert
		// on the underlying option elements directly.
		await waitFor(() => {
			expect(
				document.querySelectorAll("#add-remote-server-host-suggestions option"),
			).toHaveLength(3);
		});
	});
});
