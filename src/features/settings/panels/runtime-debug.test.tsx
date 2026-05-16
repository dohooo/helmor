import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEntry, RuntimeHealth } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	listRemoteRuntimes: vi.fn(),
	getRuntimeHealth: vi.fn(),
	connectLocalRuntime: vi.fn(),
	connectRemoteRuntime: vi.fn(),
	disconnectRemoteRuntime: vi.fn(),
	getWorkspaceStatus: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteRuntimes: apiMocks.listRemoteRuntimes,
		getRuntimeHealth: apiMocks.getRuntimeHealth,
		connectLocalRuntime: apiMocks.connectLocalRuntime,
		connectRemoteRuntime: apiMocks.connectRemoteRuntime,
		disconnectRemoteRuntime: apiMocks.disconnectRemoteRuntime,
		getWorkspaceStatus: apiMocks.getWorkspaceStatus,
	};
});

import { RuntimeDebugPanel } from "./runtime-debug";

const LOCAL_ENTRY: RuntimeEntry = {
	name: "local",
	isLocal: true,
	state: { type: "connected" },
};
const LOCAL_HEALTH: RuntimeHealth = {
	kind: { type: "local" },
	hostname: "test-machine",
	version: "0.0.0-test",
};
const REMOTE_HEALTH: RuntimeHealth = {
	kind: { type: "remote", host: "dev.box" },
	hostname: "dev.box",
	version: "0.0.0-remote",
};

function renderPanel() {
	return renderWithProviders(<RuntimeDebugPanel />);
}

describe("RuntimeDebugPanel", () => {
	beforeEach(() => {
		for (const m of Object.values(apiMocks)) {
			m.mockReset();
		}
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY]);
		apiMocks.getRuntimeHealth.mockResolvedValue(LOCAL_HEALTH);
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("renders the local runtime row with a health chip and no disconnect button", async () => {
		renderPanel();
		// Wait for the form to hydrate — the connect form's `Name` label
		// is the cheapest unique marker that the panel rendered fully.
		await screen.findByLabelText(/Name/);
		// The health chip's label appears once the per-row health probe
		// resolves. `hostname=test-machine` is unique to the rendered
		// row description, so use that as the assertion anchor.
		await waitFor(() => {
			expect(screen.getByText(/hostname=test-machine/)).toBeInTheDocument();
		});
		// Local entry has no disconnect button.
		expect(
			screen.queryByRole("button", { name: /Disconnect/ }),
		).not.toBeInTheDocument();
	});

	it("connects via local-binary form and clears inputs on success", async () => {
		const user = userEvent.setup();
		apiMocks.connectLocalRuntime.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();
		const nameInput = await screen.findByLabelText(/Name/);
		await user.type(nameInput, "stage");
		// Local-binary mode is the default; just click Connect.
		await user.click(screen.getByRole("button", { name: /^Connect$/ }));

		await waitFor(() => {
			expect(apiMocks.connectLocalRuntime).toHaveBeenCalledWith(
				"stage",
				undefined,
			);
		});
		// Inputs cleared on success.
		await waitFor(() => {
			expect(screen.getByLabelText(/Name/)).toHaveValue("");
		});
	});

	it("submits the SSH form with host + remote binary when SSH mode is picked", async () => {
		const user = userEvent.setup();
		apiMocks.connectRemoteRuntime.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();
		await screen.findByLabelText(/Name/);

		// Switch to SSH mode. Radix's ToggleGroup with `type="single"`
		// exposes items as `role="radio"` inside a `radiogroup`.
		await user.click(screen.getByRole("radio", { name: /^SSH$/i }));

		await user.type(screen.getByLabelText(/Name/), "dev-box");
		await user.type(screen.getByLabelText(/^Host$/), "dev.box");
		// `Remote binary` field defaults to "helmor-server" — leave it.

		await user.click(screen.getByRole("button", { name: /^Connect$/ }));

		await waitFor(() => {
			expect(apiMocks.connectRemoteRuntime).toHaveBeenCalledWith(
				"dev-box",
				"dev.box",
				"helmor-server",
			);
		});
	});

	it("shows an inline error when connect fails and leaves inputs intact", async () => {
		const user = userEvent.setup();
		apiMocks.connectLocalRuntime.mockRejectedValue(
			new Error("ssh: connection refused"),
		);

		renderPanel();
		const nameInput = await screen.findByLabelText(/Name/);
		await user.type(nameInput, "broken");
		await user.click(screen.getByRole("button", { name: /^Connect$/ }));

		await waitFor(() => {
			expect(screen.getByText(/ssh: connection refused/)).toBeInTheDocument();
		});
		// Name input preserved so the user can retry without re-typing.
		expect(screen.getByLabelText(/Name/)).toHaveValue("broken");
	});

	it("renders disconnect for non-local entries and invokes the command on click", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockImplementation((name?: string) =>
			Promise.resolve(name === "dev.box" ? REMOTE_HEALTH : LOCAL_HEALTH),
		);
		apiMocks.disconnectRemoteRuntime.mockResolvedValue(undefined);

		renderPanel();
		// `dev.box` appears in both the row title and the eventual chip
		// label; the chip text is `remote @ dev.box` so it differs.
		// Use the unique "Disconnect" button as the readiness marker.
		const disconnectButton = await screen.findByRole("button", {
			name: /Disconnect/,
		});
		await user.click(disconnectButton);

		await waitFor(() => {
			expect(apiMocks.disconnectRemoteRuntime).toHaveBeenCalledWith("dev.box");
		});
	});

	it("runs the workspace status probe through the selected runtime", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceStatus.mockResolvedValue({
			isClean: false,
			changedPaths: ["src/foo.rs", "src/bar.rs"],
		});

		renderPanel();
		const workspaceInput = await screen.findByLabelText(/Workspace dir/);
		await user.type(workspaceInput, "/Users/me/code/repo");
		await user.click(screen.getByRole("button", { name: /Run probe/ }));

		await waitFor(() => {
			expect(apiMocks.getWorkspaceStatus).toHaveBeenCalledWith(
				"/Users/me/code/repo",
				"local",
			);
		});

		// The result block enumerates the changed paths.
		await waitFor(() => {
			expect(screen.getByText(/2 changed path/)).toBeInTheDocument();
		});
		expect(screen.getByText("src/foo.rs")).toBeInTheDocument();
		expect(screen.getByText("src/bar.rs")).toBeInTheDocument();
	});

	it("renders 'clean' for an empty changedPaths result", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceStatus.mockResolvedValue({
			isClean: true,
			changedPaths: [],
		});

		renderPanel();
		const workspaceInput = await screen.findByLabelText(/Workspace dir/);
		await user.type(workspaceInput, "/clean/repo");
		await user.click(screen.getByRole("button", { name: /Run probe/ }));

		await waitFor(() => {
			expect(screen.getByText(/Clean — no changes\./)).toBeInTheDocument();
		});
	});

	it("renders chip colors from the entry's connection state", async () => {
		// Three remotes, one in each state. The chip text is sourced
		// from `entry.state` directly, not from the health probe, so
		// this exercise doesn't depend on getRuntimeHealth at all.
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			{
				name: "alpha",
				isLocal: false,
				state: { type: "connected" },
			} satisfies RuntimeEntry,
			{
				name: "beta",
				isLocal: false,
				state: { type: "degraded", reason: "ping timed out" },
			} satisfies RuntimeEntry,
			{
				name: "gamma",
				isLocal: false,
				state: { type: "disconnected", reason: "broken pipe" },
			} satisfies RuntimeEntry,
		]);

		renderPanel();
		// "connected" / "degraded" / "disconnected" labels are unique
		// to the chip text. Wait for each to confirm the row painted.
		await screen.findByText(/^connected$/);
		await screen.findByText(/^degraded$/);
		await screen.findByText(/^disconnected$/);
	});
});
