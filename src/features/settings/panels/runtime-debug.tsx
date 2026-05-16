import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plug, Plug2, Server, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	connectLocalRuntime,
	connectRemoteRuntime,
	disconnectRemoteRuntime,
	getRuntimeHealth,
	getWorkspaceStatus,
	listRemoteRuntimes,
	type RuntimeEntry,
	type RuntimeHealth,
	type WorkspaceStatusResult,
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
	// Lazy health probe per row. `runtime_health` is documented as cheap
	// + side-effect-free so polling on focus is safe; we don't poll on
	// an interval until phase 9 adds the liveness signal.
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

	return (
		<SettingsRow
			align="start"
			title={
				<span className="flex items-center gap-1.5 font-mono">
					<span>{entry.name}</span>
					<HealthChip
						health={healthQuery.data}
						loading={healthQuery.isLoading}
						error={healthQuery.error}
					/>
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
			)}
		</SettingsRow>
	);
}

function HealthChip({
	health,
	loading,
	error,
}: {
	health: RuntimeHealth | undefined;
	loading: boolean;
	error: unknown;
}) {
	let tone: "ok" | "warn" | "error" = "ok";
	let label = "…";
	if (loading) {
		tone = "warn";
		label = "checking";
	} else if (error) {
		tone = "error";
		label = "error";
	} else if (health) {
		tone = "ok";
		label =
			health.kind.type === "local" ? "local" : `remote @ ${health.kind.host}`;
	}
	const toneClass = {
		ok: "border-green-600/40 bg-green-600/10 text-green-300",
		warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
		error: "border-destructive/40 bg-destructive/10 text-destructive",
	}[tone];
	return (
		<span
			className={cn(
				"inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
				toneClass,
			)}
		>
			{label}
		</span>
	);
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
							<Input
								id="runtime-host"
								value={host}
								onChange={(e) => setHost(e.target.value)}
								placeholder="dev.box"
							/>
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

function WorkspaceStatusProbeSection({ entries }: { entries: RuntimeEntry[] }) {
	const [workspaceDir, setWorkspaceDir] = useState("");
	const [runtimeName, setRuntimeName] = useState<string>("local");

	// Keep the selected runtime valid: if it disappears from the list
	// (e.g. user disconnects), fall back to `local`.
	useEffect(() => {
		if (!entries.some((e) => e.name === runtimeName)) {
			setRuntimeName("local");
		}
	}, [entries, runtimeName]);

	const probe = useMutation({
		mutationFn: () => getWorkspaceStatus(workspaceDir, runtimeName),
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
				description="Round-trips `workspace.status` through the selected runtime. Path is interpreted on the runtime's own filesystem."
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
						{runtimeOptions.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>

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

				<div className="flex items-center justify-between gap-3">
					<div className="min-w-0 flex-1">
						<ProbeResult
							loading={probe.isPending}
							error={probe.error}
							result={probe.data}
						/>
					</div>
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
		</section>
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
