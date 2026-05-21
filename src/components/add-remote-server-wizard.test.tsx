import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	connectRemoteRuntime: vi.fn(),
	listSshHosts: vi.fn(),
	listSshHostDetails: vi.fn(),
	getSshAgentStatus: vi.fn(),
	listSshIdentities: vi.fn(),
	probeSshHost: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		connectRemoteRuntime: apiMocks.connectRemoteRuntime,
		listSshHosts: apiMocks.listSshHosts,
		listSshHostDetails: apiMocks.listSshHostDetails,
		getSshAgentStatus: apiMocks.getSshAgentStatus,
		listSshIdentities: apiMocks.listSshIdentities,
		probeSshHost: apiMocks.probeSshHost,
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
		apiMocks.listSshHostDetails.mockReset();
		apiMocks.getSshAgentStatus.mockReset();
		apiMocks.listSshIdentities.mockReset();
		apiMocks.probeSshHost.mockReset();
		apiMocks.listSshHosts.mockResolvedValue([]);
		apiMocks.listSshHostDetails.mockResolvedValue([]);
		apiMocks.getSshAgentStatus.mockResolvedValue({ state: "notConfigured" });
		apiMocks.listSshIdentities.mockResolvedValue([]);
		// Default: pre-flight probe succeeds so existing tests don't
		// have to opt in. Per-test overrides cover the failure paths.
		apiMocks.probeSshHost.mockResolvedValue({
			state: "reachable",
			latencyMs: 12,
		});
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
			{ forwardAgent: false },
		);

		(release as (() => void) | null)?.();
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

	it("blocks the connect call when the pre-flight ssh probe reports authFailed", async () => {
		apiMocks.probeSshHost.mockResolvedValue({
			state: "authFailed",
			stderr: "dwork@dev.box: Permission denied (publickey).",
		});
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(screen.getByTestId("add-remote-server-host"), "dev.box");
		await user.click(screen.getByTestId("add-remote-server-connect"));

		const errorRegion = await screen.findByTestId("add-remote-server-error");
		expect(errorRegion.textContent).toContain("SSH auth against dev.box");
		expect(errorRegion.textContent).toContain("ssh-add");
		expect(errorRegion.textContent).toContain("Permission denied");
		// connectRemoteRuntime must NOT have been called — the whole
		// point of the probe is to fail before the expensive install
		// path runs.
		expect(apiMocks.connectRemoteRuntime).not.toHaveBeenCalled();
	});

	it("blocks the connect call when the pre-flight ssh probe reports unreachable", async () => {
		apiMocks.probeSshHost.mockResolvedValue({
			state: "unreachable",
			stderr: "ssh: Could not resolve hostname typo.box",
		});
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(screen.getByTestId("add-remote-server-host"), "typo.box");
		await user.click(screen.getByTestId("add-remote-server-connect"));

		const errorRegion = await screen.findByTestId("add-remote-server-error");
		expect(errorRegion.textContent).toContain("couldn't reach typo.box");
		expect(errorRegion.textContent).toContain("Could not resolve hostname");
		expect(apiMocks.connectRemoteRuntime).not.toHaveBeenCalled();
	});

	it("blocks the connect call when the pre-flight ssh probe times out", async () => {
		apiMocks.probeSshHost.mockResolvedValue({ state: "timeout" });
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"behind-vpn.box",
		);
		await user.click(screen.getByTestId("add-remote-server-connect"));

		const errorRegion = await screen.findByTestId("add-remote-server-error");
		expect(errorRegion.textContent).toContain(
			"Timed out probing behind-vpn.box",
		);
		expect(apiMocks.connectRemoteRuntime).not.toHaveBeenCalled();
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

	it("surfaces matching host detail when the typed host is in ~/.ssh/config", async () => {
		apiMocks.listSshHostDetails.mockResolvedValue([
			{
				alias: "dev.box",
				hostName: "10.0.2.31",
				user: "dwork",
				identityFiles: ["/home/d/.ssh/work_rsa"],
				proxyJump: "bastion.example.com",
			},
		]);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await waitFor(() => expect(apiMocks.listSshHostDetails).toHaveBeenCalled());
		await user.type(screen.getByTestId("add-remote-server-host"), "dev.box");
		const detail = await screen.findByTestId("add-remote-server-host-detail");
		expect(detail).toHaveTextContent("10.0.2.31");
		expect(detail).toHaveTextContent("dwork");
		expect(detail).toHaveTextContent("/home/d/.ssh/work_rsa");
		expect(detail).toHaveTextContent("bastion.example.com");
	});

	it("matches a `user@alias` typed value against the bare alias", async () => {
		apiMocks.listSshHostDetails.mockResolvedValue([
			{
				alias: "dev.box",
				hostName: "10.0.2.31",
				user: null,
				identityFiles: [],
				proxyJump: null,
			},
		]);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await waitFor(() => expect(apiMocks.listSshHostDetails).toHaveBeenCalled());
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"override@dev.box",
		);
		const detail = await screen.findByTestId("add-remote-server-host-detail");
		expect(detail).toHaveTextContent("10.0.2.31");
	});

	it("hides the host-detail block when the typed host doesn't match any alias", async () => {
		apiMocks.listSshHostDetails.mockResolvedValue([
			{
				alias: "dev.box",
				hostName: "10.0.2.31",
				user: null,
				identityFiles: [],
				proxyJump: null,
			},
		]);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await waitFor(() => expect(apiMocks.listSshHostDetails).toHaveBeenCalled());
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"never-aliased.example.com",
		);
		expect(
			screen.queryByTestId("add-remote-server-host-detail"),
		).not.toBeInTheDocument();
	});

	it("threads the forward-agent checkbox into the connect call", async () => {
		apiMocks.connectRemoteRuntime.mockResolvedValue(undefined);
		const user = userEvent.setup();
		const { wrapper } = withClient();
		render(<AddRemoteServerWizard open={true} onOpenChange={() => {}} />, {
			wrapper,
		});
		await user.type(screen.getByTestId("add-remote-server-name"), "dev");
		await user.type(
			screen.getByTestId("add-remote-server-host"),
			"dev.example.com",
		);
		// Tick the agent-forwarding checkbox.
		await user.click(
			screen.getByTestId("add-remote-server-forward-agent-input"),
		);
		await user.click(screen.getByTestId("add-remote-server-connect"));
		await waitFor(() =>
			expect(apiMocks.connectRemoteRuntime).toHaveBeenCalledWith(
				"dev",
				"dev.example.com",
				"$HOME/.helmor/server/helmor-server",
				{ forwardAgent: true },
			),
		);
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
