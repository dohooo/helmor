import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCodexIdentityStatus } from "@/lib/team-api";

const mocks = vi.hoisted(() => ({
	codex: {
		status: {
			hasToken: false,
			accountId: null,
			accessExp: null,
			bricked: false,
		} as CloudCodexIdentityStatus,
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		error: null as string | null,
		needsReauthorize: false,
		authorize: vi.fn(),
		refetch: vi.fn(),
	},
	claude: {
		status: { hasToken: false },
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		error: null as string | null,
		authorize: vi.fn(),
		refetch: vi.fn(),
	},
	codexEmail: null as string | null,
}));

vi.mock("@/features/team/use-cloud-identity", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/features/team/use-cloud-identity")>();
	return {
		isCloudIdentityExpired: original.isCloudIdentityExpired,
		useCloudIdentity: () => mocks.codex,
	};
});
vi.mock("@/features/team/use-cloud-claude-identity", () => ({
	useCloudClaudeIdentity: () => mocks.claude,
}));
vi.mock("@/lib/team-mode", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/team-mode")>()),
	getCodexIdentityEmail: () => mocks.codexEmail,
}));

import { AgentStatusCard } from "./agent-status-card";

const CFG = { url: "https://team.example.workers.dev", token: "member" };

function setCodex(status: Partial<CloudCodexIdentityStatus>, extra?: object) {
	mocks.codex = {
		...mocks.codex,
		status: { ...mocks.codex.status, ...status },
		...extra,
	};
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.codex = {
		status: {
			hasToken: false,
			accountId: null,
			accessExp: null,
			bricked: false,
		},
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		error: null,
		needsReauthorize: false,
		authorize: vi.fn(),
		refetch: vi.fn(),
	};
	mocks.claude = {
		status: { hasToken: false },
		isLoading: false,
		isError: false,
		isAuthorizing: false,
		error: null,
		authorize: vi.fn(),
		refetch: vi.fn(),
	};
	mocks.codexEmail = null;
});

describe("AgentStatusCard (R5-A)", () => {
	it("summarizes both-authorized on one line and stays collapsed", () => {
		setCodex({ hasToken: true, accountId: "acct_1" });
		mocks.claude.status = { hasToken: true };
		render(<AgentStatusCard cfg={CFG} />);
		expect(screen.getByText("Codex · Claude authorized")).toBeTruthy();
		// Collapsed: no per-agent rows.
		expect(screen.queryByRole("button", { name: /Re-authorize/i })).toBeNull();
	});

	it("auto-expands when nothing is authorized yet", () => {
		render(<AgentStatusCard cfg={CFG} />);
		expect(
			screen.getByText("Authorize agents to run in the cloud"),
		).toBeTruthy();
		// Expanded rows with Authorize buttons for both agents.
		expect(
			screen.getAllByRole("button", { name: /^Authorize$/i }),
		).toHaveLength(2);
	});

	it("summarizes a partial setup", () => {
		setCodex({ hasToken: true });
		render(<AgentStatusCard cfg={CFG} />);
		expect(
			screen.getByText("Codex authorized · Claude not set up"),
		).toBeTruthy();
	});

	it("surfaces an expired Codex identity in the summary", () => {
		setCodex({ hasToken: true, bricked: true }, { needsReauthorize: true });
		render(<AgentStatusCard cfg={CFG} />);
		expect(screen.getByText("Codex expired — re-authorize")).toBeTruthy();
	});

	it("expands to show the locally-captured email (not the account UUID)", () => {
		setCodex({ hasToken: true, accountId: "acct_uuid_1" });
		mocks.codexEmail = "dev@example.com";
		render(<AgentStatusCard cfg={CFG} />);
		fireEvent.click(screen.getByRole("button", { name: /Agent status/i }));
		expect(screen.getByText("dev@example.com")).toBeTruthy();
		expect(screen.queryByText("acct_uuid_1")).toBeNull();
	});

	it("falls back to the account id for pre-R5-A authorizations", () => {
		setCodex({ hasToken: true, accountId: "acct_uuid_1" });
		render(<AgentStatusCard cfg={CFG} />);
		fireEvent.click(screen.getByRole("button", { name: /Agent status/i }));
		expect(screen.getByText("acct_uuid_1")).toBeTruthy();
	});

	it("shows Claude as long-lived with no expiry column", () => {
		mocks.claude.status = { hasToken: true };
		render(<AgentStatusCard cfg={CFG} />);
		fireEvent.click(screen.getByRole("button", { name: /Agent status/i }));
		expect(screen.getByText("Authorized · long-lived")).toBeTruthy();
	});

	it("wires Re-authorize to the codex authorize action", () => {
		setCodex({ hasToken: true });
		mocks.claude.status = { hasToken: true };
		render(<AgentStatusCard cfg={CFG} />);
		fireEvent.click(screen.getByRole("button", { name: /Agent status/i }));
		const buttons = screen.getAllByRole("button", { name: /Re-authorize/i });
		fireEvent.click(buttons[0]);
		expect(mocks.codex.authorize).toHaveBeenCalled();
	});
});
