import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
	getSshAgentStatus: vi.fn(),
	listSshIdentities: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		getSshAgentStatus: apiMocks.getSshAgentStatus,
		listSshIdentities: apiMocks.listSshIdentities,
	};
});

import { SshDiagnostics } from "./ssh-diagnostics";

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

describe("SshDiagnostics", () => {
	beforeEach(() => {
		apiMocks.getSshAgentStatus.mockReset();
		apiMocks.listSshIdentities.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders the available chip with key count when agent answers", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({
			state: "available",
			socketPath: "/tmp/agent.sock",
			keysLoaded: 3,
		});
		apiMocks.listSshIdentities.mockResolvedValue([]);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		await waitFor(() =>
			expect(
				screen.getByTestId("ssh-agent-chip-available"),
			).toBeInTheDocument(),
		);
		expect(screen.getByTestId("ssh-agent-chip-available")).toHaveTextContent(
			/3 keys loaded/,
		);
	});

	it("renders singular `1 key loaded` correctly", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({
			state: "available",
			socketPath: "/tmp/agent.sock",
			keysLoaded: 1,
		});
		apiMocks.listSshIdentities.mockResolvedValue([]);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		await waitFor(() =>
			expect(screen.getByTestId("ssh-agent-chip-available")).toHaveTextContent(
				/1 key loaded/,
			),
		);
	});

	it("renders the not-configured chip when SSH_AUTH_SOCK is missing", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({ state: "notConfigured" });
		apiMocks.listSshIdentities.mockResolvedValue([]);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		await waitFor(() =>
			expect(
				screen.getByTestId("ssh-agent-chip-not-configured"),
			).toBeInTheDocument(),
		);
	});

	it("renders the stale chip with the socket path and reason", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({
			state: "stale",
			socketPath: "/tmp/stale.sock",
			reason: "ssh-add -l exited with status 2",
		});
		apiMocks.listSshIdentities.mockResolvedValue([]);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		const chip = await screen.findByTestId("ssh-agent-chip-stale");
		expect(chip).toHaveTextContent("/tmp/stale.sock");
		expect(chip).toHaveAttribute("title", "ssh-add -l exited with status 2");
	});

	it("renders identity keys as chips with the file stem", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({ state: "notConfigured" });
		apiMocks.listSshIdentities.mockResolvedValue([
			{
				name: "id_ed25519",
				publicKeyPath: "/h/.ssh/id_ed25519.pub",
				hasPrivateKey: true,
			},
			{
				name: "work_rsa",
				publicKeyPath: "/h/.ssh/work_rsa.pub",
				hasPrivateKey: true,
			},
		]);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		const row = await screen.findByTestId("ssh-identities-row");
		expect(row).toHaveTextContent("id_ed25519");
		expect(row).toHaveTextContent("work_rsa");
	});

	it("collapses overflow into a `+N more` indicator", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({ state: "notConfigured" });
		apiMocks.listSshIdentities.mockResolvedValue(
			Array.from({ length: 7 }, (_, i) => ({
				name: `key_${i}`,
				publicKeyPath: `/h/.ssh/key_${i}.pub`,
				hasPrivateKey: true,
			})),
		);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		// 4 visible; 3 in the overflow indicator.
		const row = await screen.findByTestId("ssh-identities-row");
		expect(row).toHaveTextContent("+3 more");
	});

	it("renders the empty hint when no identities are visible", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({ state: "notConfigured" });
		apiMocks.listSshIdentities.mockResolvedValue([]);
		const { wrapper } = withClient();
		render(<SshDiagnostics />, { wrapper });
		const empty = await screen.findByTestId("ssh-identities-empty");
		expect(empty).toHaveTextContent(/ssh-keygen/);
	});

	it("does not fetch when disabled", async () => {
		apiMocks.getSshAgentStatus.mockResolvedValue({ state: "notConfigured" });
		apiMocks.listSshIdentities.mockResolvedValue([]);
		const { wrapper } = withClient();
		render(<SshDiagnostics enabled={false} />, { wrapper });
		// Settle.
		await Promise.resolve();
		expect(apiMocks.getSshAgentStatus).not.toHaveBeenCalled();
		expect(apiMocks.listSshIdentities).not.toHaveBeenCalled();
	});
});
