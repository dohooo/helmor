import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertCircle,
	CheckCircle2,
	Loader2,
	Plug,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	addMcpSource,
	getExecutorStatus,
	listMcpSources,
	type McpSourceRow,
	openMcpStudioWindow,
	removeMcpSource,
	restartExecutor,
} from "@/lib/api";
import {
	SettingsGroup,
	SettingsNotice,
	SettingsRow,
} from "../components/settings-row";

const STATUS_QUERY_KEY = ["mcp", "executor-status"] as const;
const SOURCES_QUERY_KEY = ["mcp", "sources"] as const;

export function McpSettingsPanel() {
	const queryClient = useQueryClient();

	const statusQuery = useQuery({
		queryKey: STATUS_QUERY_KEY,
		queryFn: getExecutorStatus,
		refetchInterval: 5000,
	});
	const isRunning = statusQuery.data?.running === true;

	const sourcesQuery = useQuery({
		queryKey: SOURCES_QUERY_KEY,
		queryFn: listMcpSources,
		enabled: isRunning,
		refetchInterval: isRunning ? 10000 : false,
	});

	const restartMutation = useMutation({
		mutationFn: restartExecutor,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
			queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
		},
	});

	const openStudioMutation = useMutation({
		mutationFn: openMcpStudioWindow,
	});

	const removeMutation = useMutation({
		mutationFn: (sourceId: string) => removeMcpSource(sourceId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
		},
	});

	return (
		<div className="flex flex-col gap-6">
			<ExecutorStatusGroup
				running={isRunning}
				baseUrl={statusQuery.data?.baseUrl ?? null}
				error={statusQuery.data?.error ?? null}
				version={statusQuery.data?.version ?? "unknown"}
				restarting={restartMutation.isPending}
				openingStudio={openStudioMutation.isPending}
				onRestart={() => restartMutation.mutate()}
				onOpenStudio={() => openStudioMutation.mutate()}
				openStudioError={
					openStudioMutation.error instanceof Error
						? openStudioMutation.error.message
						: null
				}
				restartError={
					restartMutation.error instanceof Error
						? restartMutation.error.message
						: null
				}
			/>

			<SourcesGroup
				sources={sourcesQuery.data ?? []}
				isLoading={sourcesQuery.isPending && isRunning}
				disabled={!isRunning}
				onRemove={(id) => removeMutation.mutate(id)}
				removingId={removeMutation.isPending ? removeMutation.variables : null}
			/>

			<AddSourceGroup
				disabled={!isRunning}
				onAdded={() => {
					queryClient.invalidateQueries({ queryKey: SOURCES_QUERY_KEY });
				}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Status group
// ---------------------------------------------------------------------------

function ExecutorStatusGroup({
	running,
	baseUrl,
	error,
	version,
	restarting,
	openingStudio,
	onRestart,
	onOpenStudio,
	openStudioError,
	restartError,
}: {
	running: boolean;
	baseUrl: string | null;
	error: string | null;
	version: string;
	restarting: boolean;
	openingStudio: boolean;
	onRestart: () => void;
	onOpenStudio: () => void;
	openStudioError: string | null;
	restartError: string | null;
}) {
	return (
		<SettingsGroup>
			<SettingsRow
				align="start"
				title={
					<span className="flex items-center gap-1.5">
						<Plug
							className="size-3.5 text-muted-foreground"
							strokeWidth={1.8}
						/>
						<span>Executor</span>
					</span>
				}
				description={
					<>
						Runs the{" "}
						<code className="rounded bg-muted px-1 py-0.5 text-[11px]">
							executor@{version}
						</code>{" "}
						MCP gateway in the background. Tool calls from MCP-aware agents
						route through it.
						{running && baseUrl ? (
							<SettingsNotice tone="ok">
								Running at{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
									{baseUrl}
								</code>
							</SettingsNotice>
						) : null}
						{!running && error ? (
							<SettingsNotice tone="error">{error}</SettingsNotice>
						) : null}
						{!running && !error ? (
							<SettingsNotice tone="info">Starting…</SettingsNotice>
						) : null}
						{restartError ? (
							<SettingsNotice tone="error">
								Restart failed: {restartError}
							</SettingsNotice>
						) : null}
						{openStudioError ? (
							<SettingsNotice tone="error">{openStudioError}</SettingsNotice>
						) : null}
					</>
				}
			>
				<div className="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={onRestart}
						disabled={restarting}
					>
						{restarting ? <Loader2 className="size-3.5 animate-spin" /> : null}
						Restart
					</Button>
					<Button
						variant="default"
						size="sm"
						onClick={onOpenStudio}
						disabled={!running || openingStudio}
					>
						{openingStudio ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : null}
						Open Studio
					</Button>
				</div>
			</SettingsRow>
		</SettingsGroup>
	);
}

// ---------------------------------------------------------------------------
// Sources list
// ---------------------------------------------------------------------------

function SourcesGroup({
	sources,
	isLoading,
	disabled,
	onRemove,
	removingId,
}: {
	sources: McpSourceRow[];
	isLoading: boolean;
	disabled: boolean;
	onRemove: (id: string) => void;
	removingId: string | null;
}) {
	return (
		<SettingsGroup>
			<SettingsRow
				title="MCP Sources"
				description="Tool integrations exposed through Executor. Use these for external systems."
			/>
			{disabled ? (
				<SettingsRow
					align="start"
					title={<span className="text-muted-foreground">Unavailable</span>}
					description="Executor is not running. Sources will appear here once it starts."
				/>
			) : isLoading ? (
				<SettingsRow
					align="start"
					title={
						<span className="flex items-center gap-1.5 text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" />
							Loading sources…
						</span>
					}
				/>
			) : sources.length === 0 ? (
				<SettingsRow
					align="start"
					title={<span className="text-muted-foreground">No sources yet</span>}
					description="Add an MCP source below to get started."
				/>
			) : (
				sources.map((source) => (
					<SourceRow
						key={source.id}
						source={source}
						isRemoving={removingId === source.id}
						onRemove={() => onRemove(source.id)}
					/>
				))
			)}
		</SettingsGroup>
	);
}

function SourceRow({
	source,
	isRemoving,
	onRemove,
}: {
	source: McpSourceRow;
	isRemoving: boolean;
	onRemove: () => void;
}) {
	const toolCountLabel =
		source.toolCount === 1 ? "1 tool" : `${source.toolCount} tools`;
	// "ready" + "built-in" are both healthy states (the latter is Executor's
	// own internal source). Only treat truly failed states (anything containing
	// "error" / "fail") as warning.
	const isHealthy = !/error|fail/i.test(source.status);
	return (
		<SettingsRow
			align="center"
			title={
				<span className="flex items-center gap-1.5">
					{isHealthy ? (
						<CheckCircle2
							className="size-3.5 text-emerald-500"
							strokeWidth={2}
						/>
					) : (
						<AlertCircle className="size-3.5 text-amber-500" strokeWidth={2} />
					)}
					<span>{source.name}</span>
				</span>
			}
			description={
				<span className="flex flex-wrap items-center gap-2 text-[12px]">
					<span className="rounded bg-muted px-1.5 py-0.5">
						{source.transport}
					</span>
					<span>{toolCountLabel}</span>
					{source.namespace ? (
						<span className="text-muted-foreground/70">
							namespace · {source.namespace}
						</span>
					) : null}
				</span>
			}
		>
			<Button
				variant="ghost"
				size="sm"
				disabled={isRemoving}
				onClick={onRemove}
				title="Remove this source"
			>
				{isRemoving ? (
					<Loader2 className="size-3.5 animate-spin" />
				) : (
					<Trash2 className="size-3.5" strokeWidth={1.8} />
				)}
			</Button>
		</SettingsRow>
	);
}

// ---------------------------------------------------------------------------
// Add Source form
// ---------------------------------------------------------------------------

type TransportKind = "stdio" | "remote";

function AddSourceGroup({
	disabled,
	onAdded,
}: {
	disabled: boolean;
	onAdded: () => void;
}) {
	const [transport, setTransport] = useState<TransportKind>("remote");
	const [name, setName] = useState("");
	const [command, setCommand] = useState("");
	const [argsLine, setArgsLine] = useState("");
	const [endpoint, setEndpoint] = useState("");
	const [authToken, setAuthToken] = useState("");
	const [headersLines, setHeadersLines] = useState("");
	const [showHeaders, setShowHeaders] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const addMutation = useMutation({
		mutationFn: addMcpSource,
		onSuccess: () => {
			setName("");
			setCommand("");
			setArgsLine("");
			setEndpoint("");
			setAuthToken("");
			setHeadersLines("");
			setShowHeaders(false);
			setError(null);
			onAdded();
		},
		onError: (e) => setError(e instanceof Error ? e.message : String(e)),
	});

	const parsedHeaders = useMemo(
		() => parseHeadersText(headersLines),
		[headersLines],
	);
	const headersError = parsedHeaders.errors[0] ?? null;

	const submitDisabled =
		disabled ||
		addMutation.isPending ||
		name.trim() === "" ||
		(transport === "stdio" && command.trim() === "") ||
		(transport === "remote" && endpoint.trim() === "") ||
		Boolean(headersError);

	const handleSubmit = useCallback(() => {
		setError(null);
		const trimmedName = name.trim();
		if (!trimmedName) return;
		if (transport === "stdio") {
			const trimmedCommand = command.trim();
			if (!trimmedCommand) return;
			addMutation.mutate({
				name: trimmedName,
				transport: "stdio",
				command: trimmedCommand,
				args: splitArgs(argsLine),
			});
		} else {
			const trimmedEndpoint = endpoint.trim();
			if (!trimmedEndpoint) return;
			addMutation.mutate({
				name: trimmedName,
				transport: "remote",
				endpoint: trimmedEndpoint,
				authToken: authToken.trim() || undefined,
				headers:
					Object.keys(parsedHeaders.headers).length > 0
						? parsedHeaders.headers
						: undefined,
			});
		}
	}, [
		name,
		transport,
		command,
		argsLine,
		endpoint,
		authToken,
		parsedHeaders.headers,
		addMutation,
	]);

	return (
		<SettingsGroup>
			<SettingsRow
				align="start"
				title="Add MCP Source"
				description="Register a new MCP server. Local stdio commands run on this machine; remote endpoints use Streamable HTTP / SSE."
			/>

			<div className="flex flex-col gap-4 py-4">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="mcp-transport">Transport</Label>
					<ToggleGroup
						type="single"
						value={transport}
						onValueChange={(value) => {
							if (value === "stdio" || value === "remote") {
								setTransport(value);
							}
						}}
						className="gap-1"
					>
						<ToggleGroupItem
							value="remote"
							aria-label="Remote (HTTP)"
							className="h-8 rounded-md px-3 text-[12px] font-medium"
						>
							Remote (HTTP)
						</ToggleGroupItem>
						<ToggleGroupItem
							value="stdio"
							aria-label="Local (stdio)"
							className="h-8 rounded-md px-3 text-[12px] font-medium"
						>
							Local (stdio)
						</ToggleGroupItem>
					</ToggleGroup>
				</div>

				<div className="flex flex-col gap-1.5">
					<Label htmlFor="mcp-name">Name</Label>
					<Input
						id="mcp-name"
						placeholder="GitHub, Context7, Linear…"
						value={name}
						onChange={(e) => setName(e.target.value)}
						disabled={disabled || addMutation.isPending}
					/>
				</div>

				{transport === "stdio" ? (
					<>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mcp-command">Command</Label>
							<Input
								id="mcp-command"
								placeholder="/usr/local/bin/my-mcp-server"
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								disabled={disabled || addMutation.isPending}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mcp-args">Arguments (space-separated)</Label>
							<Input
								id="mcp-args"
								placeholder="--port 3000 --verbose"
								value={argsLine}
								onChange={(e) => setArgsLine(e.target.value)}
								disabled={disabled || addMutation.isPending}
							/>
						</div>
					</>
				) : (
					<>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mcp-endpoint">Endpoint URL</Label>
							<Input
								id="mcp-endpoint"
								placeholder="https://mcp.example.com/mcp"
								value={endpoint}
								onChange={(e) => setEndpoint(e.target.value)}
								disabled={disabled || addMutation.isPending}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mcp-token">
								Bearer token{" "}
								<span className="text-muted-foreground">(optional)</span>
							</Label>
							<Input
								id="mcp-token"
								type="password"
								placeholder="paste API token"
								autoComplete="off"
								value={authToken}
								onChange={(e) => setAuthToken(e.target.value)}
								disabled={disabled || addMutation.isPending}
							/>
							<span className="text-[11px] text-muted-foreground">
								Sent as{" "}
								<code className="rounded bg-muted px-1 py-0.5">
									Authorization: Bearer ...
								</code>
							</span>
						</div>
						<div className="flex flex-col gap-1.5">
							<button
								type="button"
								className="flex w-fit items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
								onClick={() => setShowHeaders((v) => !v)}
							>
								{showHeaders ? "Hide" : "Add"} custom headers
							</button>
							{showHeaders ? (
								<>
									<Textarea
										id="mcp-headers"
										placeholder={"X-Account-Id: abc\nX-Custom-Header: value"}
										rows={3}
										value={headersLines}
										onChange={(e) => setHeadersLines(e.target.value)}
										disabled={disabled || addMutation.isPending}
									/>
									<span className="text-[11px] text-muted-foreground">
										One header per line as{" "}
										<code className="rounded bg-muted px-1 py-0.5">
											Key: Value
										</code>
										.
									</span>
									{headersError ? (
										<SettingsNotice tone="error">{headersError}</SettingsNotice>
									) : null}
								</>
							) : null}
						</div>
					</>
				)}

				{error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}

				<div className="flex justify-end">
					<Button size="sm" onClick={handleSubmit} disabled={submitDisabled}>
						{addMutation.isPending ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Plus className="size-3.5" strokeWidth={1.8} />
						)}
						Add source
					</Button>
				</div>
			</div>
		</SettingsGroup>
	);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitArgs(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed) return [];
	// Simple whitespace split — quoting could come later. MVP scope.
	return trimmed.split(/\s+/);
}

function parseHeadersText(input: string): {
	headers: Record<string, string>;
	errors: string[];
} {
	const headers: Record<string, string> = {};
	const errors: string[] = [];
	const lines = input.split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "") continue;
		const idx = line.indexOf(":");
		if (idx <= 0) {
			errors.push(`Bad header line (expected "Key: Value"): ${line}`);
			continue;
		}
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (!key || !value) {
			errors.push(`Bad header line (empty key or value): ${line}`);
			continue;
		}
		headers[key] = value;
	}
	return { headers, errors };
}
