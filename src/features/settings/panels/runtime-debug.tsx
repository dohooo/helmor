import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Activity,
	FileText,
	KeyRound,
	Link2,
	Loader2,
	Network,
	Plug,
	Plug2,
	RefreshCw,
	Server,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	abortRemoteAgentSession,
	attachRemoteAgentSession,
	attachRemoteTerminal,
	// reattachRemoteAgentSessionStream + releaseRemoteAgentStream
	// are called indirectly through useReattachAgentStream below;
	// importing the types only keeps the bundle clean.
	clearWorkspaceRuntimeBinding,
	closeRemoteTerminal,
	connectCommandRuntime,
	connectLocalRuntime,
	connectRemoteRuntime,
	disconnectRemoteRuntime,
	getRemoteRuntimeDiagnostics,
	getRuntimeHealth,
	getWorkspaceBranchInfo,
	getWorkspaceChanges,
	getWorkspaceFileTree,
	getWorkspaceStatus,
	listOwnedTerminals,
	listRemoteAgentSessions,
	listRemotePortForwards,
	listRemoteRuntimes,
	listRemoteTerminals,
	listSshHosts,
	listWorkspaceRuntimeBindings,
	openRemoteTerminal,
	type PortForwardEntry,
	type RemoteAgentSession,
	type RemoteTerminalListEntry,
	type RuntimeDiagnostics,
	type RuntimeEntry,
	type RuntimeHealth,
	reconnectRemoteRuntime,
	setRuntimeAgentAuth,
	setWorkspaceRuntimeBinding,
	startRemotePortForward,
	stopRemotePortForward,
	type TerminalEventNotification,
	tailRemoteDaemonLog,
	type WorkspaceBranchInfoResult,
	type WorkspaceChangesResult,
	type WorkspaceFileTreeResult,
	type WorkspaceRuntimeBinding,
	type WorkspaceStatusResult,
	writeRemoteTerminal,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../components/settings-row";
import {
	useChatReattachStream,
	useReattachAgentStream,
} from "./use-reattach-agent-stream";

/// Dev-only debug surface for the remote-runner spike (#453).
///
/// Three sections, top to bottom:
///   1. Connected runtimes — list pulled from `list_remote_runtimes`.
///      Per-runtime health chip pulled lazily from `get_runtime_health`.
///      Disconnect button for non-local entries.
///   2. Connect form — toggle between "local-binary" (skip SSH; spawn
///      bundled helmor-server directly) and "ssh" (full remote path).
///   3. Workspace status probe — pick a runtime + type a workspace
///      path; renders the porcelain projection inline.
///
/// All three sections share the React Query key `["remote-runtimes"]`
/// so a successful connect/disconnect re-renders the list (and the
/// probe's dropdown) without a manual refetch.

export function RuntimeDebugPanel() {
	const runtimesQuery = useQuery({
		queryKey: ["remote-runtimes"],
		queryFn: listRemoteRuntimes,
		// Phase-9 territory adds polling + a `state` field; for now the
		// list is just refreshed on focus and after each mutation.
		refetchOnWindowFocus: true,
	});

	const entries: RuntimeEntry[] = runtimesQuery.data ?? [];

	return (
		<div className="flex flex-col gap-6">
			<RuntimeListSection
				entries={entries}
				loading={runtimesQuery.isLoading}
				error={runtimesQuery.error}
			/>
			<ConnectSection />
			<ConnectionDiagnosticsSection entries={entries} />
			<WorkspaceStatusProbeSection entries={entries} />
			<WorkspaceInspectorProbeSection entries={entries} />
			<WorkspaceBindingsSection entries={entries} />
			<SetAgentAuthSection entries={entries} />
			<RemoteAgentSessionsSection entries={entries} />
			<DaemonLogSection entries={entries} />
			<RemotePortForwardSection entries={entries} />
			<RemoteTerminalSection entries={entries} />
		</div>
	);
}

// ── 1. Connected runtimes ────────────────────────────────────────────

function RuntimeListSection({
	entries,
	loading,
	error,
}: {
	entries: RuntimeEntry[];
	loading: boolean;
	error: unknown;
}) {
	return (
		<section>
			<SectionHeader
				icon={<Server className="size-3.5" strokeWidth={1.8} />}
				title="Connected runtimes"
				description="Each entry is a target the desktop can route `get_workspace_status` and future runtime-bound commands at. `local` is the always-on in-process runtime."
			/>
			{loading ? (
				<SettingsNotice tone="info">
					<Loader2 className="mr-1.5 inline size-3 animate-spin" />
					Loading runtimes…
				</SettingsNotice>
			) : error ? (
				<SettingsNotice tone="error">
					Failed to list runtimes: {errorMessage(error)}
				</SettingsNotice>
			) : (
				<SettingsGroup>
					{entries.map((entry) => (
						<RuntimeRow key={entry.name} entry={entry} />
					))}
				</SettingsGroup>
			)}
		</section>
	);
}

function RuntimeRow({ entry }: { entry: RuntimeEntry }) {
	// Health snapshot is fetched lazily for the description line (it
	// surfaces hostname + version). The chip color, though, is driven
	// entirely by `entry.state` — that's the liveness loop's authority,
	// and it survives a transient health-probe failure without flipping
	// red.
	const healthQuery = useQuery({
		queryKey: ["remote-runtimes", entry.name, "health"],
		queryFn: () => getRuntimeHealth(entry.name),
		refetchOnWindowFocus: true,
	});

	const queryClient = useQueryClient();
	const disconnect = useMutation({
		mutationFn: () => disconnectRemoteRuntime(entry.name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		},
	});
	const reconnect = useMutation({
		mutationFn: () => reconnectRemoteRuntime(entry.name),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
		},
	});

	// Surface the Reconnect button for both Disconnected (a tombstone
	// from boot-time restore failure, or a runtime that's given up
	// after sustained outage) AND Degraded (the chip is amber and the
	// user might want to force a fresh handshake instead of waiting
	// for the next tick). For a healthy Connected entry the only
	// affordance is Disconnect.
	const canReconnect =
		entry.state.type === "disconnected" || entry.state.type === "degraded";

	return (
		<SettingsRow
			align="start"
			title={
				<span className="flex items-center gap-1.5 font-mono">
					<span>{entry.name}</span>
					<StateChip entry={entry} />
					<TransportChip entry={entry} />
				</span>
			}
			description={
				<HealthDescription
					entry={entry}
					health={healthQuery.data}
					error={healthQuery.error}
				/>
			}
		>
			{entry.isLocal ? null : (
				<div className="flex items-center gap-2">
					{canReconnect ? (
						<Button
							variant="default"
							size="sm"
							disabled={reconnect.isPending}
							onClick={() => reconnect.mutate()}
						>
							{reconnect.isPending ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Reconnecting…
								</>
							) : (
								<>
									<RefreshCw className="mr-1.5 size-3.5" />
									Reconnect
								</>
							)}
						</Button>
					) : null}
					<Button
						variant="outline"
						size="sm"
						disabled={disconnect.isPending}
						onClick={() => disconnect.mutate()}
					>
						{disconnect.isPending ? (
							<>
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
								Disconnecting…
							</>
						) : (
							<>
								<X className="mr-1.5 size-3.5" />
								Disconnect
							</>
						)}
					</Button>
				</div>
			)}
		</SettingsRow>
	);
}

function StateChip({ entry }: { entry: RuntimeEntry }) {
	const { tone, label, title } = stateChipPresentation(entry);
	const toneClass = {
		ok: "border-green-600/40 bg-green-600/10 text-green-300",
		warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
		error: "border-destructive/40 bg-destructive/10 text-destructive",
	}[tone];
	return (
		<span
			title={title}
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
				toneClass,
			)}
		>
			{label}
		</span>
	);
}

/**
 * Compact "flavour" chip next to the state chip — at-a-glance tells
 * the operator whether the entry uses SSH, a custom command, or the
 * bundled local-binary path. The state chip already encodes
 * connected/degraded/disconnected; this one separates that axis from
 * "which transport does it run through" so a degraded *command*
 * transport doesn't visually blend in with a degraded SSH one.
 */
function TransportChip({ entry }: { entry: RuntimeEntry }) {
	const { label, title } = transportChipPresentation(entry);
	if (!label) return null;
	return (
		<span
			title={title}
			className="inline-flex items-center rounded-full border border-border/40 bg-muted/40 px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase text-muted-foreground"
		>
			{label}
		</span>
	);
}

function transportChipPresentation(entry: RuntimeEntry): {
	label: string | null;
	title: string | undefined;
} {
	if (entry.isLocal) {
		// Built-in local runtime — no separate transport to label.
		return { label: null, title: undefined };
	}
	const config = entry.config;
	if (!config) {
		// Registered via the registry API directly (tests / ad-hoc
		// tools); no config = no transport to label.
		return { label: null, title: undefined };
	}
	switch (config.type) {
		case "local":
			return { label: "local", title: describeConfig(config) };
		case "ssh":
			return { label: "ssh", title: describeConfig(config) };
		case "command":
			return { label: "cmd", title: describeConfig(config) };
	}
}

function stateChipPresentation(entry: RuntimeEntry): {
	tone: "ok" | "warn" | "error";
	label: string;
	title: string | undefined;
} {
	if (entry.isLocal) {
		return { tone: "ok", label: "local", title: undefined };
	}
	const configLine = describeConfig(entry.config);
	switch (entry.state.type) {
		case "connected":
			return { tone: "ok", label: "connected", title: configLine };
		case "degraded":
			return {
				tone: "warn",
				label: "degraded",
				title: joinTooltipLines(entry.state.reason, configLine),
			};
		case "disconnected":
			return {
				tone: "error",
				label: "disconnected",
				title: joinTooltipLines(entry.state.reason, configLine),
			};
	}
}

/**
 * Build a multi-line tooltip body from the failure reason (if any)
 * and the connection-config description. Returns `undefined` when
 * both are empty so the chip's `title` attribute is fully omitted.
 */
function joinTooltipLines(
	primary: string | undefined,
	secondary: string | undefined,
): string | undefined {
	const lines = [primary, secondary].filter((line): line is string =>
		Boolean(line && line.length > 0),
	);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function describeConfig(config: RuntimeEntry["config"]): string | undefined {
	if (!config) return undefined;
	switch (config.type) {
		case "local":
			return config.binaryPath
				? `local: ${config.binaryPath}`
				: "local: auto-detect";
		case "ssh":
			return `ssh: ${config.host} ${config.remoteBinary}`;
		case "command":
			return `cmd: ${config.argv.join(" ")}`;
	}
}

/**
 * Tokenise a free-form argv string the user typed into the connect
 * form. Supports two flavours so muscle-memory `tsh ssh host bin
 * --proxy` works AND tokens with embedded whitespace stay representable:
 *
 * - Multi-line input → one token per non-empty line.
 * - Single-line input → split on any whitespace run.
 *
 * Both flavours trim, and drop empty tokens. The backend rejects an
 * empty argv with a clear error, but we filter here so a stray space
 * at the end of the input doesn't trip that check.
 */
export function parseArgvInput(raw: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.includes("\n")) {
		return trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	}
	return trimmed.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * Parse an `ssh://[user@]host[:port]` URL into the bits the connect
 * form needs. Returns `null` for any input that isn't a valid
 * `ssh:` URL. The port is dropped from the host field because the
 * `ssh` CLI takes ports via the `-p` flag, not embedded in the
 * argument — the caller can surface it as a hint if they want.
 *
 * Used by the "Paste ssh:// URL" field as a one-shot pre-fill helper.
 * We intentionally do NOT register `ssh://` as an OS-level deep-link
 * scheme: that would intercept clicks meant for other tools (system
 * SSH agents, browser ssh-handler shims), and the paste path covers
 * the common "I got a URL in chat, can I open it in Helmor?" use
 * case without the global side effect.
 */
export function parseSshUrl(
	raw: string,
): { host: string; port?: number } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!trimmed.startsWith("ssh:") && !trimmed.startsWith("ssh://")) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (url.protocol !== "ssh:") return null;
	if (!url.hostname) return null;
	const host = url.username ? `${url.username}@${url.hostname}` : url.hostname;
	const port = url.port ? Number.parseInt(url.port, 10) : undefined;
	return port !== undefined && !Number.isNaN(port) ? { host, port } : { host };
}

/**
 * Render the literal command shape Helmor will spawn for a given
 * connect-form state. Used by the live preview chip so the operator
 * can verify they typed the right thing *before* hitting Connect.
 *
 * The SSH preview intentionally omits the runtime-dependent
 * ControlMaster / ControlPath flags — they're added at spawn time
 * based on whether the data dir is writable. Showing them in the
 * preview would either leak the data-dir path into the UI or
 * misrepresent what runs in environments where the data dir is
 * read-only. The preview's job is "did the user type the right
 * host/binary/argv", not "render the literal final argv".
 */
export function previewSpawnedCommand(
	mode: ConnectMode,
	args: {
		binaryPath: string;
		host: string;
		remoteBinary: string;
		argv: string[];
	},
): string {
	switch (mode) {
		case "local": {
			const path = args.binaryPath.trim();
			return path ? `spawn ${path}` : "spawn helmor-server (auto-detect)";
		}
		case "ssh": {
			const host = args.host.trim() || "<host>";
			const bin = args.remoteBinary.trim() || "helmor-server";
			// Mirror what `OpenSshTransport::build_command` produces,
			// minus the mux flags (added at runtime).
			return `ssh -o BatchMode=yes ${host} sh -c '${bin} --ensure-daemon && exec ${bin} --proxy'`;
		}
		case "command":
			return args.argv.length === 0
				? "<empty argv>"
				: args.argv.map((token) => quoteForPreview(token)).join(" ");
	}
}

function quoteForPreview(token: string): string {
	// Shell-style quoting just for visual clarity in the preview —
	// the backend never shell-tokenises argv (it goes straight to
	// `Command`), so this is purely cosmetic.
	if (token.length === 0) return "''";
	if (/^[A-Za-z0-9._\-/:@+=,]+$/.test(token)) return token;
	return `'${token.replace(/'/g, "'\\''")}'`;
}

function HealthDescription({
	entry,
	health,
	error,
}: {
	entry: RuntimeEntry;
	health: RuntimeHealth | undefined;
	error: unknown;
}) {
	if (error) {
		return <SettingsNotice tone="error">{errorMessage(error)}</SettingsNotice>;
	}
	if (!health) {
		return entry.isLocal
			? "Built-in. Always reachable."
			: "Connected; awaiting health probe…";
	}
	return (
		<span className="font-mono text-[11px]">
			hostname={health.hostname} · version={health.version}
		</span>
	);
}

// ── 2. Connect form ──────────────────────────────────────────────────

type ConnectMode = "local" | "ssh" | "command";

function ConnectSection() {
	const [mode, setMode] = useState<ConnectMode>("local");
	const [name, setName] = useState("");
	const [binaryPath, setBinaryPath] = useState("");
	const [host, setHost] = useState("");
	const [remoteBinary, setRemoteBinary] = useState("helmor-server");
	// `argv` input is free-form; the parser handles both space- and
	// line-separated flavours. We keep the raw text in state so the
	// preview can render the parsed argv next to it.
	const [argvInput, setArgvInput] = useState("");
	const parsedArgv = useMemo(() => parseArgvInput(argvInput), [argvInput]);
	// Hint surfaced briefly under the SSH host field after a successful
	// `ssh://` paste; lets the operator know the URL parsed + which
	// port was discarded (ssh CLI takes ports via -p, not embedded).
	const [sshUrlHint, setSshUrlHint] = useState<string | null>(null);

	const spawnPreview = useMemo(
		() =>
			previewSpawnedCommand(mode, {
				binaryPath,
				host,
				remoteBinary,
				argv: parsedArgv,
			}),
		[mode, binaryPath, host, remoteBinary, parsedArgv],
	);

	// SSH hostname suggestions sourced from `~/.ssh/config`. Loaded
	// lazily on mount because the file rarely changes mid-session and
	// the parse is cheap; cached by React Query so the dropdown stays
	// responsive between mode toggles.
	const sshHostsQuery = useQuery({
		queryKey: ["ssh-hosts"],
		queryFn: listSshHosts,
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const sshHosts: string[] = sshHostsQuery.data ?? [];

	const queryClient = useQueryClient();
	const connect = useMutation({
		mutationFn: async () => {
			if (!name.trim()) {
				throw new Error("name must not be empty");
			}
			if (mode === "local") {
				return connectLocalRuntime(name, binaryPath.trim() || undefined);
			}
			if (mode === "command") {
				if (parsedArgv.length === 0) {
					throw new Error("argv must not be empty");
				}
				return connectCommandRuntime(name, parsedArgv);
			}
			if (!host.trim()) {
				throw new Error("host must not be empty");
			}
			return connectRemoteRuntime(name, host, remoteBinary);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["remote-runtimes"] });
			// Clear the inputs the user just submitted; keep the mode so
			// they can register a sibling without re-picking it.
			setName("");
			setBinaryPath("");
			setHost("");
			setArgvInput("");
		},
	});

	return (
		<section>
			<SectionHeader
				icon={<Plug2 className="size-3.5" strokeWidth={1.8} />}
				title="Connect a runtime"
				description="`Local binary` spawns the bundled helmor-server directly (handy for smoke testing). `SSH` runs `ssh <host>` and auto-installs the remote binary on first connect. `Command` runs an arbitrary argv (Teleport, Tailscale SSH, kubectl exec, etc.); the remote binary must already be installed."
			/>
			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				<ToggleGroup
					type="single"
					value={mode}
					onValueChange={(next) => next && setMode(next as ConnectMode)}
					className="self-start"
				>
					<ToggleGroupItem value="local" aria-label="Local binary">
						Local binary
					</ToggleGroupItem>
					<ToggleGroupItem value="ssh" aria-label="SSH">
						SSH
					</ToggleGroupItem>
					<ToggleGroupItem value="command" aria-label="Command">
						Command
					</ToggleGroupItem>
				</ToggleGroup>

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
					<Label htmlFor="runtime-name" className="text-xs">
						Name
					</Label>
					<Input
						id="runtime-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="dev-stage"
					/>

					{mode === "local" ? (
						<>
							<Label htmlFor="runtime-binary" className="text-xs">
								Binary path
							</Label>
							<Input
								id="runtime-binary"
								value={binaryPath}
								onChange={(e) => setBinaryPath(e.target.value)}
								placeholder="(auto-detect via HELMOR_SERVER_PATH or exe dir)"
							/>
						</>
					) : mode === "ssh" ? (
						<>
							<Label htmlFor="runtime-ssh-url" className="text-xs">
								Paste ssh:// URL
							</Label>
							<div className="flex flex-col gap-1">
								<Input
									id="runtime-ssh-url"
									placeholder="ssh://david@dev.box"
									onChange={(e) => {
										const parsed = parseSshUrl(e.target.value);
										if (!parsed) {
											setSshUrlHint(null);
											return;
										}
										setHost(parsed.host);
										// Surface a hint when we silently
										// dropped a port — the user might
										// have copied a URL that encodes
										// one and the ssh CLI doesn't take
										// it in this form.
										if (parsed.port !== undefined) {
											setSshUrlHint(
												`Imported ${parsed.host}; port ${parsed.port} dropped (set Port in ~/.ssh/config or use Command mode for non-default ports).`,
											);
										} else {
											setSshUrlHint(`Imported ${parsed.host}.`);
										}
									}}
								/>
								{sshUrlHint ? (
									<span
										className="text-[11px] text-muted-foreground"
										aria-label="SSH URL parse hint"
									>
										{sshUrlHint}
									</span>
								) : (
									<span className="text-[11px] text-muted-foreground">
										Optional shortcut — fills the Host field from a shared URL.
									</span>
								)}
							</div>
							<Label htmlFor="runtime-host" className="text-xs">
								Host
							</Label>
							<div className="flex flex-col gap-1">
								<Input
									id="runtime-host"
									value={host}
									onChange={(e) => setHost(e.target.value)}
									placeholder="dev.box"
									list="ssh-host-suggestions"
								/>
								<datalist id="ssh-host-suggestions">
									{sshHosts.map((h) => (
										<option key={h} value={h} />
									))}
								</datalist>
								{sshHosts.length > 0 ? (
									<span className="text-[11px] text-muted-foreground">
										{sshHosts.length} alias
										{sshHosts.length === 1 ? "" : "es"} from{" "}
										<code className="rounded bg-muted px-1 py-px text-[10px]">
											~/.ssh/config
										</code>
									</span>
								) : null}
							</div>
							<Label htmlFor="runtime-remote-binary" className="text-xs">
								Remote binary
							</Label>
							<Input
								id="runtime-remote-binary"
								value={remoteBinary}
								onChange={(e) => setRemoteBinary(e.target.value)}
								placeholder="helmor-server"
							/>
						</>
					) : (
						<>
							<Label htmlFor="runtime-argv" className="text-xs">
								Command argv
							</Label>
							<div className="flex flex-col gap-1">
								<textarea
									id="runtime-argv"
									value={argvInput}
									onChange={(e) => setArgvInput(e.target.value)}
									placeholder={
										"tsh ssh dev-box helmor-server --proxy\n" +
										"(or one token per line — handy for args containing whitespace)"
									}
									rows={3}
									className={cn(
										"flex w-full rounded-md border border-input bg-transparent px-3 py-2",
										"font-mono text-[11px] shadow-sm transition-colors",
										"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
									)}
								/>
								<span
									className="text-[11px] text-muted-foreground"
									aria-label="Parsed argv preview"
								>
									Parsed:{" "}
									{parsedArgv.length === 0
										? "(empty)"
										: parsedArgv.map((t) => JSON.stringify(t)).join(" ")}
								</span>
							</div>
						</>
					)}
				</div>

				<div
					className="flex flex-col gap-1 rounded-md border border-border/30 bg-muted/30 px-3 py-2"
					aria-label="Spawned command preview"
				>
					<span className="text-[10px] uppercase tracking-wide text-muted-foreground">
						Will run
					</span>
					<code className="break-all font-mono text-[11px] text-app-foreground">
						{spawnPreview}
					</code>
					{mode === "ssh" ? (
						<span className="text-[10px] text-muted-foreground">
							ControlMaster flags appended automatically when the data dir is
							writable.
						</span>
					) : null}
				</div>

				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0 flex-1">
						{connect.isError ? (
							<SettingsNotice tone="error">
								{errorMessage(connect.error)}
							</SettingsNotice>
						) : connect.isSuccess ? (
							<SettingsNotice tone="ok">
								Connected — hostname={connect.data?.hostname}
							</SettingsNotice>
						) : null}
					</div>
					<Button
						variant="default"
						size="sm"
						disabled={connect.isPending}
						onClick={() => connect.mutate()}
					>
						{connect.isPending ? (
							<>
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
								Connecting…
							</>
						) : (
							<>
								<Plug className="mr-1.5 size-3.5" />
								Connect
							</>
						)}
					</Button>
				</div>
			</div>
		</section>
	);
}

// ── 3. Workspace status probe ────────────────────────────────────────

/// Special sentinel used by the runtime dropdown when the user wants
/// the backend to resolve the runtime via the workspace binding
/// store instead of an explicit pick. Maps to `runtimeName=undefined`
/// in the IPC call so the resolver consults the binding.
const RUNTIME_AUTO_VALUE = "__auto__";

function ConnectionDiagnosticsSection({
	entries,
}: {
	entries: RuntimeEntry[];
}) {
	// Default to the first non-local entry; fall back to "local"
	// when nothing is registered yet so the empty-state still
	// renders a usable panel rather than a blank picker.
	const remotes = useMemo(() => entries.filter((e) => !e.isLocal), [entries]);
	// Default the dropdown to the first remote when one exists; fall
	// back to `"local"` so the panel still has something to probe.
	// The runtime registry exposes a `local` entry even when no
	// SSH connections are configured.
	const [runtimeName, setRuntimeName] = useState<string>("local");

	useEffect(() => {
		// On mount the panel may have populated `local` before the
		// remotes list resolved. Once we know of remotes, prefer
		// the first remote since that's the runtime an operator is
		// most likely debugging.
		if (runtimeName === "local" && remotes[0]) {
			setRuntimeName(remotes[0].name);
			return;
		}
		// A previously-selected remote vanished (disconnect, rename)
		// — reset to the first available remote, or fall back to
		// local. Either way the picker stays valid.
		if (
			runtimeName !== "local" &&
			!remotes.some((e) => e.name === runtimeName)
		) {
			setRuntimeName(remotes[0]?.name ?? "local");
		}
	}, [remotes, runtimeName]);

	const diagnosticsQuery = useQuery({
		queryKey: ["remote-runtime-diagnostics", runtimeName],
		queryFn: () => getRemoteRuntimeDiagnostics(runtimeName),
		enabled: runtimeName.length > 0,
		// Diagnostics are point-in-time; the operator hits Refresh
		// or refocuses the window when they want a fresh sample.
		// Auto-polling here would pile up extra ping RTTs the
		// liveness loop already covers.
		refetchOnWindowFocus: false,
		staleTime: 10_000,
	});

	return (
		<section>
			<SectionHeader
				icon={<Activity className="size-3.5" strokeWidth={1.8} />}
				title="Connection diagnostics"
				description="Pipe telemetry for a connected runtime: protocol handshake values, RPC I/O counters, agent-session count, fresh ping RTT, and the close reason (if the connection went away). The operator's `is my remote OK?` panel."
			/>

			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				{remotes.length === 0 ? (
					<SettingsNotice tone="info">
						No remote runtimes connected yet — diagnostics appear here once you
						connect one in the form above. The local runtime is always
						available; pick it from the dropdown to probe it.
					</SettingsNotice>
				) : null}

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)_auto] sm:items-center">
					<Label htmlFor="rt-diag-runtime" className="text-xs">
						Runtime
					</Label>
					<select
						id="rt-diag-runtime"
						className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
						value={runtimeName}
						onChange={(e) => setRuntimeName(e.currentTarget.value)}
					>
						<option value="local">local</option>
						{remotes.map((entry) => (
							<option key={entry.name} value={entry.name}>
								{entry.name}
							</option>
						))}
					</select>
					<Button
						variant="ghost"
						size="sm"
						disabled={!runtimeName || diagnosticsQuery.isFetching}
						onClick={() => void diagnosticsQuery.refetch()}
						aria-label="Refresh connection diagnostics"
					>
						{diagnosticsQuery.isFetching ? (
							<>
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
								Refreshing…
							</>
						) : (
							<>
								<RefreshCw className="mr-1.5 size-3.5" />
								Refresh
							</>
						)}
					</Button>
				</div>

				{diagnosticsQuery.error ? (
					<SettingsNotice tone="error">
						{errorMessage(diagnosticsQuery.error)}
					</SettingsNotice>
				) : diagnosticsQuery.isLoading ? (
					<span className="text-[11px] text-muted-foreground">
						Probing diagnostics…
					</span>
				) : diagnosticsQuery.data ? (
					<DiagnosticsCard diag={diagnosticsQuery.data} />
				) : null}
			</div>
		</section>
	);
}

function DiagnosticsCard({ diag }: { diag: RuntimeDiagnostics }) {
	const uptimeMs = diag.client ? Date.now() - diag.client.connectedAtMs : null;
	const stateLabel =
		diag.state.type === "connected"
			? "Connected"
			: diag.state.type === "degraded"
				? `Degraded — ${diag.state.reason}`
				: `Disconnected — ${diag.state.reason}`;
	const stateTone =
		diag.state.type === "connected"
			? "ok"
			: diag.state.type === "degraded"
				? "warn"
				: "error";

	return (
		<div
			className="flex flex-col gap-2 rounded-md border border-border/30 bg-background/40 p-3"
			data-testid="connection-diagnostics-card"
		>
			<div className="flex items-center gap-2">
				<span
					className={cn(
						"inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase",
						stateTone === "ok" &&
							"border-green-600/40 bg-green-600/10 text-green-300",
						stateTone === "warn" &&
							"border-amber-500/40 bg-amber-500/10 text-amber-300",
						stateTone === "error" &&
							"border-rose-500/40 bg-rose-500/10 text-rose-300",
					)}
					data-testid="diagnostics-state-chip"
				>
					{stateLabel}
				</span>
				{typeof diag.lastPingMs === "number" ? (
					<span
						className="text-[11px] text-muted-foreground"
						data-testid="diagnostics-ping-ms"
					>
						ping {diag.lastPingMs}ms
					</span>
				) : (
					<span
						className="text-[11px] text-destructive"
						data-testid="diagnostics-ping-failed"
					>
						ping failed
					</span>
				)}
			</div>

			{diag.lastError ? (
				<SettingsNotice tone="warn">{diag.lastError}</SettingsNotice>
			) : null}

			<dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-[160px_minmax(0,1fr)]">
				<dt className="text-muted-foreground">Server</dt>
				<dd className="truncate font-mono">
					{diag.health
						? `${diag.health.hostname} · ${diag.health.version}`
						: "—"}
				</dd>

				<dt className="text-muted-foreground">Peer</dt>
				<dd className="truncate font-mono">{diag.client?.peerLabel ?? "—"}</dd>

				<dt className="text-muted-foreground">Protocol</dt>
				<dd className="truncate font-mono">
					{diag.client?.protocolVersion ?? "—"}
				</dd>

				<dt className="text-muted-foreground">Connected</dt>
				<dd className="truncate font-mono">
					{uptimeMs !== null && uptimeMs >= 0
						? `${formatDuration(uptimeMs)} ago`
						: "—"}
				</dd>

				<dt className="text-muted-foreground">Requests / responses</dt>
				<dd className="truncate font-mono">
					{diag.client
						? `${diag.client.requestsSent} / ${diag.client.responsesReceived}`
						: "—"}
				</dd>

				<dt className="text-muted-foreground">Notifications</dt>
				<dd className="truncate font-mono">
					{diag.client?.notificationsReceived ?? "—"}
				</dd>

				<dt className="text-muted-foreground">Decode errors</dt>
				<dd
					className={cn(
						"truncate font-mono",
						diag.client && diag.client.decodeErrors > 0 && "text-destructive",
					)}
				>
					{diag.client?.decodeErrors ?? "—"}
				</dd>

				<dt className="text-muted-foreground">Agent sessions</dt>
				<dd className="truncate font-mono">
					{typeof diag.agentSessionCount === "number"
						? diag.agentSessionCount
						: "—"}
				</dd>

				{diag.client?.closedReason ? (
					<>
						<dt className="text-muted-foreground">Closed</dt>
						<dd className="truncate font-mono text-destructive">
							{diag.client.closedReason}
						</dd>
					</>
				) : null}
			</dl>
		</div>
	);
}

/// Render `ms` as "Xs ago" / "Xm Ys ago" / "Xh Ym ago" depending
/// on magnitude. Matches the formatting the workspace activity
/// chips already use so the panel feels consistent.
function formatDuration(ms: number): string {
	if (ms < 0) return "just now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) {
		const remSec = sec % 60;
		return `${min}m ${remSec}s`;
	}
	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return `${hr}h ${remMin}m`;
}

function WorkspaceStatusProbeSection({ entries }: { entries: RuntimeEntry[] }) {
	const [workspaceDir, setWorkspaceDir] = useState("");
	const [workspaceId, setWorkspaceId] = useState("");
	const [runtimeName, setRuntimeName] = useState<string>(RUNTIME_AUTO_VALUE);

	// Keep the selected runtime valid: if it disappears from the list
	// (e.g. user disconnects), fall back to the auto/binding option.
	useEffect(() => {
		if (
			runtimeName !== RUNTIME_AUTO_VALUE &&
			!entries.some((e) => e.name === runtimeName)
		) {
			setRuntimeName(RUNTIME_AUTO_VALUE);
		}
	}, [entries, runtimeName]);

	const probe = useMutation({
		mutationFn: () =>
			getWorkspaceStatus(workspaceDir, {
				workspaceId: workspaceId.trim() || undefined,
				runtimeName:
					runtimeName === RUNTIME_AUTO_VALUE ? undefined : runtimeName,
			}),
	});

	const branchInfoProbe = useMutation({
		mutationFn: () =>
			getWorkspaceBranchInfo(workspaceDir, {
				workspaceId: workspaceId.trim() || undefined,
				runtimeName:
					runtimeName === RUNTIME_AUTO_VALUE ? undefined : runtimeName,
			}),
	});

	const runtimeOptions = useMemo(
		() => entries.map((e) => ({ value: e.name, label: e.name })),
		[entries],
	);

	return (
		<section>
			<SectionHeader
				icon={<Server className="size-3.5" strokeWidth={1.8} />}
				title="Workspace status probe"
				description="Round-trips `workspace.status` through the resolved runtime. Path is interpreted on the runtime's own filesystem. Pick `Auto (via binding)` to exercise the workspace-id → runtime lookup."
			/>
			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
					<Label htmlFor="probe-runtime" className="text-xs">
						Runtime
					</Label>
					<select
						id="probe-runtime"
						value={runtimeName}
						onChange={(e) => setRuntimeName(e.target.value)}
						className={cn(
							"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
							"text-sm shadow-sm transition-colors",
							"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						)}
					>
						<option value={RUNTIME_AUTO_VALUE}>
							Auto (via workspace binding)
						</option>
						{runtimeOptions.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>

					<Label htmlFor="probe-workspace-id" className="text-xs">
						Workspace ID
					</Label>
					<Input
						id="probe-workspace-id"
						value={workspaceId}
						onChange={(e) => setWorkspaceId(e.target.value)}
						placeholder="ws-1234 (optional; only used by Auto)"
					/>

					<Label htmlFor="probe-workspace" className="text-xs">
						Workspace dir
					</Label>
					<Input
						id="probe-workspace"
						value={workspaceDir}
						onChange={(e) => setWorkspaceDir(e.target.value)}
						placeholder="/Users/you/code/some-repo"
					/>
				</div>

				<div className="flex flex-col gap-3">
					<div className="min-w-0 flex-1">
						<ProbeResult
							loading={probe.isPending}
							error={probe.error}
							result={probe.data}
						/>
						<BranchInfoResultView
							loading={branchInfoProbe.isPending}
							error={branchInfoProbe.error}
							result={branchInfoProbe.data}
						/>
					</div>
					<div className="flex items-center justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={branchInfoProbe.isPending || !workspaceDir.trim()}
							onClick={() => branchInfoProbe.mutate()}
						>
							{branchInfoProbe.isPending ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Probing branch…
								</>
							) : (
								"Run branch info"
							)}
						</Button>
						<Button
							variant="default"
							size="sm"
							disabled={probe.isPending || !workspaceDir.trim()}
							onClick={() => probe.mutate()}
						>
							{probe.isPending ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Probing…
								</>
							) : (
								"Run probe"
							)}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}

function BranchInfoResultView({
	loading,
	error,
	result,
}: {
	loading: boolean;
	error: unknown;
	result: WorkspaceBranchInfoResult | undefined;
}) {
	if (loading) return null;
	if (error) {
		return <SettingsNotice tone="error">{errorMessage(error)}</SettingsNotice>;
	}
	if (!result) return null;
	const branchLabel =
		result.currentBranch.length > 0 ? result.currentBranch : "(detached HEAD)";
	return (
		<SettingsNotice tone="info">
			<div className="font-mono text-[11px]">
				<div>branch: {branchLabel}</div>
				<div>head: {result.headCommit.slice(0, 12)}</div>
				{result.upstreamRef ? (
					<div>upstream: {result.upstreamRef}</div>
				) : (
					<div className="text-muted-foreground">upstream: (none)</div>
				)}
			</div>
		</SettingsNotice>
	);
}

function ProbeResult({
	loading,
	error,
	result,
}: {
	loading: boolean;
	error: unknown;
	result: WorkspaceStatusResult | undefined;
}) {
	if (loading) return null;
	if (error) {
		return <SettingsNotice tone="error">{errorMessage(error)}</SettingsNotice>;
	}
	if (!result) return null;
	if (result.isClean) {
		return <SettingsNotice tone="ok">Clean — no changes.</SettingsNotice>;
	}
	return (
		<SettingsNotice tone="warn">
			{result.changedPaths.length} changed path
			{result.changedPaths.length === 1 ? "" : "s"}:
			<ul className="mt-1 list-disc pl-5 font-mono text-[11px]">
				{result.changedPaths.map((path) => (
					<li key={path}>{path}</li>
				))}
			</ul>
		</SettingsNotice>
	);
}

// ── 3b. Workspace inspector probe (phase 20e) ────────────────────────
//
// Mirrors the `WorkspaceStatusProbeSection` shape but exercises the
// phase 20a-d slice end-to-end: file tree + changes (with and without
// content) routed through `resolve_runtime_for_call`. Lets the
// operator verify the full vertical visually before / after pinning a
// workspace to a remote runtime — the runtime label in the result
// confirms which side actually answered.

function WorkspaceInspectorProbeSection({
	entries,
}: {
	entries: RuntimeEntry[];
}) {
	const [workspaceDir, setWorkspaceDir] = useState("");
	const [workspaceId, setWorkspaceId] = useState("");
	const [runtimeName, setRuntimeName] = useState<string>(RUNTIME_AUTO_VALUE);

	useEffect(() => {
		if (
			runtimeName !== RUNTIME_AUTO_VALUE &&
			!entries.some((e) => e.name === runtimeName)
		) {
			setRuntimeName(RUNTIME_AUTO_VALUE);
		}
	}, [entries, runtimeName]);

	const resolvedRuntimeName =
		runtimeName === RUNTIME_AUTO_VALUE ? undefined : runtimeName;
	const resolvedWorkspaceId = workspaceId.trim() || undefined;

	const fileTreeProbe = useMutation({
		mutationFn: () =>
			getWorkspaceFileTree(
				workspaceDir,
				resolvedWorkspaceId,
				resolvedRuntimeName,
			),
	});
	const changesProbe = useMutation({
		mutationFn: (includeContent: boolean) =>
			getWorkspaceChanges(
				workspaceDir,
				includeContent,
				resolvedWorkspaceId,
				resolvedRuntimeName,
			),
	});

	const runtimeOptions = useMemo(
		() => entries.map((e) => ({ value: e.name, label: e.name })),
		[entries],
	);

	const submitDisabled = !workspaceDir.trim();

	return (
		<section>
			<SectionHeader
				icon={<FileText className="size-3.5" strokeWidth={1.8} />}
				title="Workspace inspector probe"
				description="Round-trips `workspace.fileTree` and `workspace.changes` through the resolved runtime. Same binding precedence as the status probe — pick `Auto (via binding)` to exercise the workspace-id → runtime lookup. Toggle `Include content` to also fetch per-file diff bodies (large response on dirty repos)."
			/>
			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
					<Label htmlFor="inspector-probe-runtime" className="text-xs">
						Runtime
					</Label>
					<select
						id="inspector-probe-runtime"
						value={runtimeName}
						onChange={(e) => setRuntimeName(e.target.value)}
						className={cn(
							"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
							"text-sm shadow-sm transition-colors",
							"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						)}
					>
						<option value={RUNTIME_AUTO_VALUE}>
							Auto (via workspace binding)
						</option>
						{runtimeOptions.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>

					<Label htmlFor="inspector-probe-workspace-id" className="text-xs">
						Workspace ID
					</Label>
					<Input
						id="inspector-probe-workspace-id"
						value={workspaceId}
						onChange={(e) => setWorkspaceId(e.target.value)}
						placeholder="ws-1234 (optional; only used by Auto)"
					/>

					<Label htmlFor="inspector-probe-workspace" className="text-xs">
						Workspace dir
					</Label>
					<Input
						id="inspector-probe-workspace"
						value={workspaceDir}
						onChange={(e) => setWorkspaceDir(e.target.value)}
						placeholder="/Users/you/code/some-repo"
					/>
				</div>

				<div className="flex flex-col gap-3">
					<div className="min-w-0 flex-1">
						<FileTreeProbeResult
							loading={fileTreeProbe.isPending}
							error={fileTreeProbe.error}
							result={fileTreeProbe.data}
						/>
						<ChangesProbeResult
							loading={changesProbe.isPending}
							error={changesProbe.error}
							result={changesProbe.data}
							variables={changesProbe.variables}
						/>
					</div>
					<div className="flex items-center justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							disabled={changesProbe.isPending || submitDisabled}
							onClick={() => changesProbe.mutate(false)}
						>
							{changesProbe.isPending && changesProbe.variables === false ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Probing changes…
								</>
							) : (
								"Run changes"
							)}
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={changesProbe.isPending || submitDisabled}
							onClick={() => changesProbe.mutate(true)}
						>
							{changesProbe.isPending && changesProbe.variables === true ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Probing changes…
								</>
							) : (
								"Run changes (with content)"
							)}
						</Button>
						<Button
							variant="default"
							size="sm"
							disabled={fileTreeProbe.isPending || submitDisabled}
							onClick={() => fileTreeProbe.mutate()}
						>
							{fileTreeProbe.isPending ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Probing file tree…
								</>
							) : (
								"Run file tree"
							)}
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}

function FileTreeProbeResult({
	loading,
	error,
	result,
}: {
	loading: boolean;
	error: unknown;
	result: WorkspaceFileTreeResult | undefined;
}) {
	if (loading) return null;
	if (error) {
		return <SettingsNotice tone="error">{errorMessage(error)}</SettingsNotice>;
	}
	if (!result) return null;
	const total = result.entries.length;
	const preview = result.entries.slice(0, 12);
	if (total === 0) {
		return (
			<SettingsNotice tone="ok">No files surfaced by the walk.</SettingsNotice>
		);
	}
	return (
		<SettingsNotice tone="info">
			<div>
				{total} file{total === 1 ? "" : "s"} (showing first {preview.length})
			</div>
			<ul className="mt-1 list-disc pl-5 font-mono text-[11px]">
				{preview.map((entry) => (
					<li key={entry.absolutePath}>{entry.path}</li>
				))}
			</ul>
		</SettingsNotice>
	);
}

function ChangesProbeResult({
	loading,
	error,
	result,
	variables,
}: {
	loading: boolean;
	error: unknown;
	result: WorkspaceChangesResult | undefined;
	variables: boolean | undefined;
}) {
	if (loading) return null;
	if (error) {
		return <SettingsNotice tone="error">{errorMessage(error)}</SettingsNotice>;
	}
	if (!result) return null;
	const itemCount = result.items.length;
	if (itemCount === 0) {
		return <SettingsNotice tone="ok">Clean — no changes.</SettingsNotice>;
	}
	const includedContent = variables === true;
	return (
		<SettingsNotice tone="warn">
			<div>
				{itemCount} changed path{itemCount === 1 ? "" : "s"}
				{includedContent
					? ` · prefetched ${result.prefetched.length}`
					: " · content omitted"}
			</div>
			<ul className="mt-1 list-disc pl-5 font-mono text-[11px]">
				{result.items.slice(0, 12).map((item) => (
					<li key={item.absolutePath}>
						{item.path} ({item.status})
					</li>
				))}
			</ul>
		</SettingsNotice>
	);
}

// ── 4. Per-workspace runtime bindings ────────────────────────────────

function WorkspaceBindingsSection({ entries }: { entries: RuntimeEntry[] }) {
	const queryClient = useQueryClient();
	const bindingsQuery = useQuery({
		queryKey: ["workspace-runtime-bindings"],
		queryFn: listWorkspaceRuntimeBindings,
		refetchOnWindowFocus: true,
	});
	const bindings: WorkspaceRuntimeBinding[] = bindingsQuery.data ?? [];

	const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
	const [draftRuntimeName, setDraftRuntimeName] = useState<string>("local");

	// Keep the draft runtime selection valid as the registry list
	// shifts under us (e.g. user disconnects the selected entry).
	useEffect(() => {
		if (!entries.some((e) => e.name === draftRuntimeName)) {
			setDraftRuntimeName("local");
		}
	}, [entries, draftRuntimeName]);

	const setBinding = useMutation({
		mutationFn: ({ id, runtime }: { id: string; runtime: string }) =>
			setWorkspaceRuntimeBinding(id, runtime),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["workspace-runtime-bindings"],
			});
			setDraftWorkspaceId("");
		},
	});
	const clearBinding = useMutation({
		mutationFn: (id: string) => clearWorkspaceRuntimeBinding(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: ["workspace-runtime-bindings"],
			});
		},
	});

	const runtimeOptions = useMemo(
		() => entries.map((e) => ({ value: e.name, label: e.name })),
		[entries],
	);

	return (
		<section>
			<SectionHeader
				icon={<Link2 className="size-3.5" strokeWidth={1.8} />}
				title="Workspace bindings"
				description="Pin a workspace to a runtime so future operations route through it. Today no command consumes the binding — this surface stores the pins so a follow-up phase can lift git/scripts/sidecar onto the seam."
			/>

			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				{bindings.length === 0 ? (
					<SettingsNotice tone="info">
						No bindings yet. Pin a workspace below.
					</SettingsNotice>
				) : (
					<SettingsGroup>
						{bindings.map((binding) => (
							<SettingsRow
								key={binding.workspaceId}
								align="start"
								title={
									<span className="flex items-center gap-1.5 font-mono">
										<span>{binding.workspaceId}</span>
										<span className="text-muted-foreground">→</span>
										<span>{binding.runtimeName}</span>
									</span>
								}
								description={
									entries.some((e) => e.name === binding.runtimeName) ? null : (
										<SettingsNotice tone="warn">
											Runtime <code>{binding.runtimeName}</code> isn't currently
											registered. Future ops on this workspace will fall back to{" "}
											<code>local</code> until you reconnect it.
										</SettingsNotice>
									)
								}
							>
								<Button
									variant="outline"
									size="sm"
									disabled={clearBinding.isPending}
									onClick={() => clearBinding.mutate(binding.workspaceId)}
								>
									<X className="mr-1.5 size-3.5" />
									Clear
								</Button>
							</SettingsRow>
						))}
					</SettingsGroup>
				)}

				<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
					<Label htmlFor="binding-workspace" className="text-xs">
						Pin workspace
					</Label>
					<Input
						id="binding-workspace"
						value={draftWorkspaceId}
						onChange={(e) => setDraftWorkspaceId(e.target.value)}
						placeholder="ws-1234"
					/>

					<Label htmlFor="binding-runtime" className="text-xs">
						Runtime
					</Label>
					<select
						id="binding-runtime"
						value={draftRuntimeName}
						onChange={(e) => setDraftRuntimeName(e.target.value)}
						className={cn(
							"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
							"text-sm shadow-sm transition-colors",
							"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						)}
					>
						{runtimeOptions.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</div>

				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0 flex-1">
						{setBinding.isError ? (
							<SettingsNotice tone="error">
								{errorMessage(setBinding.error)}
							</SettingsNotice>
						) : null}
					</div>
					<Button
						variant="default"
						size="sm"
						disabled={setBinding.isPending || !draftWorkspaceId.trim()}
						onClick={() =>
							setBinding.mutate({
								id: draftWorkspaceId.trim(),
								runtime: draftRuntimeName,
							})
						}
					>
						{setBinding.isPending ? (
							<>
								<Loader2 className="mr-1.5 size-3.5 animate-spin" />
								Saving…
							</>
						) : (
							<>
								<Link2 className="mr-1.5 size-3.5" />
								Pin
							</>
						)}
					</Button>
				</div>
			</div>
		</section>
	);
}

// ── 5. Remote terminal ──────────────────────────────────────────────

/// Buffered terminal output capped at a sensible scrollback budget.
/// 200 KB is enough for most demo sessions without holding the
/// inspector inspector hostage on a chatty shell. Older bytes are
/// discarded from the start.
const TERMINAL_OUTPUT_BUDGET = 200_000;

/// Subsection of the remote terminal flow that lists live sessions
/// on the daemon — owned-by-this-desktop ones first, then "other"
/// sessions (anything the daemon knows about that isn't in our
/// sidecar JSON). Click Attach to bind the row's terminal id to
/// the parent's output `<pre>`.
///
/// `runtimeName` is required and assumed non-empty; the parent
/// gates rendering on that. The component refetches on mount and
/// on every Refresh click — no React Query for simplicity, the
/// data is dev-panel-only and a stale list is only ever a click
/// away from accurate.
function ReattachList({
	runtimeName,
	busy,
	onAttach,
}: {
	runtimeName: string;
	busy: boolean;
	onAttach: (entry: RemoteTerminalListEntry) => void;
}) {
	const [terminals, setTerminals] = useState<RemoteTerminalListEntry[] | null>(
		null,
	);
	const [owned, setOwned] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState<boolean>(false);
	const [error, setError] = useState<string | null>(null);

	const refresh = async () => {
		setLoading(true);
		setError(null);
		try {
			const [live, ownedIds] = await Promise.all([
				listRemoteTerminals(runtimeName),
				listOwnedTerminals(runtimeName),
			]);
			setTerminals(live);
			setOwned(new Set(ownedIds));
		} catch (err) {
			setError(errorMessage(err));
			setTerminals(null);
		} finally {
			setLoading(false);
		}
	};

	// Refresh whenever the runtime selection changes — including the
	// initial render of this subsection.
	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [runtimeName]);

	const empty = terminals !== null && terminals.length === 0;

	return (
		<div className="flex flex-col gap-2 rounded-md border border-border/30 bg-background/40 p-3">
			<div className="flex items-center justify-between">
				<span className="text-[12px] font-medium text-foreground">
					Reattach to existing session
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={loading || busy}
					onClick={() => void refresh()}
				>
					{loading ? (
						<>
							<Loader2 className="mr-1.5 size-3.5 animate-spin" />
							Refreshing…
						</>
					) : (
						<>
							<RefreshCw className="mr-1.5 size-3.5" />
							Refresh
						</>
					)}
				</Button>
			</div>
			{error ? (
				<SettingsNotice tone="error">{error}</SettingsNotice>
			) : terminals === null ? (
				<span className="text-[11px] text-muted-foreground">
					Listing remote sessions…
				</span>
			) : empty ? (
				<span className="text-[11px] text-muted-foreground">
					No live sessions on this runtime.
				</span>
			) : (
				<ul className="flex flex-col gap-1">
					{terminals.map((entry) => {
						const isOwned = owned.has(entry.terminalId);
						return (
							<li
								key={entry.terminalId}
								className="flex items-center justify-between gap-2 rounded border border-border/30 bg-card/40 px-2 py-1.5"
							>
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="truncate font-mono text-[11px]">
										{entry.terminalId}
									</span>
									<span className="truncate text-[10px] text-muted-foreground">
										pid={entry.pid} · {entry.workspaceDir} · {entry.cols}×
										{entry.rows}
									</span>
								</div>
								<span
									className={cn(
										"inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase",
										isOwned
											? "border-green-600/40 bg-green-600/10 text-green-300"
											: "border-amber-500/40 bg-amber-500/10 text-amber-300",
									)}
								>
									{isOwned ? "yours" : "other"}
								</span>
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => onAttach(entry)}
								>
									<Plug className="mr-1.5 size-3.5" />
									Attach
								</Button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

// ── Remote agent sessions (phase 24d — reattach UX) ───────────────

function RemoteAgentSessionsSection({ entries }: { entries: RuntimeEntry[] }) {
	const remotes = useMemo(() => entries.filter((e) => !e.isLocal), [entries]);
	const [runtimeName, setRuntimeName] = useState<string>("");
	const [busyId, setBusyId] = useState<string | null>(null);
	const [notice, setNotice] = useState<{
		tone: "info" | "error" | "ok";
		text: string;
	} | null>(null);

	// Keep the runtime selection valid as the registry list shifts —
	// same pattern as SetAgentAuthSection above.
	useEffect(() => {
		if (!runtimeName && remotes[0]) {
			setRuntimeName(remotes[0].name);
			return;
		}
		if (runtimeName && !remotes.some((e) => e.name === runtimeName)) {
			setRuntimeName(remotes[0]?.name ?? "");
		}
	}, [remotes, runtimeName]);

	const sessionsQuery = useQuery({
		queryKey: ["remote-agent-sessions", runtimeName],
		queryFn: () => listRemoteAgentSessions(runtimeName),
		enabled: runtimeName.length > 0,
		refetchOnWindowFocus: false,
	});

	const abortMutation = useMutation({
		mutationFn: async (requestId: string) => {
			await abortRemoteAgentSession(runtimeName, requestId);
		},
		onMutate: (requestId) => setBusyId(requestId),
		onSettled: () => {
			setBusyId(null);
			void sessionsQuery.refetch();
		},
		onSuccess: (_data, requestId) => {
			setNotice({
				tone: "ok",
				text: `Abort sent to ${requestId}. Daemon will tear down the session shortly.`,
			});
		},
		onError: (err) => setNotice({ tone: "error", text: errorMessage(err) }),
	});

	// Phase 24i: replace the one-shot attach probe with a real
	// streaming reattach. `useReattachAgentStream` drives the
	// subscription lifecycle (attach + subscribe + auto-release
	// on unmount) and surfaces events through `stream.events`.
	const stream = useReattachAgentStream();
	// Phase 24l: a parallel chat-cooked stream that runs the
	// daemon's events through the desktop's MessagePipeline +
	// emits the same AgentStreamEvent envelope the chat's
	// useStreaming hook consumes. The panel renders the
	// trailing Update messages as a chat-style preview so the
	// operator sees actual assistant text, not raw JSON.
	const chatStream = useChatReattachStream();

	const handleReattachClick = async (session: RemoteAgentSession) => {
		// Mirror the prior `attachMutation` UX: a notice on the
		// notFound path so the user understands the panel state.
		// Phase 24q-2: pass the session's `helmorSessionId` (when
		// present) so the backend computes `since_seq` from the
		// desktop's local DB high-water-mark, letting the daemon's
		// journal replay close the gap.
		setBusyId(session.requestId);
		await stream.start(
			runtimeName,
			session.requestId,
			session.helmorSessionId ?? undefined,
		);
		setBusyId(null);
		void sessionsQuery.refetch();
	};

	const handleOpenChatPreview = async (session: RemoteAgentSession) => {
		if (!session.helmorSessionId) {
			setNotice({
				tone: "info",
				text: "This session has no Helmor session id — chat preview needs one to route messages.",
			});
			return;
		}
		setBusyId(session.requestId);
		await chatStream.start({
			requestId: session.requestId,
			helmorSessionId: session.helmorSessionId,
			provider: session.provider ?? "claude",
			modelId: session.provider ?? "claude",
			workingDirectory: session.workspaceDir ?? undefined,
		});
		setBusyId(null);
	};

	useEffect(() => {
		if (stream.phase === "notFound" && stream.currentRequestId === null) {
			setNotice({
				tone: "info",
				text: "Session has ended — the daemon no longer tracks it.",
			});
		} else if (stream.phase === "error" && stream.error) {
			setNotice({ tone: "error", text: stream.error });
		} else if (stream.phase === "streaming" && stream.currentRequestId) {
			setNotice({
				tone: "ok",
				text: `Streaming events for ${stream.currentRequestId}. ${stream.events.length} event${stream.events.length === 1 ? "" : "s"} received.`,
			});
		}
	}, [
		stream.phase,
		stream.error,
		stream.currentRequestId,
		stream.events.length,
	]);

	// Sneak the one-shot probe behind a back-compat hook so legacy
	// docs that say "click Reattach to verify the daemon found the
	// session" still apply. The button below uses the streaming
	// path, which is strictly more useful.
	void attachRemoteAgentSession;

	const sessions = sessionsQuery.data ?? [];

	return (
		<section>
			<SectionHeader
				icon={<Plug2 className="size-3.5" strokeWidth={1.8} />}
				title="Remote agent sessions"
				description="Inspect in-flight agent turns on a connected remote runtime. Use Abort to stop an orphaned session; Reattach to pump events back to this desktop's notification subscriber."
			/>

			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				{remotes.length === 0 ? (
					<SettingsNotice tone="info">
						No remote runtimes connected yet — agent sessions appear here once
						you connect one in the form above.
					</SettingsNotice>
				) : (
					<>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)_auto] sm:items-center">
							<Label htmlFor="rt-sessions-runtime" className="text-xs">
								Runtime
							</Label>
							<select
								id="rt-sessions-runtime"
								className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
								value={runtimeName}
								onChange={(e) => setRuntimeName(e.currentTarget.value)}
							>
								{remotes.map((entry) => (
									<option key={entry.name} value={entry.name}>
										{entry.name}
									</option>
								))}
							</select>
							<Button
								variant="ghost"
								size="sm"
								disabled={!runtimeName || sessionsQuery.isFetching}
								onClick={() => void sessionsQuery.refetch()}
								aria-label="Refresh remote agent sessions"
							>
								{sessionsQuery.isFetching ? (
									<>
										<Loader2 className="mr-1.5 size-3.5 animate-spin" />
										Refreshing…
									</>
								) : (
									<>
										<RefreshCw className="mr-1.5 size-3.5" />
										Refresh
									</>
								)}
							</Button>
						</div>

						{notice && (
							<SettingsNotice tone={notice.tone}>{notice.text}</SettingsNotice>
						)}

						{sessionsQuery.error ? (
							<SettingsNotice tone="error">
								{errorMessage(sessionsQuery.error)}
							</SettingsNotice>
						) : sessionsQuery.isLoading ? (
							<span className="text-[11px] text-muted-foreground">
								Listing agent sessions…
							</span>
						) : sessions.length === 0 ? (
							<span className="text-[11px] text-muted-foreground">
								No active agent sessions on this runtime.
							</span>
						) : (
							<ul className="flex flex-col gap-1">
								{sessions.map((session) => {
									const isStreaming =
										stream.phase === "streaming" &&
										stream.currentRequestId === session.requestId;
									const isChatPreviewActive =
										chatStream.currentRequestId === session.requestId;
									const isBusyRow =
										(busyId === session.requestId || abortMutation.isPending) &&
										!isStreaming;
									return (
										<RemoteAgentSessionRow
											key={session.requestId}
											session={session}
											busy={isBusyRow}
											streaming={isStreaming}
											chatPreviewActive={isChatPreviewActive}
											onAbort={() => abortMutation.mutate(session.requestId)}
											onAttach={() => {
												if (isStreaming) {
													void stream.stop();
												} else {
													void handleReattachClick(session);
												}
											}}
											onChatPreview={() => {
												if (isChatPreviewActive) {
													void chatStream.stop();
												} else {
													void handleOpenChatPreview(session);
												}
											}}
										/>
									);
								})}
							</ul>
						)}

						{(stream.phase === "streaming" || stream.events.length > 0) && (
							<ReattachEventLog
								requestId={stream.currentRequestId}
								phase={stream.phase}
								events={stream.events}
								onClear={stream.clear}
							/>
						)}

						{(chatStream.phase === "streaming" ||
							chatStream.messages !== null ||
							chatStream.partial !== null ||
							chatStream.terminalLabel !== null) && (
							<ChatReattachPreview
								requestId={chatStream.currentRequestId}
								phase={chatStream.phase}
								messages={chatStream.messages}
								partial={chatStream.partial}
								terminalLabel={chatStream.terminalLabel}
								error={chatStream.error}
								onClear={chatStream.clear}
							/>
						)}
					</>
				)}
			</div>
		</section>
	);
}

/// Render the live chat-style preview backed by
/// `useChatReattachStream`. The trailing Update event carries
/// `messages` — we display the last few text snippets so the
/// operator sees what the assistant is producing in real time.
function ChatReattachPreview({
	requestId,
	phase,
	messages,
	partial,
	terminalLabel,
	error,
	onClear,
}: {
	requestId: string | null;
	phase: "idle" | "attaching" | "streaming" | "notFound" | "error";
	messages: ReturnType<typeof useChatReattachStream>["messages"];
	partial: ReturnType<typeof useChatReattachStream>["partial"];
	terminalLabel: string | null;
	error: string | null;
	onClear: () => void;
}) {
	// Project ThreadMessageLike[] down to a tiny shape the panel
	// can render without pulling in the full chat tree.
	const rows = useMemo(() => {
		const collected: Array<{
			id: string;
			role: string;
			text: string;
		}> = [];
		const list = messages ?? [];
		for (const message of list) {
			const text = extractMessageText(message);
			if (text.length === 0) continue;
			collected.push({
				id: message.id ?? `${collected.length}`,
				role: typeof message.role === "string" ? message.role : "assistant",
				text,
			});
		}
		if (partial) {
			const text = extractMessageText(partial);
			if (text.length > 0) {
				collected.push({
					id: partial.id ?? "partial",
					role: typeof partial.role === "string" ? partial.role : "assistant",
					text: `${text} ▌`,
				});
			}
		}
		return collected;
	}, [messages, partial]);

	const headerLabel =
		phase === "streaming"
			? `Chat preview — ${requestId ?? ""}`
			: terminalLabel
				? `Chat preview — ${terminalLabel}`
				: "Chat preview";

	return (
		<div
			className="flex flex-col gap-2 rounded-md border border-border/30 bg-background/40 p-3"
			data-testid="reattach-chat-preview"
		>
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-medium text-foreground">
					{headerLabel}
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={rows.length === 0 && terminalLabel === null}
					onClick={onClear}
					aria-label="Clear chat preview"
				>
					<X className="mr-1.5 size-3.5" />
					Clear
				</Button>
			</div>
			{error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
			{rows.length === 0 ? (
				<span className="text-[11px] text-muted-foreground">
					Waiting for the daemon to emit the next message…
				</span>
			) : (
				<ul
					className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto text-[12px]"
					data-testid="reattach-chat-preview-list"
				>
					{rows.map((row) => (
						<li
							key={row.id}
							className="flex flex-col gap-0.5"
							data-testid={`reattach-chat-preview-row-${row.id}`}
						>
							<span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
								{row.role}
							</span>
							<span className="whitespace-pre-wrap break-words">
								{row.text}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/// Best-effort plain-text extractor for a ThreadMessageLike. The
/// pipeline's full content tree includes tool calls, code blocks,
/// thinking blocks, etc.; for the panel preview we just pull the
/// outermost text so the operator can confirm the assistant is
/// actually generating something. A future slice can swap this
/// for the chat's real renderer if the preview needs to match.
function extractMessageText(
	message: import("@/lib/api").ThreadMessageLike,
): string {
	if (!message?.content || !Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (!part || typeof part !== "object") continue;
		const obj = part as Record<string, unknown>;
		if (typeof obj.text === "string") {
			parts.push(obj.text);
			continue;
		}
		// Nested basic-part shape: { type: "basic", basic: { text: ... } }
		if (obj.type === "basic" && obj.basic && typeof obj.basic === "object") {
			const basic = obj.basic as Record<string, unknown>;
			if (typeof basic.text === "string") parts.push(basic.text);
		}
	}
	return parts.join("\n").trim();
}

function ReattachEventLog({
	requestId,
	phase,
	events,
	onClear,
}: {
	requestId: string | null;
	phase: "idle" | "attaching" | "streaming" | "notFound" | "error";
	events: ReturnType<typeof useReattachAgentStream>["events"];
	onClear: () => void;
}) {
	return (
		<div
			className="flex flex-col gap-2 rounded-md border border-border/30 bg-background/40 p-3"
			data-testid="reattach-event-log"
		>
			<div className="flex items-center justify-between">
				<span className="text-[11px] font-medium text-foreground">
					{phase === "streaming"
						? `Live events — ${requestId ?? ""}`
						: phase === "notFound"
							? "Session ended — log preserved"
							: `Events — ${events.length}`}
				</span>
				<Button
					variant="ghost"
					size="sm"
					disabled={events.length === 0}
					onClick={onClear}
					aria-label="Clear event log"
				>
					<X className="mr-1.5 size-3.5" />
					Clear
				</Button>
			</div>
			{events.length === 0 ? (
				<span className="text-[11px] text-muted-foreground">
					Waiting for the next event from the daemon…
				</span>
			) : (
				<ul
					className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto font-mono text-[11px]"
					data-testid="reattach-event-log-list"
				>
					{events.map((entry) => (
						<li
							key={entry.id}
							className="flex gap-2 truncate"
							data-testid={`reattach-event-row-${entry.id}`}
						>
							<span className="shrink-0 text-muted-foreground">
								{new Date(entry.receivedAt).toLocaleTimeString(undefined, {
									hour12: false,
								})}
							</span>
							<span className="truncate">
								{summariseEvent(entry.event.event)}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/// Render a one-line summary of an arbitrary sidecar event JSON.
/// The full payload is opaque (`event` is `unknown`); we surface
/// the recognised shapes (type / subtype / delta / message / etc.)
/// and fall back to compact JSON for everything else.
function summariseEvent(raw: unknown): string {
	if (raw === null || typeof raw !== "object") {
		return String(raw);
	}
	const obj = raw as Record<string, unknown>;
	const type = typeof obj.type === "string" ? obj.type : "?";
	const subtype = typeof obj.subtype === "string" ? `.${obj.subtype}` : "";
	const delta =
		typeof obj.delta === "string"
			? `: ${truncate(obj.delta, 80)}`
			: typeof obj.message === "string"
				? `: ${truncate(obj.message, 80)}`
				: "";
	return `[${type}${subtype}]${delta}`;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function RemoteAgentSessionRow({
	session,
	busy,
	streaming,
	chatPreviewActive,
	onAbort,
	onAttach,
	onChatPreview,
}: {
	session: RemoteAgentSession;
	busy: boolean;
	/**
	 * `true` when this row's stream is currently the one feeding
	 * the raw event log. Re-labels the attach button to "Stop"
	 * so the user can detach without leaving the panel.
	 */
	streaming: boolean;
	/**
	 * `true` when this row's session is being rendered as a
	 * chat-style preview (phase 24l). Re-labels the chat-preview
	 * button to "Stop" so the user can drop the preview without
	 * waiting for the daemon's terminal event.
	 */
	chatPreviewActive: boolean;
	onAbort: () => void;
	onAttach: () => void;
	onChatPreview: () => void;
}) {
	const startedAgoMs = Date.now() - session.startedAtMs;
	const sinceLastMs = Date.now() - session.lastEventMs;
	return (
		<li
			className="flex items-center justify-between gap-2 rounded border border-border/30 bg-card/40 px-2 py-1.5"
			data-testid={`remote-agent-session-${session.requestId}`}
			data-streaming={streaming ? "true" : undefined}
			data-chat-preview={chatPreviewActive ? "true" : undefined}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="flex items-center gap-1.5 truncate font-mono text-[11px]">
					{session.requestId}
					{session.state === "endedReplayOnly" && (
						<span
							className="rounded-sm border border-muted-foreground/30 px-1 py-px text-[9px] font-sans uppercase tracking-wide text-muted-foreground"
							title="Sidecar process is gone; on-disk journal is replay-only."
							data-testid="remote-agent-session-ended-badge"
						>
							ended
						</span>
					)}
				</span>
				<span className="truncate text-[10px] text-muted-foreground">
					{session.provider ?? "no provider"} ·{" "}
					{session.workspaceDir ?? "no workspace dir"} · started{" "}
					{formatAgo(startedAgoMs)} · last event {formatAgo(sinceLastMs)}
				</span>
			</div>
			<Button
				variant={streaming ? "default" : "outline"}
				size="sm"
				disabled={busy}
				onClick={onAttach}
				aria-label={
					streaming
						? `Stop streaming ${session.requestId}`
						: `Reattach to ${session.requestId}`
				}
			>
				{streaming ? (
					<>
						<X className="mr-1.5 size-3.5" />
						Stop
					</>
				) : (
					<>
						<Plug className="mr-1.5 size-3.5" />
						Reattach
					</>
				)}
			</Button>
			<Button
				variant={chatPreviewActive ? "default" : "outline"}
				size="sm"
				disabled={busy || !session.helmorSessionId}
				onClick={onChatPreview}
				aria-label={
					chatPreviewActive
						? `Stop chat preview for ${session.requestId}`
						: `Open chat preview for ${session.requestId}`
				}
				title={
					session.helmorSessionId
						? undefined
						: "Chat preview needs a Helmor session id; this session has none yet."
				}
			>
				{chatPreviewActive ? (
					<>
						<X className="mr-1.5 size-3.5" />
						Stop preview
					</>
				) : (
					<>
						<Plug2 className="mr-1.5 size-3.5" />
						Chat preview
					</>
				)}
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={busy}
				onClick={onAbort}
				aria-label={`Abort ${session.requestId}`}
			>
				<X className="mr-1.5 size-3.5" />
				Abort
			</Button>
		</li>
	);
}

function formatAgo(ms: number): string {
	if (ms < 0) return "just now";
	if (ms < 1000) return "just now";
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	return `${hr}h ago`;
}

/// Track E1: surface the daemon's trailing log lines in the
/// runtime-debug panel. Drives "what does the remote think went
/// wrong?" diagnostics without needing a separate SSH terminal.
/// Manual refetch only — auto-tail would be noisy + double-bandwidth
/// against the heartbeat loop.
function DaemonLogSection({ entries }: { entries: RuntimeEntry[] }) {
	const remotes = useMemo(() => entries.filter((e) => !e.isLocal), [entries]);
	const [selected, setSelected] = useState<string>("");
	const runtime =
		selected && remotes.some((r) => r.name === selected)
			? selected
			: (remotes[0]?.name ?? "");

	const logQuery = useQuery({
		queryKey: ["daemon-log-tail", runtime],
		queryFn: () => tailRemoteDaemonLog(runtime, 200),
		enabled: runtime !== "",
		refetchOnWindowFocus: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	return (
		<section>
			<SectionHeader
				icon={<Plug2 className="size-3.5" strokeWidth={1.8} />}
				title="Daemon log"
				description="Trailing lines from `$HOME/.helmor/server/daemon.log` on the selected remote. Useful first stop when an `agent.send` errors or the connection diagnostics show a 'closed reason' you don't recognise."
			/>
			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				{remotes.length === 0 ? (
					<SettingsNotice tone="info">
						Connect a remote runtime to view its daemon log.
					</SettingsNotice>
				) : (
					<>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)_auto] sm:items-center">
							<Label htmlFor="rt-daemon-log-runtime" className="text-xs">
								Runtime
							</Label>
							<select
								id="rt-daemon-log-runtime"
								className="h-7 rounded border border-border bg-background px-2 text-xs"
								value={runtime}
								onChange={(e) => setSelected(e.target.value)}
								data-testid="daemon-log-runtime-select"
							>
								{remotes.map((r) => (
									<option key={r.name} value={r.name}>
										{r.name}
									</option>
								))}
							</select>
							<Button
								size="sm"
								disabled={runtime === "" || logQuery.isFetching}
								onClick={() => logQuery.refetch()}
								data-testid="daemon-log-refresh"
							>
								{logQuery.isFetching ? "Refreshing…" : "Refresh"}
							</Button>
						</div>
						{logQuery.error ? (
							<SettingsNotice tone="error">
								{formatErrorMessage(logQuery.error) ?? "Failed to read log."}
							</SettingsNotice>
						) : null}
						{logQuery.data ? (
							<>
								<div className="text-[10px] text-muted-foreground">
									<span className="font-mono">{logQuery.data.logPath}</span>
									{logQuery.data.truncated ? " · tail truncated" : null}
									{" · "}
									{logQuery.data.lines.length} line
									{logQuery.data.lines.length === 1 ? "" : "s"}
								</div>
								<pre
									className="max-h-[280px] overflow-auto rounded border border-border/40 bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
									data-testid="daemon-log-pre"
								>
									{logQuery.data.lines.length === 0
										? "(log is empty)"
										: logQuery.data.lines.join("\n")}
								</pre>
							</>
						) : null}
					</>
				)}
			</div>
		</section>
	);
}

function formatErrorMessage(err: unknown): string | null {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return null;
}

function RemotePortForwardSection({ entries }: { entries: RuntimeEntry[] }) {
	const remotes = useMemo(() => entries.filter((e) => !e.isLocal), [entries]);
	const [runtimeName, setRuntimeName] = useState<string>("");
	const [localPortText, setLocalPortText] = useState<string>("");
	const [remotePortText, setRemotePortText] = useState<string>("");
	const [label, setLabel] = useState<string>("");
	const [notice, setNotice] = useState<{
		tone: "info" | "error" | "ok" | "warn";
		text: string;
	} | null>(null);

	useEffect(() => {
		if (!runtimeName && remotes[0]) {
			setRuntimeName(remotes[0].name);
			return;
		}
		if (runtimeName && !remotes.some((e) => e.name === runtimeName)) {
			setRuntimeName(remotes[0]?.name ?? "");
		}
	}, [remotes, runtimeName]);

	const forwardsQuery = useQuery({
		queryKey: ["remote-port-forwards", runtimeName],
		queryFn: () => listRemotePortForwards(runtimeName),
		enabled: runtimeName.length > 0,
		refetchOnWindowFocus: false,
	});

	const startMutation = useMutation({
		mutationFn: async (args: {
			localPort: number;
			remotePort: number;
			label: string | undefined;
		}) =>
			startRemotePortForward({
				runtimeName,
				localPort: args.localPort,
				remotePort: args.remotePort,
				label: args.label,
			}),
		onSuccess: (entry) => {
			setNotice({
				tone: "ok",
				text: `Forwarding localhost:${entry.localPort} → ${entry.runtimeName}:${entry.remotePort}.`,
			});
			setLocalPortText("");
			setRemotePortText("");
			setLabel("");
			void forwardsQuery.refetch();
		},
		onError: (err) => setNotice({ tone: "error", text: errorMessage(err) }),
	});

	const stopMutation = useMutation({
		mutationFn: async (localPort: number) =>
			stopRemotePortForward({ runtimeName, localPort }),
		onSuccess: (_result, localPort) => {
			setNotice({
				tone: "info",
				text: `Stopped forward on localhost:${localPort}.`,
			});
			void forwardsQuery.refetch();
		},
		onError: (err) => setNotice({ tone: "error", text: errorMessage(err) }),
	});

	const submitStart = () => {
		const localPort = Number.parseInt(localPortText, 10);
		const remotePort = Number.parseInt(remotePortText, 10);
		if (
			!Number.isFinite(localPort) ||
			localPort < 1 ||
			localPort > 65535 ||
			!Number.isFinite(remotePort) ||
			remotePort < 1 ||
			remotePort > 65535
		) {
			setNotice({
				tone: "error",
				text: "Local and remote ports must each be a number between 1 and 65535.",
			});
			return;
		}
		startMutation.mutate({
			localPort,
			remotePort,
			label: label.trim().length > 0 ? label.trim() : undefined,
		});
	};

	const forwards = forwardsQuery.data ?? [];

	return (
		<section>
			<SectionHeader
				icon={<Network className="size-3.5" strokeWidth={1.8} />}
				title="Port forwards"
				description="Tunnel a TCP port from the remote to localhost on this desktop. Uses the runtime's existing SSH ControlMaster, so no new auth + the forward rides the same TCP channel as the RPC pipe. SSH runtimes only — Command transports surface a hint pointing at their wrapper's own forwarding tool."
			/>

			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				{remotes.length === 0 ? (
					<SettingsNotice tone="info">
						Register a remote SSH runtime in the Connect form above to add a
						port forward.
					</SettingsNotice>
				) : (
					<>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
							<Label htmlFor="rt-pf-runtime" className="text-xs">
								Runtime
							</Label>
							<select
								id="rt-pf-runtime"
								className="flex h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs text-foreground"
								value={runtimeName}
								onChange={(e) => setRuntimeName(e.currentTarget.value)}
							>
								{remotes.map((entry) => (
									<option key={entry.name} value={entry.name}>
										{entry.name}
									</option>
								))}
							</select>

							<Label htmlFor="rt-pf-local-port" className="text-xs">
								Local port
							</Label>
							<Input
								id="rt-pf-local-port"
								type="number"
								min={1}
								max={65535}
								inputMode="numeric"
								placeholder="e.g. 5173"
								value={localPortText}
								onChange={(e) => setLocalPortText(e.currentTarget.value)}
								className="h-7 text-xs"
							/>

							<Label htmlFor="rt-pf-remote-port" className="text-xs">
								Remote port
							</Label>
							<Input
								id="rt-pf-remote-port"
								type="number"
								min={1}
								max={65535}
								inputMode="numeric"
								placeholder="e.g. 3000"
								value={remotePortText}
								onChange={(e) => setRemotePortText(e.currentTarget.value)}
								className="h-7 text-xs"
							/>

							<Label htmlFor="rt-pf-label" className="text-xs">
								Label (optional)
							</Label>
							<Input
								id="rt-pf-label"
								type="text"
								placeholder="e.g. Vite, Rails, Jupyter"
								value={label}
								onChange={(e) => setLabel(e.currentTarget.value)}
								className="h-7 text-xs"
							/>
						</div>

						<div className="flex items-center justify-between gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={
									!runtimeName ||
									startMutation.isPending ||
									localPortText.length === 0 ||
									remotePortText.length === 0
								}
								onClick={() => submitStart()}
							>
								{startMutation.isPending ? (
									<>
										<Loader2 className="mr-1.5 size-3.5 animate-spin" />
										Starting…
									</>
								) : (
									<>
										<Plug className="mr-1.5 size-3.5" />
										Start forward
									</>
								)}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								disabled={!runtimeName || forwardsQuery.isFetching}
								onClick={() => void forwardsQuery.refetch()}
								aria-label="Refresh port forwards"
							>
								{forwardsQuery.isFetching ? (
									<>
										<Loader2 className="mr-1.5 size-3.5 animate-spin" />
										Refreshing…
									</>
								) : (
									<>
										<RefreshCw className="mr-1.5 size-3.5" />
										Refresh
									</>
								)}
							</Button>
						</div>

						{notice && (
							<SettingsNotice tone={notice.tone}>{notice.text}</SettingsNotice>
						)}

						{forwardsQuery.error ? (
							<SettingsNotice tone="error">
								{errorMessage(forwardsQuery.error)}
							</SettingsNotice>
						) : forwardsQuery.isLoading ? (
							<span className="text-[11px] text-muted-foreground">
								Listing port forwards…
							</span>
						) : forwards.length === 0 ? (
							<span className="text-[11px] text-muted-foreground">
								No port forwards active on this runtime.
							</span>
						) : (
							<ul className="flex flex-col gap-1">
								{forwards.map((entry) => (
									<PortForwardRow
										key={`${entry.runtimeName}:${entry.localPort}`}
										entry={entry}
										busy={stopMutation.isPending}
										onStop={() => stopMutation.mutate(entry.localPort)}
									/>
								))}
							</ul>
						)}
					</>
				)}
			</div>
		</section>
	);
}

function PortForwardRow({
	entry,
	busy,
	onStop,
}: {
	entry: PortForwardEntry;
	busy: boolean;
	onStop: () => void;
}) {
	const startedAgoMs = Date.now() - entry.startedAtMs;
	return (
		<li
			className="flex items-center justify-between gap-2 rounded border border-border/30 bg-card/40 px-2 py-1.5"
			data-testid={`remote-port-forward-${entry.runtimeName}-${entry.localPort}`}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="truncate font-mono text-[11px]">
					localhost:{entry.localPort} → {entry.runtimeName}:{entry.remotePort}
				</span>
				<span className="truncate text-[10px] text-muted-foreground">
					{entry.label ? `${entry.label} · ` : ""}
					started {formatAgo(startedAgoMs)}
				</span>
			</div>
			<Button
				variant="outline"
				size="sm"
				disabled={busy}
				onClick={onStop}
				aria-label={`Stop forward on localhost:${entry.localPort}`}
			>
				<X className="mr-1.5 size-3.5" />
				Stop
			</Button>
		</li>
	);
}

function RemoteTerminalSection({ entries }: { entries: RuntimeEntry[] }) {
	const remotes = useMemo(() => entries.filter((e) => !e.isLocal), [entries]);
	const [runtimeName, setRuntimeName] = useState<string>("");
	const [workspaceDir, setWorkspaceDir] = useState<string>("");
	const [shell, setShell] = useState<string>("");
	const [output, setOutput] = useState<string>("");
	const [openSession, setOpenSession] = useState<{
		runtimeName: string;
		terminalId: string;
	} | null>(null);
	const [pendingInput, setPendingInput] = useState<string>("");
	const [pid, setPid] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<boolean>(false);

	// Keep the runtime select valid: if the chosen remote disappears
	// (disconnected from the list panel), fall back to the first
	// remaining remote or clear the select.
	useEffect(() => {
		if (runtimeName && !remotes.some((r) => r.name === runtimeName)) {
			setRuntimeName(remotes[0]?.name ?? "");
		}
	}, [remotes, runtimeName]);

	const appendOutput = (chunk: string) => {
		setOutput((prev) => {
			const next = prev + chunk;
			return next.length > TERMINAL_OUTPUT_BUDGET
				? next.slice(next.length - TERMINAL_OUTPUT_BUDGET)
				: next;
		});
	};

	// Shared event handler for both open + attach flows. Factored
	// out so the two code paths can't drift on how they paint
	// stdout / exit / error.
	const makeEventHandler =
		() =>
		(event: TerminalEventNotification): void => {
			switch (event.event.kind) {
				case "stdout":
					appendOutput(event.event.data);
					break;
				case "exited":
					appendOutput(
						`\n[exited code=${event.event.code ?? "killed-by-signal"}]\n`,
					);
					setOpenSession(null);
					break;
				case "error":
					appendOutput(`\n[error: ${event.event.message}]\n`);
					setOpenSession(null);
					break;
			}
		};

	const handleOpen = async () => {
		if (!runtimeName.trim()) {
			setError("pick a runtime to host the terminal");
			return;
		}
		if (!workspaceDir.trim()) {
			setError("workspace dir must not be empty");
			return;
		}
		setError(null);
		setBusy(true);
		const terminalId = crypto.randomUUID();
		setOutput("");
		setPid(null);
		try {
			const result = await openRemoteTerminal(
				runtimeName,
				terminalId,
				workspaceDir,
				{
					shell: shell.trim() || undefined,
					cols: 100,
					rows: 30,
					onEvent: makeEventHandler(),
				},
			);
			setOpenSession({ runtimeName, terminalId });
			setPid(result.pid);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setBusy(false);
		}
	};

	const handleAttach = async (entry: RemoteTerminalListEntry) => {
		setError(null);
		setBusy(true);
		setOutput("");
		setPid(entry.pid);
		try {
			const attach = await attachRemoteTerminal(runtimeName, entry.terminalId, {
				onEvent: makeEventHandler(),
			});
			// Paint scrollback first so the user sees where the
			// shell was when we left it; live events arrive on top.
			if (attach.scrollback) {
				appendOutput(attach.scrollback);
			}
			setOpenSession({ runtimeName, terminalId: entry.terminalId });
		} catch (err) {
			setError(errorMessage(err));
			setPid(null);
		} finally {
			setBusy(false);
		}
	};

	const handleSend = async () => {
		if (!openSession) return;
		const data = pendingInput;
		setPendingInput("");
		try {
			// Append a carriage return so the shell sees Enter; lets
			// the input look like the user typed `<text><enter>`.
			await writeRemoteTerminal(
				openSession.runtimeName,
				openSession.terminalId,
				`${data}\r`,
			);
		} catch (err) {
			setError(errorMessage(err));
		}
	};

	const handleClose = async () => {
		if (!openSession) return;
		setBusy(true);
		try {
			await closeRemoteTerminal(
				openSession.runtimeName,
				openSession.terminalId,
			);
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setOpenSession(null);
			setBusy(false);
		}
	};

	return (
		<section>
			<SectionHeader
				icon={<Server className="size-3.5" strokeWidth={1.8} />}
				title="Remote terminal"
				description="Spawn an interactive shell on a connected remote runtime. PTY output streams over the same JSON-RPC pipe as everything else."
			/>
			{remotes.length === 0 ? (
				<SettingsNotice tone="info">
					Connect a remote runtime first (the "Connect a runtime" section above)
					— terminals only run on remote runtimes; local terminals live in the
					workspace's Terminal tab.
				</SettingsNotice>
			) : (
				<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
						<Label htmlFor="rt-runtime" className="text-xs">
							Runtime
						</Label>
						<select
							id="rt-runtime"
							value={runtimeName}
							onChange={(e) => setRuntimeName(e.target.value)}
							disabled={!!openSession || busy}
							className={cn(
								"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1",
								"text-sm shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
								"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
							)}
						>
							<option value="">(pick a remote)</option>
							{remotes.map((r) => (
								<option key={r.name} value={r.name}>
									{r.name}
								</option>
							))}
						</select>

						<Label htmlFor="rt-dir" className="text-xs">
							Workspace dir
						</Label>
						<Input
							id="rt-dir"
							value={workspaceDir}
							onChange={(e) => setWorkspaceDir(e.target.value)}
							placeholder="/home/me/code/repo"
							disabled={!!openSession || busy}
						/>

						<Label htmlFor="rt-shell" className="text-xs">
							Shell (optional)
						</Label>
						<Input
							id="rt-shell"
							value={shell}
							onChange={(e) => setShell(e.target.value)}
							placeholder="(server's $SHELL — typically /bin/bash)"
							disabled={!!openSession || busy}
						/>
					</div>

					{runtimeName && !openSession ? (
						<ReattachList
							runtimeName={runtimeName}
							busy={busy}
							onAttach={(entry) => void handleAttach(entry)}
						/>
					) : null}

					<div className="flex items-center gap-2">
						{openSession ? (
							<Button
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => void handleClose()}
							>
								{busy ? (
									<>
										<Loader2 className="mr-1.5 size-3.5 animate-spin" />
										Closing…
									</>
								) : (
									<>
										<X className="mr-1.5 size-3.5" />
										Close terminal
									</>
								)}
							</Button>
						) : (
							<Button
								variant="default"
								size="sm"
								disabled={busy}
								onClick={() => void handleOpen()}
							>
								{busy ? (
									<>
										<Loader2 className="mr-1.5 size-3.5 animate-spin" />
										Opening…
									</>
								) : (
									<>
										<Plug className="mr-1.5 size-3.5" />
										Open terminal
									</>
								)}
							</Button>
						)}
						{pid !== null ? (
							<span className="font-mono text-[11px] text-muted-foreground">
								pid={pid}
							</span>
						) : null}
					</div>

					{error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}

					<pre
						className={cn(
							"min-h-[200px] max-h-[400px] overflow-auto rounded-md border border-border/40",
							"bg-background/50 p-2 font-mono text-[11px] leading-tight whitespace-pre-wrap",
						)}
					>
						{output || "(no output yet — open a terminal to start)"}
					</pre>

					<div className="flex items-center gap-2">
						<Input
							value={pendingInput}
							onChange={(e) => setPendingInput(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									void handleSend();
								}
							}}
							placeholder={
								openSession
									? "type a command and press Enter…"
									: "(open a terminal to send input)"
							}
							disabled={!openSession || busy}
						/>
						<Button
							variant="outline"
							size="sm"
							disabled={!openSession || busy}
							onClick={() => void handleSend()}
						>
							Send
						</Button>
					</div>
				</div>
			)}
		</section>
	);
}

/// Phase 23e: dev-panel surface for `agent.setAuth`. Lets the
/// operator push an SDK API key to a remote runtime's secrets
/// store without dropping into the developer console. Keys never
/// touch the desktop's settings DB — the wrapper just forwards.
function SetAgentAuthSection({ entries }: { entries: RuntimeEntry[] }) {
	// Filter to *remote* runtimes — the built-in `local` entry is
	// rejected server-side anyway, but the picker shouldn't even
	// offer it. Empty list → no remotes registered yet; render a
	// hint instead of a broken form.
	const remoteEntries = useMemo(
		() => entries.filter((e) => !e.isLocal),
		[entries],
	);
	const [runtimeName, setRuntimeName] = useState<string>("");
	const [provider, setProvider] = useState<string>("cursor");
	const [apiKey, setApiKey] = useState<string>("");

	// Keep the selected runtime valid as the registry list shifts.
	useEffect(() => {
		if (!runtimeName && remoteEntries[0]) {
			setRuntimeName(remoteEntries[0].name);
			return;
		}
		if (runtimeName && !remoteEntries.some((e) => e.name === runtimeName)) {
			setRuntimeName(remoteEntries[0]?.name ?? "");
		}
	}, [remoteEntries, runtimeName]);

	const pushAuth = useMutation({
		mutationFn: async ({
			name,
			providerName,
			key,
		}: {
			name: string;
			providerName: string;
			key: string | null;
		}) => setRuntimeAgentAuth(name, providerName, key),
		onSuccess: () => {
			// Clear the input on success so the key doesn't sit
			// visible in the form after submit. The remote already
			// has it persisted; the desktop has nothing to remember.
			setApiKey("");
		},
	});

	return (
		<section>
			<SectionHeader
				icon={<KeyRound className="size-3.5" strokeWidth={1.8} />}
				title="Set agent auth"
				description="Push an SDK API key to a remote runtime's secrets store. Keys live in ~/.helmor/server/secrets.json on the remote (mode 0600) and hot-push to the live sidecar via updateConfig. Keys NEVER persist on the desktop."
			/>

			<div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-card/30 p-4">
				{remoteEntries.length === 0 ? (
					<SettingsNotice tone="info">
						Register a remote runtime in the Connect form above to push an API
						key to it.
					</SettingsNotice>
				) : (
					<>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
							<Label htmlFor="rt-auth-runtime" className="text-xs">
								Runtime
							</Label>
							<select
								id="rt-auth-runtime"
								value={runtimeName}
								onChange={(e) => setRuntimeName(e.target.value)}
								className={cn(
									"flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 shadow-sm",
									"text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
								)}
							>
								{remoteEntries.map((e) => (
									<option key={e.name} value={e.name}>
										{e.name}
									</option>
								))}
							</select>

							<Label htmlFor="rt-auth-provider" className="text-xs">
								Provider
							</Label>
							<Input
								id="rt-auth-provider"
								value={provider}
								onChange={(e) => setProvider(e.target.value)}
								placeholder="cursor"
							/>

							<Label htmlFor="rt-auth-key" className="text-xs">
								API key
							</Label>
							<div className="flex flex-col gap-1">
								<Input
									id="rt-auth-key"
									type="password"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder="sk-..."
									autoComplete="off"
								/>
								<span className="text-[11px] text-muted-foreground">
									Leave blank and click <em>Clear</em> to remove a stored key.
								</span>
							</div>
						</div>

						<div className="flex items-center justify-between gap-3">
							<div className="min-w-0 flex-1">
								{pushAuth.isError ? (
									<SettingsNotice tone="error">
										{errorMessage(pushAuth.error)}
									</SettingsNotice>
								) : pushAuth.isSuccess ? (
									<SettingsNotice tone="ok">Saved on remote.</SettingsNotice>
								) : null}
							</div>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={
										pushAuth.isPending || !runtimeName || !provider.trim()
									}
									onClick={() =>
										pushAuth.mutate({
											name: runtimeName,
											providerName: provider.trim(),
											key: null,
										})
									}
								>
									Clear
								</Button>
								<Button
									variant="default"
									size="sm"
									disabled={
										pushAuth.isPending ||
										!runtimeName ||
										!provider.trim() ||
										!apiKey
									}
									onClick={() =>
										pushAuth.mutate({
											name: runtimeName,
											providerName: provider.trim(),
											key: apiKey,
										})
									}
								>
									{pushAuth.isPending ? (
										<>
											<Loader2 className="mr-1.5 size-3.5 animate-spin" />
											Saving…
										</>
									) : (
										"Save"
									)}
								</Button>
							</div>
						</div>
					</>
				)}
			</div>
		</section>
	);
}

// ── shared bits ──────────────────────────────────────────────────────

function SectionHeader({
	icon,
	title,
	description,
}: {
	icon: React.ReactNode;
	title: string;
	description: string;
}) {
	return (
		<header className="mb-3">
			<h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
				{icon}
				<span>{title}</span>
			</h3>
			<p className="mt-1 text-[12px] leading-snug text-muted-foreground">
				{description}
			</p>
		</header>
	);
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}
