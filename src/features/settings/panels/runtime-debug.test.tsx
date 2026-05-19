import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentReattachRequest,
	AgentReattachResponse,
	AgentStreamEvent,
	RuntimeEntry,
	RuntimeHealth,
} from "@/lib/api";
import { renderWithProviders } from "@/test/render-with-providers";

const apiMocks = vi.hoisted(() => ({
	listRemoteRuntimes: vi.fn(),
	getRuntimeHealth: vi.fn(),
	connectCommandRuntime: vi.fn(),
	connectLocalRuntime: vi.fn(),
	connectRemoteRuntime: vi.fn(),
	disconnectRemoteRuntime: vi.fn(),
	reconnectRemoteRuntime: vi.fn(),
	setRuntimeAgentAuth: vi.fn(),
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
	listRemoteAgentSessions: vi.fn(),
	abortRemoteAgentSession: vi.fn(),
	attachRemoteAgentSession: vi.fn(),
	reattachRemoteAgentSessionStream: vi.fn(),
	releaseRemoteAgentStream: vi.fn(),
	startAgentReattachStream: vi.fn(),
	getRemoteRuntimeDiagnostics: vi.fn(),
	startRemotePortForward: vi.fn(),
	stopRemotePortForward: vi.fn(),
	listRemotePortForwards: vi.fn(),
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
		setRuntimeAgentAuth: apiMocks.setRuntimeAgentAuth,
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
		listRemoteAgentSessions: apiMocks.listRemoteAgentSessions,
		abortRemoteAgentSession: apiMocks.abortRemoteAgentSession,
		attachRemoteAgentSession: apiMocks.attachRemoteAgentSession,
		reattachRemoteAgentSessionStream: apiMocks.reattachRemoteAgentSessionStream,
		releaseRemoteAgentStream: apiMocks.releaseRemoteAgentStream,
		startAgentReattachStream: apiMocks.startAgentReattachStream,
		getRemoteRuntimeDiagnostics: apiMocks.getRemoteRuntimeDiagnostics,
		startRemotePortForward: apiMocks.startRemotePortForward,
		stopRemotePortForward: apiMocks.stopRemotePortForward,
		listRemotePortForwards: apiMocks.listRemotePortForwards,
	};
});

import {
	parseArgvInput,
	parseSshUrl,
	previewSpawnedCommand,
	RuntimeDebugPanel,
} from "./runtime-debug";

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
		// Remote agent sessions: default to empty list so the
		// section renders its empty-state without surprising the
		// other tests.
		apiMocks.listRemoteAgentSessions.mockResolvedValue([]);
		apiMocks.abortRemoteAgentSession.mockResolvedValue(undefined);
		apiMocks.attachRemoteAgentSession.mockResolvedValue(true);
		// Default: every streaming reattach succeeds with `found=true`
		// — individual tests override for the notFound / error paths.
		apiMocks.reattachRemoteAgentSessionStream.mockResolvedValue({
			found: true,
		});
		apiMocks.releaseRemoteAgentStream.mockResolvedValue({ released: true });
		// Default: chat-cooked reattach accepts and emits no events
		// — individual tests override to capture the callback so
		// they can drive scripted AgentStreamEvents through it.
		apiMocks.startAgentReattachStream.mockResolvedValue({
			accepted: true,
		} satisfies AgentReattachResponse);
		// Default: a minimal diagnostics snapshot that the
		// Connection diagnostics section can render without
		// crashing. Individual tests override with richer
		// shapes when they want to assert on specific fields.
		apiMocks.getRemoteRuntimeDiagnostics.mockResolvedValue({
			name: "local",
			state: { type: "connected" },
			health: {
				kind: { type: "local" },
				hostname: "test-machine",
				version: "0.0.0-test",
			},
			client: null,
			agentSessionCount: null,
			lastPingMs: 1,
			lastError: null,
		});
		// Port forwards default to empty list + happy-path
		// start/stop mocks — individual tests override.
		apiMocks.listRemotePortForwards.mockResolvedValue([]);
		apiMocks.stopRemotePortForward.mockResolvedValue({ stopped: true });
		apiMocks.startRemotePortForward.mockImplementation(
			async (args: {
				runtimeName: string;
				localPort: number;
				remotePort: number;
				label?: string;
			}) => ({
				runtimeName: args.runtimeName,
				localPort: args.localPort,
				remotePort: args.remotePort,
				label: args.label ?? null,
				startedAtMs: Date.now(),
			}),
		);
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

	it("pasting an ssh:// URL pre-fills the Host field and surfaces a hint", async () => {
		// Phase 21e: the paste-URL helper short-circuits the
		// type-out-the-host flow. Verifies the parser actually wires
		// to the Host input + emits the user-visible hint.
		const user = userEvent.setup();
		apiMocks.connectRemoteRuntime.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();
		await screen.findByLabelText(/Name/);
		await user.click(screen.getByRole("radio", { name: /^SSH$/i }));

		// Paste a URL with a port — the hint should call out that
		// the port was dropped.
		await user.type(
			screen.getByLabelText(/Paste ssh:\/\/ URL/),
			"ssh://david@dev.box:2222",
		);

		await waitFor(() => {
			expect(screen.getByLabelText(/^Host$/)).toHaveValue("david@dev.box");
		});
		expect(screen.getByLabelText(/SSH URL parse hint/)).toHaveTextContent(
			/port 2222 dropped/,
		);

		// Clicking Connect should submit with the parsed host.
		await user.type(screen.getByLabelText(/Name/), "via-paste");
		await user.click(screen.getByRole("button", { name: /^Connect$/ }));
		await waitFor(() => {
			expect(apiMocks.connectRemoteRuntime).toHaveBeenCalledWith(
				"via-paste",
				"david@dev.box",
				"helmor-server",
			);
		});
	});

	it("renders the spawn-preview block matching the active mode", async () => {
		const user = userEvent.setup();
		renderPanel();
		await screen.findByLabelText(/Name/);

		// Local mode (default) shows the auto-detect shape.
		expect(screen.getByLabelText(/Spawned command preview/)).toHaveTextContent(
			/spawn helmor-server \(auto-detect\)/,
		);

		// Switching to SSH + typing a host updates the preview.
		await user.click(screen.getByRole("radio", { name: /^SSH$/i }));
		await user.type(screen.getByLabelText(/^Host$/), "dev.box");
		await waitFor(() => {
			expect(
				screen.getByLabelText(/Spawned command preview/),
			).toHaveTextContent(/ssh -o BatchMode=yes dev\.box/);
		});

		// Switching to Command shows the literal argv as the user types.
		await user.click(screen.getByRole("radio", { name: /^Command$/i }));
		await user.type(
			screen.getByLabelText(/Command argv/),
			"tsh ssh dev-box helmor-server --proxy",
		);
		await waitFor(() => {
			expect(
				screen.getByLabelText(/Spawned command preview/),
			).toHaveTextContent("tsh ssh dev-box helmor-server --proxy");
		});
	});

	it("renders a transport-kind chip next to each non-local runtime", async () => {
		// Phase 21e: the transport chip exposes the flavor (`ssh` /
		// `cmd`) so an operator can tell two degraded entries apart at
		// a glance without opening the tooltip. We assert by looking
		// for the lowercase chip text in the rendered DOM — each chip
		// is its own <span> with exactly that text content.
		const sshEntry: RuntimeEntry = {
			name: "ssh-remote",
			isLocal: false,
			state: { type: "connected" },
			config: { type: "ssh", host: "dev.box", remoteBinary: "helmor-server" },
		};
		const cmdEntry: RuntimeEntry = {
			name: "cmd-remote",
			isLocal: false,
			state: { type: "connected" },
			config: { type: "command", argv: ["tsh", "ssh", "dev-box", "bin"] },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([
			LOCAL_ENTRY,
			sshEntry,
			cmdEntry,
		]);

		renderPanel();

		// Wait for the list query to settle. Each runtime name is
		// rendered in at least one place (multiple if the runtime
		// appears in both the list row + a button label). We just
		// need to confirm the rows rendered at all.
		await waitFor(() => {
			expect(screen.getAllByText("ssh-remote").length).toBeGreaterThan(0);
			expect(screen.getAllByText("cmd-remote").length).toBeGreaterThan(0);
		});

		// The transport chips render `ssh` and `cmd` as their own
		// text-only spans. The state chip text is `connected`, so
		// these strings unambiguously identify the transport chip.
		const chipTexts = Array.from(document.querySelectorAll("span"))
			.map((el) => el.textContent ?? "")
			.filter((t) => t === "ssh" || t === "cmd");
		// One `ssh` chip (ssh-remote), one `cmd` chip (cmd-remote).
		expect(chipTexts).toContain("ssh");
		expect(chipTexts).toContain("cmd");
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

	// ── Set agent auth section (phase 23e) ────────────────────────

	it("shows the empty hint when no remote runtimes are registered", async () => {
		// Only the built-in local entry exists → the auth section
		// should refuse to render the form and explain why.
		renderPanel();
		await screen.findByText(
			/Register a remote runtime in the Connect form above/,
		);
	});

	it("submits the auth form through setRuntimeAgentAuth and clears the key on success", async () => {
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
		apiMocks.setRuntimeAgentAuth.mockResolvedValue(undefined);

		renderPanel();
		// The provider input is part of the auth form section.
		const providerInput = await screen.findByLabelText(/^Provider$/);
		// Default-selected runtime is the first remote entry.
		// Scope to the section's own select id since "Runtime"
		// appears as a label in the probe sections above too.
		const runtimeSelect = document.getElementById(
			"rt-auth-runtime",
		) as HTMLSelectElement;
		expect(runtimeSelect).toHaveValue("dev.box");

		// Provider defaults to "cursor"; verify + type a key.
		expect(providerInput).toHaveValue("cursor");
		const apiKeyInput = screen.getByLabelText(/^API key$/);
		await user.type(apiKeyInput, "sk-test-key");

		const saveButton = screen.getByRole("button", { name: /^Save$/ });
		await user.click(saveButton);

		await waitFor(() => {
			expect(apiMocks.setRuntimeAgentAuth).toHaveBeenCalledWith(
				"dev.box",
				"cursor",
				"sk-test-key",
			);
		});
		// Key cleared on success so it doesn't linger visible.
		await waitFor(() => {
			expect(screen.getByLabelText(/^API key$/)).toHaveValue("");
		});
		// And a confirmation appears.
		expect(screen.getByText(/Saved on remote/)).toBeInTheDocument();
	});

	it("Clear button posts a null key to setRuntimeAgentAuth", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.setRuntimeAgentAuth.mockResolvedValue(undefined);

		renderPanel();
		await screen.findByLabelText(/^API key$/);
		// API key intentionally left blank — Clear should still fire
		// with `null` regardless.
		const clearButton = screen.getByRole("button", { name: /^Clear$/ });
		await user.click(clearButton);

		await waitFor(() => {
			expect(apiMocks.setRuntimeAgentAuth).toHaveBeenCalledWith(
				"dev.box",
				"cursor",
				null,
			);
		});
	});

	it("surfaces backend errors from setRuntimeAgentAuth verbatim", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.setRuntimeAgentAuth.mockRejectedValue(
			new Error("agent runtime is not available: HELMOR_SIDECAR_PATH not set"),
		);

		renderPanel();
		const apiKeyInput = await screen.findByLabelText(/^API key$/);
		await user.type(apiKeyInput, "sk");
		await user.click(screen.getByRole("button", { name: /^Save$/ }));

		await waitFor(() => {
			expect(
				screen.getByText(/HELMOR_SIDECAR_PATH not set/),
			).toBeInTheDocument();
		});
	});

	// ── Remote agent sessions section (phase 24d) ──────────────────

	it("agent sessions section: shows hint when no remote runtimes are registered", async () => {
		// Only the built-in `local` entry — the section should refuse
		// to render its session list and instead show an actionable
		// hint pointing the operator at the Connect form.
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY]);

		renderPanel();

		// The hint copy is unique to this section so the regex
		// disambiguates it from the auth section's empty state.
		expect(
			await screen.findByText(
				/No remote runtimes connected yet — agent sessions appear here/i,
			),
		).toBeInTheDocument();
		// The runtime picker for THIS section must not appear when
		// no remote runtimes exist — confirms the empty-state branch
		// renders instead of an empty <select>.
		expect(document.getElementById("rt-sessions-runtime")).toBeNull();
	});

	it("agent sessions section: renders the daemon's session list with provider + workspace", async () => {
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-running-1",
				helmorSessionId: "hs-7",
				provider: "claude",
				workspaceDir: "/srv/repos/demo",
				startedAtMs: Date.now() - 5_000,
				lastEventMs: Date.now() - 1_000,
			},
		]);

		renderPanel();

		// The request id renders verbatim — the operator uses it to
		// correlate against the daemon's log lines.
		expect(await screen.findByText("req-running-1")).toBeInTheDocument();
		// Provider + workspace dir surface in the descriptive line.
		const row = screen.getByTestId("remote-agent-session-req-running-1");
		expect(row.textContent).toContain("claude");
		expect(row.textContent).toContain("/srv/repos/demo");
		// Both action buttons are wired up.
		expect(
			screen.getByRole("button", { name: /Reattach to req-running-1/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Abort req-running-1/ }),
		).toBeInTheDocument();
	});

	it("agent sessions section: Abort button calls the runtime then refreshes the listing", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-abort-me",
				helmorSessionId: null,
				provider: "codex",
				workspaceDir: "/repo",
				startedAtMs: Date.now() - 10_000,
				lastEventMs: Date.now() - 500,
			},
		]);

		renderPanel();
		await screen.findByText("req-abort-me");

		const baselineListCalls =
			apiMocks.listRemoteAgentSessions.mock.calls.length;
		await user.click(
			screen.getByRole("button", { name: /Abort req-abort-me/ }),
		);

		await waitFor(() => {
			expect(apiMocks.abortRemoteAgentSession).toHaveBeenCalledWith(
				"dev.box",
				"req-abort-me",
			);
		});
		// Success notice surfaces so the operator knows the abort
		// took effect on the daemon.
		expect(
			await screen.findByText(/Abort sent to req-abort-me/),
		).toBeInTheDocument();
		// And the listing refetches after the mutation so a stale
		// "still running" row doesn't linger after the daemon tears
		// the session down.
		await waitFor(() => {
			expect(
				apiMocks.listRemoteAgentSessions.mock.calls.length,
			).toBeGreaterThan(baselineListCalls);
		});
	});

	it("agent sessions section: Reattach starts a streaming subscription and surfaces the event log", async () => {
		// Phase 24i: clicking Reattach now opens a live event
		// stream via reattachRemoteAgentSessionStream. The panel
		// surfaces a "streaming events for ..." notice + renders
		// the event log placeholder.
		let onEvent:
			| ((event: { requestId: string; event: unknown }) => void)
			| null = null;
		apiMocks.reattachRemoteAgentSessionStream.mockImplementation(
			async (_name: string, _requestId: string, cb: typeof onEvent) => {
				onEvent = cb;
				return { found: true };
			},
		);

		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-attach-1",
				helmorSessionId: "hs-x",
				provider: "claude",
				workspaceDir: "/srv/demo",
				startedAtMs: Date.now() - 30_000,
				lastEventMs: Date.now() - 200,
			},
		]);

		renderPanel();
		await screen.findByText("req-attach-1");
		await user.click(
			screen.getByRole("button", { name: /Reattach to req-attach-1/ }),
		);

		await waitFor(() => {
			expect(apiMocks.reattachRemoteAgentSessionStream).toHaveBeenCalledWith(
				"dev.box",
				"req-attach-1",
				expect.any(Function),
			);
		});
		// Live event log mounts as soon as streaming begins.
		expect(await screen.findByTestId("reattach-event-log")).toBeInTheDocument();

		// Fire a synthesised event through the captured callback;
		// the log gains a row + the notice reports the count.
		expect(onEvent).not.toBeNull();
		await act(async () => {
			onEvent?.({
				requestId: "req-attach-1",
				event: { type: "assistant", delta: "hello world" },
			});
		});
		const logList = await screen.findByTestId("reattach-event-log-list");
		expect(logList.textContent).toContain("hello world");
	});

	it("agent sessions section: streaming Reattach surfaces an info notice when the daemon reports the session ended", async () => {
		// found=false on the streaming RPC means the daemon lost
		// the session between list + attach. UI shows "Session
		// has ended" + does NOT mount the event log.
		apiMocks.reattachRemoteAgentSessionStream.mockResolvedValueOnce({
			found: false,
		});
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-stale",
				helmorSessionId: null,
				provider: null,
				workspaceDir: null,
				startedAtMs: Date.now() - 60_000,
				lastEventMs: Date.now() - 50_000,
			},
		]);

		renderPanel();
		await screen.findByText("req-stale");
		await user.click(
			screen.getByRole("button", { name: /Reattach to req-stale/ }),
		);

		expect(await screen.findByText(/Session has ended/i)).toBeInTheDocument();
		// No event log mounts on the notFound path.
		expect(screen.queryByTestId("reattach-event-log")).toBeNull();
	});

	it("agent sessions section: stop button on a streaming row releases the subscription", async () => {
		apiMocks.reattachRemoteAgentSessionStream.mockResolvedValue({
			found: true,
		});
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-streaming",
				helmorSessionId: null,
				provider: "claude",
				workspaceDir: "/srv/demo",
				startedAtMs: Date.now() - 10_000,
				lastEventMs: Date.now() - 200,
			},
		]);

		renderPanel();
		await screen.findByText("req-streaming");
		await user.click(
			screen.getByRole("button", { name: /Reattach to req-streaming/ }),
		);
		// The button's label flips to "Stop streaming ..." while
		// the stream is live.
		const stopButton = await screen.findByRole("button", {
			name: /Stop streaming req-streaming/,
		});
		await user.click(stopButton);

		await waitFor(() => {
			expect(apiMocks.releaseRemoteAgentStream).toHaveBeenCalledWith(
				"req-streaming",
			);
		});
	});

	// ── Chat preview (phase 24l) ──────────────────────────────

	it("agent sessions section: Chat preview button is disabled until the row reports a helmor session id", async () => {
		// 24l's invariant: the cooked stream needs a helmor
		// session id to know where to route messages. Sessions
		// without one (anonymous test flows) still appear in the
		// list, but the chat-preview affordance must stay
		// disabled so the operator gets a tooltip instead of an
		// RPC error.
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-anon",
				helmorSessionId: null,
				provider: "claude",
				workspaceDir: "/srv/demo",
				startedAtMs: Date.now() - 10_000,
				lastEventMs: Date.now() - 200,
			},
		]);

		renderPanel();
		const previewButton = await screen.findByRole("button", {
			name: /Open chat preview for req-anon/,
		});
		expect(previewButton).toBeDisabled();
	});

	it("agent sessions section: Chat preview pipes daemon AgentStreamEvents into the preview list", async () => {
		// The full wiring test: click the Chat preview button,
		// drive scripted AgentStreamEvent envelopes through the
		// captured callback, and assert the preview rows render
		// the cooked message text. This is the automatic
		// counterpart to a manual SSH reattach.
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		let capturedRequest: AgentReattachRequest | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (
				request: AgentReattachRequest,
				cb: (event: AgentStreamEvent) => void,
			) => {
				capturedRequest = request;
				onEvent = cb;
				return { accepted: true } satisfies AgentReattachResponse;
			},
		);

		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-chat-1",
				helmorSessionId: "hs-chat-1",
				provider: "claude",
				workspaceDir: "/srv/demo",
				startedAtMs: Date.now() - 5_000,
				lastEventMs: Date.now() - 100,
			},
		]);

		renderPanel();
		await screen.findByText("req-chat-1");
		await user.click(
			screen.getByRole("button", { name: /Open chat preview for req-chat-1/ }),
		);

		await waitFor(() => {
			expect(apiMocks.startAgentReattachStream).toHaveBeenCalled();
		});
		// The request payload carries the row's identifiers verbatim
		// so the backend can resolve the right transport.
		expect(capturedRequest).toMatchObject({
			requestId: "req-chat-1",
			helmorSessionId: "hs-chat-1",
			provider: "claude",
			workingDirectory: "/srv/demo",
		});
		// The preview mounts as soon as start() resolves.
		expect(
			await screen.findByTestId("reattach-chat-preview"),
		).toBeInTheDocument();

		// Drive a streamingPartial → update → done sequence. The
		// preview should accumulate the cooked message text and
		// then surface the terminal label.
		expect(onEvent).not.toBeNull();
		await act(async () => {
			onEvent?.({
				kind: "streamingPartial",
				message: {
					role: "assistant",
					content: [{ type: "text", id: "p1", text: "thinking…" }],
				},
			});
		});
		expect(
			(await screen.findByTestId("reattach-chat-preview-list")).textContent,
		).toContain("thinking");

		await act(async () => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						id: "m1",
						role: "assistant",
						content: [
							{ type: "text", id: "t1", text: "Hello from the daemon." },
						],
					},
				],
			});
		});
		expect(
			(await screen.findByTestId("reattach-chat-preview-list")).textContent,
		).toContain("Hello from the daemon.");

		await act(async () => {
			onEvent?.({
				kind: "done",
				provider: "claude",
				modelId: "claude-opus-4-7",
				resolvedModel: "claude-opus-4-7",
				sessionId: "sdk-session-7",
				workingDirectory: "/srv/demo",
				persisted: false,
			});
		});
		// Terminal label is bubbled into the header so the operator
		// knows the daemon emitted `result` rather than the connection
		// dropping.
		expect(
			(await screen.findByTestId("reattach-chat-preview")).textContent,
		).toMatch(/Turn finished/);
	});

	it("agent sessions section: Stop preview tears down the active chat stream", async () => {
		// Stopping mid-stream returns the row to its default
		// affordance and clears `currentRequestId` on the chat
		// hook — verified by the button label flipping back.
		let onEvent: ((event: AgentStreamEvent) => void) | null = null;
		apiMocks.startAgentReattachStream.mockImplementation(
			async (
				_request: AgentReattachRequest,
				cb: (event: AgentStreamEvent) => void,
			) => {
				onEvent = cb;
				return { accepted: true } satisfies AgentReattachResponse;
			},
		);

		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockResolvedValue([
			{
				requestId: "req-chat-stop",
				helmorSessionId: "hs-chat-stop",
				provider: "claude",
				workspaceDir: "/srv/demo",
				startedAtMs: Date.now() - 1_000,
				lastEventMs: Date.now() - 50,
			},
		]);

		renderPanel();
		await screen.findByText("req-chat-stop");
		await user.click(
			screen.getByRole("button", {
				name: /Open chat preview for req-chat-stop/,
			}),
		);
		// Drive one event so the preview mounts.
		await waitFor(() => expect(onEvent).not.toBeNull());
		await act(async () => {
			onEvent?.({
				kind: "update",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", id: "x", text: "hi" }],
					},
				],
			});
		});
		// Button flips to "Stop chat preview ..." while active.
		const stopButton = await screen.findByRole("button", {
			name: /Stop chat preview for req-chat-stop/,
		});
		await user.click(stopButton);

		// Once stopped, the row's button reverts and the preview
		// component drops the "streaming" header in favour of the
		// idle "Chat preview" label.
		await waitFor(() => {
			expect(
				screen.queryByRole("button", {
					name: /Stop chat preview for req-chat-stop/,
				}),
			).toBeNull();
		});
		expect(
			screen.getByRole("button", {
				name: /Open chat preview for req-chat-stop/,
			}),
		).toBeInTheDocument();
	});

	it("agent sessions section: surfaces runtime errors instead of swallowing them", async () => {
		// When `agent.list` blows up — e.g. the runtime got disconnected
		// since the last refresh — the React Query error must surface
		// as a notice rather than rendering a stale empty list (which
		// would hide the failure).
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemoteAgentSessions.mockRejectedValue(
			new Error("agent.list failed: connection lost"),
		);

		renderPanel();

		expect(
			await screen.findByText(/agent\.list failed: connection lost/),
		).toBeInTheDocument();
	});

	// ── Connection diagnostics section (phase 24j) ────────────────

	it("connection diagnostics: renders local runtime card with state chip + ping", async () => {
		// Default empty-runtimes setup → the section's dropdown
		// defaults to "local", which our default mock resolves
		// with a healthy snapshot.
		renderPanel();

		const card = await screen.findByTestId("connection-diagnostics-card");
		expect(card).toBeInTheDocument();
		expect(screen.getByTestId("diagnostics-state-chip").textContent).toContain(
			"Connected",
		);
		expect(screen.getByTestId("diagnostics-ping-ms").textContent).toContain(
			"ping 1ms",
		);
	});

	it("connection diagnostics: renders client telemetry counters when remote runtime is picked", async () => {
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.getRemoteRuntimeDiagnostics.mockResolvedValue({
			name: "dev.box",
			state: { type: "connected" },
			health: {
				kind: { type: "remote", host: "dev.box" },
				hostname: "dev.box",
				version: "0.22.1",
			},
			client: {
				peerLabel: "ssh:dev.box",
				serverVersion: "0.22.1",
				serverHostname: "dev.box",
				protocolVersion: "0.1.0",
				connectedAtMs: Date.now() - 90_000,
				closedReason: null,
				requestsSent: 12,
				responsesReceived: 11,
				notificationsReceived: 4,
				decodeErrors: 0,
			},
			agentSessionCount: 2,
			lastPingMs: 24,
			lastError: null,
		});

		renderPanel();

		const card = await screen.findByTestId("connection-diagnostics-card");
		// Telemetry counters render verbatim.
		expect(card.textContent).toContain("12");
		expect(card.textContent).toContain("11");
		expect(card.textContent).toContain("4");
		expect(card.textContent).toContain("ssh:dev.box");
		// Agent sessions count surfaces.
		expect(card.textContent).toMatch(/Agent sessions/);
		expect(card.textContent).toContain("2");
	});

	it("connection diagnostics: surfaces ping failure as red badge instead of latency", async () => {
		apiMocks.getRemoteRuntimeDiagnostics.mockResolvedValue({
			name: "local",
			state: { type: "connected" },
			health: {
				kind: { type: "local" },
				hostname: "test-machine",
				version: "0.0.0-test",
			},
			client: null,
			agentSessionCount: null,
			lastPingMs: null,
			lastError: "ping: simulated ping failure",
		});

		renderPanel();

		expect(
			await screen.findByTestId("diagnostics-ping-failed"),
		).toBeInTheDocument();
		// lastError surfaces as a warn notice.
		expect(screen.getByText(/simulated ping failure/)).toBeInTheDocument();
	});

	it("connection diagnostics: shows disconnected state chip when the runtime is offline", async () => {
		apiMocks.getRemoteRuntimeDiagnostics.mockResolvedValue({
			name: "dev.box",
			state: { type: "disconnected", reason: "ssh: connection refused" },
			health: null,
			client: null,
			agentSessionCount: null,
			lastPingMs: null,
			lastError: "ping: peer closed",
		});

		renderPanel();

		const chip = await screen.findByTestId("diagnostics-state-chip");
		expect(chip.textContent).toMatch(/Disconnected/);
		expect(chip.textContent).toMatch(/connection refused/);
	});

	it("connection diagnostics: surfaces the closed_reason when the pipe went away", async () => {
		// The client snapshot can carry a closedReason even when
		// the registry still thinks the entry is connected — e.g.
		// the reader thread tore down mid-call. The panel must
		// render it in red so the operator sees the failure.
		apiMocks.getRemoteRuntimeDiagnostics.mockResolvedValue({
			name: "dev.box",
			state: { type: "connected" },
			health: null,
			client: {
				peerLabel: "ssh:dev.box",
				serverVersion: "0.22.1",
				serverHostname: "dev.box",
				protocolVersion: "0.1.0",
				connectedAtMs: Date.now() - 60_000,
				closedReason: "reader error: peer closed connection",
				requestsSent: 5,
				responsesReceived: 4,
				notificationsReceived: 1,
				decodeErrors: 0,
			},
			agentSessionCount: null,
			lastPingMs: null,
			lastError: "ping: connection closed",
		});

		renderPanel();

		const card = await screen.findByTestId("connection-diagnostics-card");
		expect(card.textContent).toMatch(/reader error: peer closed connection/);
	});

	it("connection diagnostics: surfaces RPC failures as a notice instead of blanking the card", async () => {
		apiMocks.getRemoteRuntimeDiagnostics.mockRejectedValue(
			new Error("registry: runtime not found"),
		);
		renderPanel();
		expect(
			await screen.findByText(/registry: runtime not found/),
		).toBeInTheDocument();
	});

	// ── Port forwards section (phase 24k) ───────────────────────────

	it("port forwards: shows hint when no remote runtimes are registered", async () => {
		renderPanel();
		expect(
			await screen.findByText(
				/Register a remote SSH runtime in the Connect form above/i,
			),
		).toBeInTheDocument();
		expect(document.getElementById("rt-pf-runtime")).toBeNull();
	});

	it("port forwards: start fires startRemotePortForward with parsed ports + label", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();

		const localPortInput = (await waitFor(() => {
			const el = document.getElementById("rt-pf-local-port");
			if (!el) throw new Error("local port not mounted");
			return el as HTMLInputElement;
		})) as HTMLInputElement;
		const remotePortInput = document.getElementById(
			"rt-pf-remote-port",
		) as HTMLInputElement;
		const labelInput = document.getElementById(
			"rt-pf-label",
		) as HTMLInputElement;
		await user.type(localPortInput, "5173");
		await user.type(remotePortInput, "3000");
		await user.type(labelInput, "Vite");

		await user.click(screen.getByRole("button", { name: /Start forward/ }));

		await waitFor(() => {
			expect(apiMocks.startRemotePortForward).toHaveBeenCalledWith({
				runtimeName: "dev.box",
				localPort: 5173,
				remotePort: 3000,
				label: "Vite",
			});
		});
		// Success notice surfaces.
		expect(
			await screen.findByText(/Forwarding localhost:5173 → dev.box:3000/),
		).toBeInTheDocument();
	});

	it("port forwards: rejects non-numeric ports locally without firing the RPC", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);

		renderPanel();
		const localPortInput = (await waitFor(() => {
			const el = document.getElementById("rt-pf-local-port");
			if (!el) throw new Error("local port not mounted");
			return el as HTMLInputElement;
		})) as HTMLInputElement;
		const remotePortInput = document.getElementById(
			"rt-pf-remote-port",
		) as HTMLInputElement;
		// type=number inputs strip non-numeric chars but a value
		// of 0 still parses to 0; drive that path.
		await user.type(localPortInput, "0");
		await user.type(remotePortInput, "3000");
		await user.click(screen.getByRole("button", { name: /Start forward/ }));

		expect(
			await screen.findByText(/must each be a number between 1 and 65535/i),
		).toBeInTheDocument();
		expect(apiMocks.startRemotePortForward).not.toHaveBeenCalled();
	});

	it("port forwards: renders active forwards with stop buttons", async () => {
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemotePortForwards.mockResolvedValue([
			{
				runtimeName: "dev.box",
				localPort: 5173,
				remotePort: 3000,
				label: "Vite",
				startedAtMs: Date.now() - 5_000,
			},
			{
				runtimeName: "dev.box",
				localPort: 8080,
				remotePort: 8080,
				label: null,
				startedAtMs: Date.now() - 30_000,
			},
		]);

		renderPanel();

		expect(
			await screen.findByTestId("remote-port-forward-dev.box-5173"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("remote-port-forward-dev.box-8080"),
		).toBeInTheDocument();
		// Label surfaces in the descriptive line.
		const viteRow = screen.getByTestId("remote-port-forward-dev.box-5173");
		expect(viteRow.textContent).toContain("Vite");
		// Forward target renders verbatim.
		expect(viteRow.textContent).toMatch(/localhost:5173 → dev\.box:3000/);
	});

	it("port forwards: Stop button calls stopRemotePortForward + refreshes the list", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemotePortForwards.mockResolvedValue([
			{
				runtimeName: "dev.box",
				localPort: 5173,
				remotePort: 3000,
				label: null,
				startedAtMs: Date.now() - 1_000,
			},
		]);

		renderPanel();
		await screen.findByTestId("remote-port-forward-dev.box-5173");
		await user.click(
			screen.getByRole("button", { name: /Stop forward on localhost:5173/ }),
		);
		await waitFor(() => {
			expect(apiMocks.stopRemotePortForward).toHaveBeenCalledWith({
				runtimeName: "dev.box",
				localPort: 5173,
			});
		});
		expect(
			await screen.findByText(/Stopped forward on localhost:5173/),
		).toBeInTheDocument();
	});

	it("port forwards: surfaces a backend error from startRemotePortForward", async () => {
		const user = userEvent.setup();
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.startRemotePortForward.mockRejectedValueOnce(
			new Error(
				"ssh -O forward failed for `dev.box` (5173->3000): bind: Address already in use",
			),
		);

		renderPanel();
		const localPortInput = (await waitFor(() => {
			const el = document.getElementById("rt-pf-local-port");
			if (!el) throw new Error("local port not mounted");
			return el as HTMLInputElement;
		})) as HTMLInputElement;
		const remotePortInput = document.getElementById(
			"rt-pf-remote-port",
		) as HTMLInputElement;
		await user.type(localPortInput, "5173");
		await user.type(remotePortInput, "3000");
		await user.click(screen.getByRole("button", { name: /Start forward/ }));

		expect(
			await screen.findByText(/Address already in use/),
		).toBeInTheDocument();
	});

	it("port forwards: empty state renders when listRemotePortForwards returns []", async () => {
		const remoteEntry: RuntimeEntry = {
			name: "dev.box",
			isLocal: false,
			state: { type: "connected" },
		};
		apiMocks.listRemoteRuntimes.mockResolvedValue([LOCAL_ENTRY, remoteEntry]);
		apiMocks.getRuntimeHealth.mockResolvedValue(REMOTE_HEALTH);
		apiMocks.listRemotePortForwards.mockResolvedValue([]);

		renderPanel();
		expect(
			await screen.findByText(/No port forwards active on this runtime/i),
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

describe("parseSshUrl", () => {
	it("extracts the hostname from a bare ssh:// URL", () => {
		expect(parseSshUrl("ssh://dev.box")).toEqual({ host: "dev.box" });
	});

	it("preserves the user prefix when present", () => {
		expect(parseSshUrl("ssh://david@dev.box")).toEqual({
			host: "david@dev.box",
		});
	});

	it("returns the port alongside the host when one is encoded", () => {
		expect(parseSshUrl("ssh://david@dev.box:2222")).toEqual({
			host: "david@dev.box",
			port: 2222,
		});
	});

	it("returns null for inputs that aren't ssh URLs", () => {
		// Nothing in here should parse — `parseSshUrl` is the gate that
		// keeps us from accidentally pre-filling the host field with
		// unrelated text the user happened to paste.
		expect(parseSshUrl("")).toBeNull();
		expect(parseSshUrl("dev.box")).toBeNull();
		expect(parseSshUrl("https://example.com")).toBeNull();
		expect(parseSshUrl("not even close")).toBeNull();
	});

	it("rejects ssh:// URLs that have no hostname", () => {
		expect(parseSshUrl("ssh://")).toBeNull();
	});

	it("trims surrounding whitespace before parsing", () => {
		expect(parseSshUrl("   ssh://dev.box   ")).toEqual({ host: "dev.box" });
	});
});

describe("previewSpawnedCommand", () => {
	const defaults = {
		binaryPath: "",
		host: "",
		remoteBinary: "helmor-server",
		argv: [] as string[],
	};

	it("renders the local-binary auto-detect string when no path is set", () => {
		expect(previewSpawnedCommand("local", defaults)).toBe(
			"spawn helmor-server (auto-detect)",
		);
	});

	it("renders the local-binary explicit path when one is supplied", () => {
		expect(
			previewSpawnedCommand("local", {
				...defaults,
				binaryPath: "/usr/local/bin/helmor-server",
			}),
		).toBe("spawn /usr/local/bin/helmor-server");
	});

	it("renders the SSH spawn shape matching OpenSshTransport.build_command", () => {
		const preview = previewSpawnedCommand("ssh", {
			...defaults,
			host: "dev.box",
			remoteBinary: "helmor-server",
		});
		expect(preview).toContain("ssh -o BatchMode=yes dev.box");
		expect(preview).toContain("sh -c");
		expect(preview).toContain("--ensure-daemon");
		expect(preview).toContain("--proxy");
	});

	it("falls back to <host> placeholder when the SSH host field is empty", () => {
		const preview = previewSpawnedCommand("ssh", defaults);
		expect(preview).toContain("<host>");
	});

	it("renders an <empty argv> placeholder when Command mode has no tokens", () => {
		expect(previewSpawnedCommand("command", defaults)).toBe("<empty argv>");
	});

	it("renders the literal Command argv with shell-friendly quoting", () => {
		expect(
			previewSpawnedCommand("command", {
				...defaults,
				argv: ["tsh", "ssh", "dev-box", "helmor-server", "--proxy"],
			}),
		).toBe("tsh ssh dev-box helmor-server --proxy");
	});

	it("quotes Command argv tokens containing whitespace", () => {
		// Cosmetic only — the backend never shell-tokenises argv, so
		// the quoting is just to make the preview visually unambiguous.
		expect(
			previewSpawnedCommand("command", {
				...defaults,
				argv: ["ssh", "user@host with space", "cmd"],
			}),
		).toBe("ssh 'user@host with space' cmd");
	});

	it("escapes single quotes inside a Command argv token", () => {
		expect(
			previewSpawnedCommand("command", {
				...defaults,
				argv: ["echo", "it's fine"],
			}),
		).toBe("echo 'it'\\''s fine'");
	});
});
