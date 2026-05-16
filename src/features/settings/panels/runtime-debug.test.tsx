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
	reconnectRemoteRuntime: vi.fn(),
	getWorkspaceStatus: vi.fn(),
	listSshHosts: vi.fn(),
	listWorkspaceRuntimeBindings: vi.fn(),
	setWorkspaceRuntimeBinding: vi.fn(),
	clearWorkspaceRuntimeBinding: vi.fn(),
	getWorkspaceBranchInfo: vi.fn(),
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
		reconnectRemoteRuntime: apiMocks.reconnectRemoteRuntime,
		getWorkspaceStatus: apiMocks.getWorkspaceStatus,
		listSshHosts: apiMocks.listSshHosts,
		listWorkspaceRuntimeBindings: apiMocks.listWorkspaceRuntimeBindings,
		setWorkspaceRuntimeBinding: apiMocks.setWorkspaceRuntimeBinding,
		clearWorkspaceRuntimeBinding: apiMocks.clearWorkspaceRuntimeBinding,
		getWorkspaceBranchInfo: apiMocks.getWorkspaceBranchInfo,
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
		apiMocks.listSshHosts.mockResolvedValue([]);
		apiMocks.listWorkspaceRuntimeBindings.mockResolvedValue([]);
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

	it("renders ssh-config host aliases as datalist suggestions when SSH mode is picked", async () => {
		const user = userEvent.setup();
		apiMocks.listSshHosts.mockResolvedValue(["dev.box", "my-laptop"]);

		renderPanel();
		await screen.findByLabelText(/Name/);
		await user.click(screen.getByRole("radio", { name: /^SSH$/i }));

		// Host input is wired to the datalist via list= attribute.
		const hostInput = await screen.findByLabelText(/^Host$/);
		expect(hostInput).toHaveAttribute("list", "ssh-host-suggestions");

		// The datalist itself carries one <option> per alias. JSDOM
		// renders datalist + option as DOM nodes even though they
		// don't show in screen.getByText.
		const datalist = hostInput.ownerDocument.getElementById(
			"ssh-host-suggestions",
		) as HTMLDataListElement | null;
		expect(datalist).not.toBeNull();
		const optionValues = Array.from(datalist?.querySelectorAll("option") ?? [])
			.map((o) => (o as HTMLOptionElement).value)
			.sort();
		expect(optionValues).toEqual(["dev.box", "my-laptop"]);

		// The "N aliases from ~/.ssh/config" hint surfaces too so the
		// user can tell the suggestions are scoped, not magic.
		expect(screen.getByText(/2 aliases from/)).toBeInTheDocument();
	});

	it("omits the ssh-config hint when no aliases are present", async () => {
		const user = userEvent.setup();
		apiMocks.listSshHosts.mockResolvedValue([]);

		renderPanel();
		await screen.findByLabelText(/Name/);
		await user.click(screen.getByRole("radio", { name: /^SSH$/i }));

		await screen.findByLabelText(/^Host$/);
		expect(screen.queryByText(/aliases from/)).not.toBeInTheDocument();
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

	it("runs the workspace status probe with Auto resolution by default", async () => {
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
			// Default Runtime selection is "Auto (via binding)" which
			// translates to undefined runtime + undefined workspace id
			// on the wire. The backend resolver falls through to local.
			expect(apiMocks.getWorkspaceStatus).toHaveBeenCalledWith(
				"/Users/me/code/repo",
				{ runtimeName: undefined, workspaceId: undefined },
			);
		});

		// The result block enumerates the changed paths.
		await waitFor(() => {
			expect(screen.getByText(/2 changed path/)).toBeInTheDocument();
		});
		expect(screen.getByText("src/foo.rs")).toBeInTheDocument();
		expect(screen.getByText("src/bar.rs")).toBeInTheDocument();
	});

	it("runs the branch-info probe and renders branch + head", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceBranchInfo.mockResolvedValue({
			currentBranch: "feature/foo",
			headCommit: "abcdef1234567890abcdef1234567890abcdef12",
			upstreamRef: "origin/feature/foo",
		});

		renderPanel();
		await user.type(
			await screen.findByLabelText(/Workspace dir/),
			"/Users/me/code/repo",
		);
		await user.click(screen.getByRole("button", { name: /Run branch info/ }));

		await waitFor(() => {
			expect(apiMocks.getWorkspaceBranchInfo).toHaveBeenCalledWith(
				"/Users/me/code/repo",
				{ runtimeName: undefined, workspaceId: undefined },
			);
		});

		// Result block surfaces the branch, a short head SHA, and the
		// upstream tracking ref.
		await waitFor(() => {
			expect(screen.getByText(/branch: feature\/foo/)).toBeInTheDocument();
		});
		expect(screen.getByText(/head: abcdef123456/)).toBeInTheDocument();
		expect(
			screen.getByText(/upstream: origin\/feature\/foo/),
		).toBeInTheDocument();
	});

	it("renders '(detached HEAD)' when the branch name is empty", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceBranchInfo.mockResolvedValue({
			currentBranch: "",
			headCommit: "1234567890abcdef1234567890abcdef12345678",
		});

		renderPanel();
		await user.type(await screen.findByLabelText(/Workspace dir/), "/repo");
		await user.click(screen.getByRole("button", { name: /Run branch info/ }));

		await waitFor(() => {
			expect(screen.getByText(/branch: \(detached HEAD\)/)).toBeInTheDocument();
		});
		// Empty upstream shows the explicit "(none)" hint so the user
		// can tell the data was *fetched* successfully but the branch
		// isn't tracking anything.
		expect(screen.getByText(/upstream: \(none\)/)).toBeInTheDocument();
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

	it("passes workspaceId through to the probe so the resolver can use the binding", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceStatus.mockResolvedValue({
			isClean: true,
			changedPaths: [],
		});

		renderPanel();
		await user.type(await screen.findByLabelText(/Workspace dir/), "/repo");
		await user.type(await screen.findByLabelText(/Workspace ID/), "ws-bound");
		await user.click(screen.getByRole("button", { name: /Run probe/ }));

		await waitFor(() => {
			expect(apiMocks.getWorkspaceStatus).toHaveBeenCalledWith("/repo", {
				runtimeName: undefined,
				workspaceId: "ws-bound",
			});
		});
	});

	it("explicit runtime selection takes precedence over the workspace binding", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getWorkspaceStatus.mockResolvedValue({
			isClean: true,
			changedPaths: [],
		});

		renderPanel();
		await user.type(await screen.findByLabelText(/Workspace dir/), "/repo");
		await user.type(await screen.findByLabelText(/Workspace ID/), "ws-bound");
		// Switch the dropdown away from "Auto" — explicit pick. The
		// bindings section also has a `Runtime` label, so anchor on
		// the probe-section input id to disambiguate.
		const probeRuntime = document.getElementById(
			"probe-runtime",
		) as HTMLSelectElement | null;
		if (!probeRuntime) throw new Error("probe-runtime select missing");
		await user.selectOptions(probeRuntime, "dev.box");
		await user.click(screen.getByRole("button", { name: /Run probe/ }));

		await waitFor(() => {
			// Both workspaceId AND runtimeName get forwarded — the
			// backend's resolver handles the precedence rule.
			expect(apiMocks.getWorkspaceStatus).toHaveBeenCalledWith("/repo", {
				runtimeName: "dev.box",
				workspaceId: "ws-bound",
			});
		});
	});

	it("renders a Reconnect button only when the entry is disconnected", async () => {
		const user = userEvent.setup();
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			{
				name: "tombstone",
				isLocal: false,
				state: { type: "disconnected", reason: "ssh exited" },
			} satisfies RuntimeEntry,
		]);
		apiMocks.reconnectRemoteRuntime.mockResolvedValue({
			kind: { type: "remote", host: "tombstone" },
			hostname: "tombstone",
			version: "0.0.0",
		});

		renderPanel();
		const reconnect = await screen.findByRole("button", { name: /Reconnect/ });
		await user.click(reconnect);

		await waitFor(() => {
			expect(apiMocks.reconnectRemoteRuntime).toHaveBeenCalledWith("tombstone");
		});
	});

	it("hides the Reconnect button for connected entries", async () => {
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			{
				name: "fine",
				isLocal: false,
				state: { type: "connected" },
			} satisfies RuntimeEntry,
		]);
		renderPanel();
		// Disconnect should be there for the remote entry, but no
		// Reconnect.
		await screen.findByRole("button", { name: /Disconnect/ });
		expect(
			screen.queryByRole("button", { name: /Reconnect/ }),
		).not.toBeInTheDocument();
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

	// ── workspace bindings ───────────────────────────────────────

	it("submits a new workspace binding when Pin is clicked", async () => {
		const user = userEvent.setup();
		apiMocks.setWorkspaceRuntimeBinding.mockResolvedValue(undefined);

		renderPanel();
		const workspaceInput = await screen.findByLabelText(/Pin workspace/);
		await user.type(workspaceInput, "ws-1234");
		await user.click(screen.getByRole("button", { name: /^Pin$/ }));

		await waitFor(() => {
			expect(apiMocks.setWorkspaceRuntimeBinding).toHaveBeenCalledWith(
				"ws-1234",
				"local",
			);
		});
		// Input clears on success so the user can pin another.
		await waitFor(() => {
			expect(screen.getByLabelText(/Pin workspace/)).toHaveValue("");
		});
	});

	it("renders an existing binding and lets the user clear it", async () => {
		const user = userEvent.setup();
		apiMocks.listWorkspaceRuntimeBindings.mockResolvedValue([
			{ workspaceId: "ws-pinned", runtimeName: "dev.box" },
		]);
		apiMocks.clearWorkspaceRuntimeBinding.mockResolvedValue(undefined);

		renderPanel();
		// Binding row shows `workspaceId → runtimeName` in a font-mono
		// span; the workspace id is unique to the row so we anchor on
		// that.
		await screen.findByText("ws-pinned");
		await user.click(screen.getByRole("button", { name: /Clear/ }));

		await waitFor(() => {
			expect(apiMocks.clearWorkspaceRuntimeBinding).toHaveBeenCalledWith(
				"ws-pinned",
			);
		});
	});

	it("warns when a binding points at a runtime that isn't currently registered", async () => {
		// Only `local` is in the registry list, but the persisted
		// bindings reference a `dev.box` that hasn't reconnected.
		// The row should surface a warning so the user knows ops will
		// fall back to local until they reconnect.
		apiMocks.listWorkspaceRuntimeBindings.mockResolvedValue([
			{ workspaceId: "ws-tomb", runtimeName: "dev.box" },
		]);

		renderPanel();
		await screen.findByText("ws-tomb");
		await waitFor(() => {
			expect(
				screen.getByText(/isn't currently registered/),
			).toBeInTheDocument();
		});
	});

	it("disables the Pin button while the workspace ID input is empty", async () => {
		renderPanel();
		await screen.findByLabelText(/Pin workspace/);
		const pinButton = screen.getByRole("button", { name: /^Pin$/ });
		expect(pinButton).toBeDisabled();
	});
});
