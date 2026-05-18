import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEntry, RuntimeHealth } from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	listRemoteRuntimes: vi.fn(),
	getRuntimeHealth: vi.fn(),
	connectCommandRuntime: vi.fn(),
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
	getWorkspaceFileTree: vi.fn(),
	getWorkspaceChanges: vi.fn(),
	openRemoteTerminal: vi.fn(),
	writeRemoteTerminal: vi.fn(),
	closeRemoteTerminal: vi.fn(),
	listRemoteTerminals: vi.fn(),
	listOwnedTerminals: vi.fn(),
	attachRemoteTerminal: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		listRemoteRuntimes: apiMocks.listRemoteRuntimes,
		getRuntimeHealth: apiMocks.getRuntimeHealth,
		connectCommandRuntime: apiMocks.connectCommandRuntime,
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
		getWorkspaceFileTree: apiMocks.getWorkspaceFileTree,
		getWorkspaceChanges: apiMocks.getWorkspaceChanges,
		openRemoteTerminal: apiMocks.openRemoteTerminal,
		writeRemoteTerminal: apiMocks.writeRemoteTerminal,
		closeRemoteTerminal: apiMocks.closeRemoteTerminal,
		listRemoteTerminals: apiMocks.listRemoteTerminals,
		listOwnedTerminals: apiMocks.listOwnedTerminals,
		attachRemoteTerminal: apiMocks.attachRemoteTerminal,
	};
});

import { parseArgvInput, RuntimeDebugPanel } from "./runtime-debug";

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

/**
 * The status probe and the inspector probe (phase 20e) share label
 * text by design — the two sections want to read identically. Tests
 * scope by id (set on each input) to keep the two surfaces
 * independently targetable.
 */
async function waitForInputById(id: string): Promise<HTMLInputElement> {
	return (await waitFor(() => {
		const el = document.getElementById(id);
		if (!el) throw new Error(`${id} input not yet mounted`);
		return el as HTMLInputElement;
	})) as HTMLInputElement;
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
		// Reattach list defaults to empty; individual tests
		// override when they want to exercise the UI.
		apiMocks.listRemoteTerminals.mockResolvedValue([]);
		apiMocks.listOwnedTerminals.mockResolvedValue([]);
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

	it("submits the Command form with the parsed argv when Command mode is picked", async () => {
		const user = userEvent.setup();
		apiMocks.connectCommandRuntime.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();
		await screen.findByLabelText(/Name/);

		// Switch to Command mode + fill in argv. Space-separated form
		// is the muscle-memory path the placeholder shows.
		await user.click(screen.getByRole("radio", { name: /^Command$/i }));
		await user.type(screen.getByLabelText(/Name/), "teleport-dev");
		await user.type(
			screen.getByLabelText(/Command argv/),
			"tsh ssh dev-box helmor-server --proxy",
		);

		// The parsed preview should reflect what gets sent on the wire.
		expect(screen.getByLabelText(/Parsed argv preview/)).toHaveTextContent(
			'Parsed: "tsh" "ssh" "dev-box" "helmor-server" "--proxy"',
		);

		await user.click(screen.getByRole("button", { name: /^Connect$/ }));

		await waitFor(() => {
			expect(apiMocks.connectCommandRuntime).toHaveBeenCalledWith(
				"teleport-dev",
				["tsh", "ssh", "dev-box", "helmor-server", "--proxy"],
			);
		});
	});

	it("refuses to submit Command form with an empty argv", async () => {
		const user = userEvent.setup();
		renderPanel();
		await screen.findByLabelText(/Name/);

		await user.click(screen.getByRole("radio", { name: /^Command$/i }));
		await user.type(screen.getByLabelText(/Name/), "broken");
		// argv left empty.
		await user.click(screen.getByRole("button", { name: /^Connect$/ }));

		await waitFor(() => {
			expect(screen.getByText(/argv must not be empty/)).toBeInTheDocument();
		});
		// And the wire wrapper must NOT have been hit — empty argv
		// should be caught client-side before the IPC.
		expect(apiMocks.connectCommandRuntime).not.toHaveBeenCalled();
	});

	it("parses multi-line argv input as one token per line (preserves whitespace)", async () => {
		// The line-per-token form is the escape hatch for argv slots
		// that legitimately contain whitespace (e.g. a kubectl exec
		// where the command is a multi-word shell invocation).
		const user = userEvent.setup();
		apiMocks.connectCommandRuntime.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();
		await screen.findByLabelText(/Name/);
		await user.click(screen.getByRole("radio", { name: /^Command$/i }));
		await user.type(screen.getByLabelText(/Name/), "k8s-pod");
		// Newlines via Shift+Enter in a textarea. user-event treats
		// `{Enter}` as a regular newline inside a textarea.
		const argvInput = screen.getByLabelText(/Command argv/);
		await user.type(
			argvInput,
			"kubectl{Enter}exec{Enter}-it{Enter}helmor-pod{Enter}--{Enter}helmor-server --proxy",
		);
		await user.click(screen.getByRole("button", { name: /^Connect$/ }));

		await waitFor(() => {
			expect(apiMocks.connectCommandRuntime).toHaveBeenCalledWith("k8s-pod", [
				"kubectl",
				"exec",
				"-it",
				"helmor-pod",
				"--",
				// Last line keeps embedded whitespace intact — that's the
				// whole point of the line-per-token escape hatch.
				"helmor-server --proxy",
			]);
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
		await user.type(
			await waitForInputById("probe-workspace"),
			"/Users/me/code/repo",
		);
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
			await waitForInputById("probe-workspace"),
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
		await user.type(await waitForInputById("probe-workspace"), "/repo");
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
		await user.type(await waitForInputById("probe-workspace"), "/clean/repo");
		await user.click(screen.getByRole("button", { name: /Run probe/ }));

		await waitFor(() => {
			// The status + inspector probes both render "Clean — no changes."
			// when their respective backends return empty results. Anchor on
			// the FIRST occurrence which is the status probe (rendered above
			// the inspector probe in the panel layout).
			const matches = screen.getAllByText(/Clean — no changes\./);
			expect(matches.length).toBeGreaterThan(0);
		});
	});

	it("passes workspaceId through to the probe so the resolver can use the binding", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceStatus.mockResolvedValue({
			isClean: true,
			changedPaths: [],
		});

		renderPanel();
		await user.type(await waitForInputById("probe-workspace"), "/repo");
		await user.type(await waitForInputById("probe-workspace-id"), "ws-bound");
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
		await user.type(await waitForInputById("probe-workspace"), "/repo");
		await user.type(await waitForInputById("probe-workspace-id"), "ws-bound");
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

	// ── workspace inspector probe (phase 20e) ────────────────────────

	it("runs the file-tree probe and renders the first few entries", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceFileTree.mockResolvedValue({
			entries: [
				{
					path: "src/main.rs",
					absolutePath: "/repo/src/main.rs",
					name: "main.rs",
					status: "M",
					stagedInsertions: 0,
					stagedDeletions: 0,
					unstagedInsertions: 0,
					unstagedDeletions: 0,
					committedInsertions: 0,
					committedDeletions: 0,
				},
				{
					path: "Cargo.toml",
					absolutePath: "/repo/Cargo.toml",
					name: "Cargo.toml",
					status: "M",
					stagedInsertions: 0,
					stagedDeletions: 0,
					unstagedInsertions: 0,
					unstagedDeletions: 0,
					committedInsertions: 0,
					committedDeletions: 0,
				},
			],
		});

		renderPanel();
		await user.type(
			await waitForInputById("inspector-probe-workspace"),
			"/repo",
		);
		await user.click(screen.getByRole("button", { name: /Run file tree/ }));

		await waitFor(() => {
			// `runtimeName` / `workspaceId` default to undefined →
			// resolver falls through to local.
			expect(apiMocks.getWorkspaceFileTree).toHaveBeenCalledWith(
				"/repo",
				undefined,
				undefined,
			);
		});
		expect(screen.getByText(/2 files \(showing first 2\)/)).toBeInTheDocument();
		expect(screen.getByText("src/main.rs")).toBeInTheDocument();
		expect(screen.getByText("Cargo.toml")).toBeInTheDocument();
	});

	it("renders the empty file-tree message when the walk returns nothing", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceFileTree.mockResolvedValue({ entries: [] });

		renderPanel();
		await user.type(
			await waitForInputById("inspector-probe-workspace"),
			"/empty",
		);
		await user.click(screen.getByRole("button", { name: /Run file tree/ }));

		await waitFor(() => {
			expect(
				screen.getByText(/No files surfaced by the walk\./),
			).toBeInTheDocument();
		});
	});

	it("runs the changes probe without content (cheap path)", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceChanges.mockResolvedValue({
			items: [
				{
					path: "src/foo.rs",
					absolutePath: "/repo/src/foo.rs",
					name: "foo.rs",
					status: "M",
					stagedInsertions: 0,
					stagedDeletions: 0,
					unstagedInsertions: 2,
					unstagedDeletions: 1,
					committedInsertions: 0,
					committedDeletions: 0,
				},
			],
			prefetched: [],
		});

		renderPanel();
		await user.type(
			await waitForInputById("inspector-probe-workspace"),
			"/repo",
		);
		await user.click(screen.getByRole("button", { name: /^Run changes$/ }));

		await waitFor(() => {
			expect(apiMocks.getWorkspaceChanges).toHaveBeenCalledWith(
				"/repo",
				false,
				undefined,
				undefined,
			);
		});
		expect(
			screen.getByText(/1 changed path · content omitted/),
		).toBeInTheDocument();
		expect(screen.getByText("src/foo.rs (M)")).toBeInTheDocument();
	});

	it("runs the changes probe with content + reports prefetched count", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceChanges.mockResolvedValue({
			items: [
				{
					path: "src/foo.rs",
					absolutePath: "/repo/src/foo.rs",
					name: "foo.rs",
					status: "M",
					stagedInsertions: 0,
					stagedDeletions: 0,
					unstagedInsertions: 2,
					unstagedDeletions: 1,
					committedInsertions: 0,
					committedDeletions: 0,
				},
			],
			prefetched: [{ absolutePath: "/repo/src/foo.rs", content: "new body" }],
		});

		renderPanel();
		await user.type(
			await waitForInputById("inspector-probe-workspace"),
			"/repo",
		);
		await user.click(
			screen.getByRole("button", { name: /Run changes \(with content\)/ }),
		);

		await waitFor(() => {
			expect(apiMocks.getWorkspaceChanges).toHaveBeenCalledWith(
				"/repo",
				true,
				undefined,
				undefined,
			);
		});
		expect(
			screen.getByText(/1 changed path · prefetched 1/),
		).toBeInTheDocument();
	});

	it("inspector probe forwards workspaceId + runtimeName to the resolver", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getWorkspaceFileTree.mockResolvedValue({ entries: [] });

		renderPanel();
		await user.type(
			await waitForInputById("inspector-probe-workspace"),
			"/repo",
		);
		await user.type(
			await waitForInputById("inspector-probe-workspace-id"),
			"ws-bound",
		);
		// Switch to the explicit remote runtime. The inspector probe
		// has its own dropdown id distinct from the status probe.
		const inspectorRuntime = document.getElementById(
			"inspector-probe-runtime",
		) as HTMLSelectElement | null;
		if (!inspectorRuntime) throw new Error("inspector-probe-runtime missing");
		await user.selectOptions(inspectorRuntime, "dev.box");
		await user.click(screen.getByRole("button", { name: /Run file tree/ }));

		await waitFor(() => {
			expect(apiMocks.getWorkspaceFileTree).toHaveBeenCalledWith(
				"/repo",
				"ws-bound",
				"dev.box",
			);
		});
	});

	it("inspector probe surfaces backend errors as an error notice", async () => {
		const user = userEvent.setup();
		apiMocks.getWorkspaceChanges.mockRejectedValue(
			new Error("workspace.changes failed: not a git repository"),
		);

		renderPanel();
		await user.type(
			await waitForInputById("inspector-probe-workspace"),
			"/notrepo",
		);
		await user.click(screen.getByRole("button", { name: /^Run changes$/ }));

		await waitFor(() => {
			expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
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

	// ── Remote terminal section ────────────────────────────────

	it("hides the terminal section when no remote runtimes are connected", async () => {
		// Only local; remote terminals require a remote.
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY]);
		renderPanel();
		// Wait for the panel to render its other forms first.
		await screen.findByLabelText(/Name/);
		// The terminal section's empty-state notice carries this
		// distinctive phrase.
		await waitFor(() => {
			expect(
				screen.getByText(/Connect a remote runtime first/),
			).toBeInTheDocument();
		});
		// And no "Open terminal" button while remotes are absent.
		expect(
			screen.queryByRole("button", { name: /Open terminal/ }),
		).not.toBeInTheDocument();
	});

	it("opens a remote terminal and renders streamed stdout events", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		// openRemoteTerminal's `onEvent` is the third arg's `onEvent`
		// callback — capture it so the test can feed events back into
		// the panel synchronously after the resolve.
		let capturedOnEvent:
			| ((event: import("@/lib/api").TerminalEventNotification) => void)
			| null = null;
		apiMocks.openRemoteTerminal.mockImplementation(
			(_runtime, _id, _dir, options) => {
				capturedOnEvent = options.onEvent;
				return Promise.resolve({ pid: 1234 });
			},
		);

		renderPanel();

		// Wait for the terminal section's runtime dropdown to render
		// — it's only rendered when at least one remote is present.
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");

		const dirInput = screen.getByLabelText(/Workspace dir/, {
			selector: "#rt-dir",
		});
		await user.type(dirInput, "/home/me/repo");

		await user.click(screen.getByRole("button", { name: /Open terminal/ }));

		await waitFor(() => {
			expect(apiMocks.openRemoteTerminal).toHaveBeenCalled();
		});
		// pid appears in the diagnostic header.
		await waitFor(() => {
			expect(screen.getByText(/pid=1234/)).toBeInTheDocument();
		});

		// Feed a synthetic stdout event back through the captured
		// onEvent. The panel's appendOutput should drop it into the
		// scrollback <pre>.
		expect(capturedOnEvent).not.toBeNull();
		// TypeScript narrows `capturedOnEvent` to `null` after the
		// closure assignment unless we re-bind via the assertion above.
		(
			capturedOnEvent as unknown as (
				event: import("@/lib/api").TerminalEventNotification,
			) => void
		)({
			terminalId: "ignored-by-panel-filter",
			event: { kind: "stdout", data: "$ helmor-pty-marker\n" },
		});

		await waitFor(() => {
			expect(screen.getByText(/helmor-pty-marker/)).toBeInTheDocument();
		});
	});

	it("sends terminal input on Enter with a trailing carriage return", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		apiMocks.openRemoteTerminal.mockResolvedValue({ pid: 99 });
		apiMocks.writeRemoteTerminal.mockResolvedValue({ bytesWritten: 5 });

		renderPanel();
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");
		await user.type(
			screen.getByLabelText(/Workspace dir/, { selector: "#rt-dir" }),
			"/tmp",
		);
		await user.click(screen.getByRole("button", { name: /Open terminal/ }));
		await waitFor(() => {
			expect(apiMocks.openRemoteTerminal).toHaveBeenCalled();
		});

		const cmdInput = await screen.findByPlaceholderText(
			/type a command and press Enter/,
		);
		await user.type(cmdInput, "ls");
		await user.keyboard("{Enter}");

		await waitFor(() => {
			expect(apiMocks.writeRemoteTerminal).toHaveBeenCalled();
		});
		const lastCall =
			apiMocks.writeRemoteTerminal.mock.calls[
				apiMocks.writeRemoteTerminal.mock.calls.length - 1
			];
		expect(lastCall[2]).toBe("ls\r");
	});

	it("close button tears down the session and stops accepting input", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		apiMocks.openRemoteTerminal.mockResolvedValue({ pid: 1 });
		apiMocks.closeRemoteTerminal.mockResolvedValue(undefined);

		renderPanel();
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");
		await user.type(
			screen.getByLabelText(/Workspace dir/, { selector: "#rt-dir" }),
			"/tmp",
		);
		await user.click(screen.getByRole("button", { name: /Open terminal/ }));
		await screen.findByRole("button", { name: /Close terminal/ });

		await user.click(screen.getByRole("button", { name: /Close terminal/ }));
		await waitFor(() => {
			expect(apiMocks.closeRemoteTerminal).toHaveBeenCalledWith(
				"stage",
				expect.any(String),
			);
		});
		// After close, the Open button reappears.
		await screen.findByRole("button", { name: /Open terminal/ });
	});

	// ── Reattach UI (phase 19c) ────────────────────────────────

	it("lists live remote terminals when a runtime is selected", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		apiMocks.listRemoteTerminals.mockResolvedValue([
			{
				terminalId: "t-owned",
				pid: 100,
				workspaceDir: "/work/a",
				openedAtMs: 1,
				cols: 80,
				rows: 24,
			},
			{
				terminalId: "t-other",
				pid: 101,
				workspaceDir: "/work/b",
				openedAtMs: 2,
				cols: 120,
				rows: 30,
			},
		]);
		apiMocks.listOwnedTerminals.mockResolvedValue(["t-owned"]);

		renderPanel();
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");

		// Wait for both calls to complete.
		await waitFor(() => {
			expect(apiMocks.listRemoteTerminals).toHaveBeenCalledWith("stage");
			expect(apiMocks.listOwnedTerminals).toHaveBeenCalledWith("stage");
		});

		// Each row renders its terminalId in font-mono.
		await screen.findByText("t-owned");
		await screen.findByText("t-other");
		// Owned terminal is marked "yours", the unknown one "other".
		expect(screen.getByText(/^yours$/)).toBeInTheDocument();
		expect(screen.getByText(/^other$/)).toBeInTheDocument();
	});

	it("attaches to a live terminal and paints scrollback as initial output", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		apiMocks.listRemoteTerminals.mockResolvedValue([
			{
				terminalId: "t-survives",
				pid: 200,
				workspaceDir: "/tmp",
				openedAtMs: 1,
				cols: 80,
				rows: 24,
			},
		]);
		apiMocks.listOwnedTerminals.mockResolvedValue(["t-survives"]);

		// The mock returns the captured scrollback string; subsequent
		// live events would come through `onEvent` but the test only
		// asserts on the initial paint.
		apiMocks.attachRemoteTerminal.mockResolvedValue({
			scrollback: "$ ls\nfile.txt\n",
			cols: 80,
			rows: 24,
		});

		renderPanel();
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");

		const attachButton = await screen.findByRole("button", { name: /Attach/ });
		await user.click(attachButton);

		await waitFor(() => {
			expect(apiMocks.attachRemoteTerminal).toHaveBeenCalledWith(
				"stage",
				"t-survives",
				expect.objectContaining({ onEvent: expect.any(Function) }),
			);
		});
		// Scrollback is rendered in the <pre>.
		await waitFor(() => {
			expect(screen.getByText(/file\.txt/)).toBeInTheDocument();
		});
		// Once attached, the Close button takes over from Open.
		await screen.findByRole("button", { name: /Close terminal/ });
	});

	it("refreshes the reattach list on demand", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		apiMocks.listRemoteTerminals.mockResolvedValue([]);
		apiMocks.listOwnedTerminals.mockResolvedValue([]);

		renderPanel();
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");

		// First call is the auto-fetch on runtime select.
		await waitFor(() => {
			expect(apiMocks.listRemoteTerminals).toHaveBeenCalledTimes(1);
		});

		await user.click(screen.getByRole("button", { name: /^Refresh$/ }));

		await waitFor(() => {
			expect(apiMocks.listRemoteTerminals).toHaveBeenCalledTimes(2);
		});
	});

	it("reports a list error inline without breaking the open form", async () => {
		const user = userEvent.setup();
		const remote: RuntimeEntry = {
			name: "stage",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remote]);
		apiMocks.listRemoteTerminals.mockRejectedValue(
			new Error("daemon: connection refused"),
		);
		apiMocks.listOwnedTerminals.mockResolvedValue([]);

		renderPanel();
		const runtimeSelect = await screen.findByLabelText(/Runtime/, {
			selector: "#rt-runtime",
		});
		await user.selectOptions(runtimeSelect, "stage");

		await waitFor(() => {
			expect(
				screen.getByText(/daemon: connection refused/),
			).toBeInTheDocument();
		});

		// The Open form is still functional even though listing failed.
		expect(
			screen.getByLabelText(/Workspace dir/, { selector: "#rt-dir" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Open terminal/ }),
		).toBeInTheDocument();
	});
});

describe("parseArgvInput", () => {
	it("splits a single-line input on whitespace runs", () => {
		expect(parseArgvInput("tsh ssh dev-box helmor-server --proxy")).toEqual([
			"tsh",
			"ssh",
			"dev-box",
			"helmor-server",
			"--proxy",
		]);
	});

	it("collapses repeated whitespace between tokens", () => {
		// Stray double-spaces shouldn't surface as empty tokens —
		// the backend rejects empty argv slots, so we filter here.
		expect(parseArgvInput("a   b\t\tc")).toEqual(["a", "b", "c"]);
	});

	it("treats a multi-line input as one token per line", () => {
		// The escape hatch for tokens with embedded whitespace.
		const input = ["kubectl", "exec", "-it", "pod", "--", "helmor server"].join(
			"\n",
		);
		expect(parseArgvInput(input)).toEqual([
			"kubectl",
			"exec",
			"-it",
			"pod",
			"--",
			"helmor server",
		]);
	});

	it("returns an empty array for whitespace-only input", () => {
		expect(parseArgvInput("")).toEqual([]);
		expect(parseArgvInput("   ")).toEqual([]);
		expect(parseArgvInput("\n  \n")).toEqual([]);
	});

	it("trims surrounding whitespace on each line in multi-line mode", () => {
		expect(parseArgvInput("  tsh  \n  ssh  \n  dev-box  ")).toEqual([
			"tsh",
			"ssh",
			"dev-box",
		]);
	});
});
