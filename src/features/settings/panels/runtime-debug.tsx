import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Link2,
	Loader2,
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
	attachRemoteTerminal,
	clearWorkspaceRuntimeBinding,
	closeRemoteTerminal,
	connectLocalRuntime,
	connectRemoteRuntime,
	disconnectRemoteRuntime,
	getRuntimeHealth,
	getWorkspaceBranchInfo,
	getWorkspaceStatus,
	listOwnedTerminals,
	listRemoteRuntimes,
	listRemoteTerminals,
	listSshHosts,
	listWorkspaceRuntimeBindings,
	openRemoteTerminal,
	type RemoteTerminalListEntry,
	type RuntimeEntry,
	type RuntimeHealth,
	reconnectRemoteRuntime,
	setWorkspaceRuntimeBinding,
	type TerminalEventNotification,
	type WorkspaceBranchInfoResult,
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
			<WorkspaceStatusProbeSection entries={entries} />
			<WorkspaceBindingsSection entries={entries} />
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
	}
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

type ConnectMode = "local" | "ssh";

function ConnectSection() {
	const [mode, setMode] = useState<ConnectMode>("local");
	const [name, setName] = useState("");
	const [binaryPath, setBinaryPath] = useState("");
	const [host, setHost] = useState("");
	const [remoteBinary, setRemoteBinary] = useState("helmor-server");

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
		},
	});

	return (
		<section>
			<SectionHeader
				icon={<Plug2 className="size-3.5" strokeWidth={1.8} />}
				title="Connect a runtime"
				description="`local-binary` spawns the bundled helmor-server directly — handy for smoke testing the RPC vertical without an SSH host."
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
					) : (
						<>
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
					)}
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
