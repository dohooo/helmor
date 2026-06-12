import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Channel } from "@tauri-apps/api/core";
import {
	AlertCircle,
	Check,
	ChevronDown,
	CircleHelp,
	Cpu,
	Download,
	Loader2,
	Pause,
	Play,
	RotateCcw,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	activateLocalLlmModel,
	cancelLocalLlmDownload,
	detectLocalLlmHardware,
	getLocalLlmStatus,
	inspectLocalLlmCatalogEntry,
	inspectLocalLlmModel,
	type LocalLlmCatalogEntry,
	type LocalLlmDownloadEvent,
	type LocalLlmDownloadStatus,
	listLocalLlmCatalog,
	localLlmEntryTotalBytes,
	pauseLocalLlmDownload,
	setLocalLlmContextOverride,
	startLocalLlm,
	startLocalLlmDownload,
	stopLocalLlm,
	subscribeLocalLlmDownloads,
} from "@/lib/api";
import { I18nText, useI18n, useLocalizedNode } from "@/lib/i18n";
import type { AppSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { SettingsReleaseBadge } from "../components/release-marker";

const LOCAL_LLM_STATUS_KEY = ["localLlmStatus"] as const;
const LOCAL_LLM_CATALOG_KEY = ["localLlmCatalog"] as const;
const LOCAL_LLM_HARDWARE_KEY = ["localLlmHardware"] as const;

/// Sentinel selection value for the Curated Models picker. When the
/// user has a valid Custom model path, the dropdown includes a Custom
/// entry on top — selecting it focuses the panel on the custom path
/// without touching any catalog entry.
const CUSTOM_SLOT_ID = "__custom__";

type DownloadRow = LocalLlmDownloadStatus & { bytesPerSec?: number };

export function LocalLlmPanel({
	settings,
	updateSettings,
}: {
	settings: AppSettings;
	updateSettings: (patch: Partial<AppSettings>) => void | Promise<void>;
}) {
	const queryClient = useQueryClient();
	const statusQuery = useQuery({
		queryKey: LOCAL_LLM_STATUS_KEY,
		queryFn: getLocalLlmStatus,
		// Poll always (not just when enabled) so the panel reflects
		// startup errors / spawn-died transitions even while the user
		// is still flipping the toggle.
		refetchInterval: 2000,
	});
	const status = statusQuery.data;
	const catalogQuery = useQuery({
		queryKey: LOCAL_LLM_CATALOG_KEY,
		queryFn: listLocalLlmCatalog,
		staleTime: Number.POSITIVE_INFINITY,
	});
	// Catalog is shared with Voice Pilot — filter out STT entries so the
	// LLM panel only shows chat brains. `kind` is optional on legacy
	// entries, so anything without an explicit `kind` is treated as LLM.
	const catalog = useMemo(
		() =>
			(catalogQuery.data ?? []).filter(
				(entry) => (entry.kind ?? "llm") === "llm",
			),
		[catalogQuery.data],
	);
	const hardwareQuery = useQuery({
		queryKey: LOCAL_LLM_HARDWARE_KEY,
		queryFn: detectLocalLlmHardware,
		staleTime: Number.POSITIVE_INFINITY,
	});
	const recommendedEntryId = hardwareQuery.data?.recommendedEntryId ?? null;

	// Per-entry download state, patched by the streaming Channel.
	const [downloads, setDownloads] = useState<Record<string, DownloadRow>>({});

	useEffect(() => {
		const channel = new Channel<LocalLlmDownloadEvent>();
		let mounted = true;
		channel.onmessage = (event) => {
			if (!mounted) return;
			setDownloads((prev) => applyDownloadEvent(prev, event));
		};
		void subscribeLocalLlmDownloads(channel).then((snapshot) => {
			if (!mounted) return;
			// Merge — channel event may beat IPC reply; prefer the more-advanced row.
			setDownloads((prev) => {
				const next: Record<string, DownloadRow> = { ...prev };
				for (const row of snapshot) {
					const existing = next[row.entryId];
					if (!existing || isSnapshotMoreAdvanced(row, existing)) {
						next[row.entryId] = row;
					}
				}
				return next;
			});
		});
		return () => {
			mounted = false;
		};
	}, []);

	const invalidateStatus = () =>
		queryClient.invalidateQueries({ queryKey: LOCAL_LLM_STATUS_KEY });

	// `hasModel` is the precondition for "toggling on actually does
	// something". A non-empty model setting means either a curated
	// entry was activated, or the user typed something into the
	// Custom model path field. The backend will surface a clearer
	// error via `lastError` if the path turns out to be invalid.
	const hasModel = settings.localLlm.model.trim().length > 0;

	const toggleMutation = useMutation({
		mutationFn: async (enabled: boolean) => {
			await updateSettings({
				localLlm: { ...settings.localLlm, enabled },
			});
			if (!enabled) {
				await stopLocalLlm();
				return;
			}
			if (!hasModel) {
				// No model to load — keep the toggle on as intent, the
				// banner below explains what to do next.
				return;
			}
			// Fire-and-forget. The bundled llama-server's cold-load can
			// take 5–30 s; awaiting it would freeze the toggle and the
			// rest of the panel. The polled status query catches up
			// within ~2 s and renders the real Starting / Running /
			// Stopped state including any error message.
			void startLocalLlm().catch((error) => {
				console.warn("[local-llm] start failed", error);
				invalidateStatus();
			});
		},
		onSettled: invalidateStatus,
	});

	const pending = toggleMutation.isPending;
	const running = Boolean(status?.running);
	const starting = Boolean(status?.starting);

	// Match the currently active model setting to a catalog entry by
	// comparing the resolved file path. The dropdown highlights this
	// entry with an "Active" badge.
	const activeEntryId = useMemo(() => {
		return catalog.find((entry) => {
			const expectedSuffix = `local-llm/models/${entry.files[0]}`;
			return Boolean(status?.model?.endsWith(expectedSuffix));
		})?.id;
	}, [catalog, status?.model]);

	const handleDownload = (entryId: string) => {
		void startLocalLlmDownload(entryId);
	};
	const handlePause = (entryId: string) => {
		void pauseLocalLlmDownload(entryId);
	};
	const handleResume = (entryId: string) => {
		void startLocalLlmDownload(entryId);
	};
	const handleCancel = (entryId: string) => {
		void cancelLocalLlmDownload(entryId);
	};

	// Goes through Rust so persistence + restart stay atomic.
	const commitContextOverride = async (entryId: string, tokens: number) => {
		try {
			await setLocalLlmContextOverride(entryId, tokens);
		} catch (error) {
			console.warn("[local-llm] context override commit failed", error);
		}
		invalidateStatus();
	};
	// Two-step delete for already-downloaded models. Mid-download Cancel
	// reuses `handleCancel` directly — there's nothing on disk to lose.
	const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
	const deleteTargetEntry = useMemo(
		() => catalog.find((entry) => entry.id === deleteTargetId) ?? null,
		[catalog, deleteTargetId],
	);
	const handleDelete = (entryId: string) => {
		setDeleteTargetId(entryId);
	};
	const confirmDelete = () => {
		if (!deleteTargetId) return;
		void cancelLocalLlmDownload(deleteTargetId);
		setDeleteTargetId(null);
	};

	// Custom Model Path input is a *display-only* derivation: it only
	// echoes `settings.localLlm.model` when the active path didn't come
	// from a curated catalog entry. Otherwise the user sees just the
	// placeholder, which is what they want when they're using a
	// curated pick — the custom field shouldn't pretend to be edited.
	const customPathValue = activeEntryId ? "" : settings.localLlm.model;

	// Custom GGUFs aren't in our catalog, so we don't know their trained
	// max / KV cache shape ahead of time. The inspect IPC reads the
	// GGUF header on disk and surfaces both. Disabled when the user is
	// running a catalog entry — that path already has the metadata
	// compiled in.
	const inspectQuery = useQuery({
		queryKey: ["localLlmInspect", customPathValue] as const,
		queryFn: () => inspectLocalLlmModel(customPathValue),
		enabled: customPathValue.trim().length > 0,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const customInspect = inspectQuery.data ?? null;
	const customOverrideKey = customPathValue
		? `custom:${customPathValue}`
		: null;

	// `customActive` = the user has typed a valid GGUF path that the
	// inspect IPC could parse. When that's the case the picker's default
	// focus shifts to the Custom slot (above any catalog fallback) so
	// the panel reflects "this is the model in use" rather than
	// pretending some unrelated catalog entry is selected.
	const customActive = customPathValue.length > 0 && customInspect !== null;
	const customBasename = useMemo(() => {
		if (!customPathValue) return null;
		const tail = customPathValue.split("/").pop();
		return tail && tail.length > 0 ? tail : customPathValue;
	}, [customPathValue]);

	// Dropdown selection: active catalog entry > custom (when valid) >
	// recommended > first. Users can pick a different entry to inspect /
	// download without affecting which one is "Active" (that's a
	// separate `activateLocalLlmModel` action).
	const defaultSelectedId = useMemo(() => {
		if (activeEntryId) return activeEntryId;
		if (customActive) return CUSTOM_SLOT_ID;
		if (recommendedEntryId) return recommendedEntryId;
		if (catalog.length > 0) return catalog[0].id;
		return null;
	}, [catalog, activeEntryId, customActive, recommendedEntryId]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const effectiveSelectedId = selectedId ?? defaultSelectedId;
	const isCustomSelected = effectiveSelectedId === CUSTOM_SLOT_ID;
	const selectedEntry = isCustomSelected
		? null
		: (catalog.find((entry) => entry.id === effectiveSelectedId) ?? null);

	// Selection = activation, but ONLY for entries the user explicitly
	// picked from the dropdown. The trigger preview falls back to
	// `defaultSelectedId` on mount; without this guard, opening the
	// panel while running a custom GGUF + having a recommended catalog
	// entry already on disk would silently activate the recommended
	// entry and wipe out the custom path.
	useEffect(() => {
		if (!selectedId) return;
		// Custom slot is just a UI focus — there's no catalog id to
		// activate. Custom paths get committed through the dedicated
		// Custom Model Path input (startLocalLlm in onCommit).
		if (selectedId === CUSTOM_SLOT_ID) return;
		if (selectedId === activeEntryId) return;
		const row = downloads[selectedId];
		if (row?.state !== "downloaded") return;
		void activateLocalLlmModel(selectedId).then(() => {
			invalidateStatus();
		});
	}, [selectedId, activeEntryId, downloads]);

	// Catalog mode: when the selected entry is already on disk, ask the
	// backend to read its GGUF metadata so the panel shows the same
	// numbers it would for the same model pasted as a custom path. The
	// catalog's hand-coded kv_bytes_per_token / model_max_context_tokens
	// are estimates; GGUF is the source of truth.
	const selectedDownloadState = selectedEntry
		? (downloads[selectedEntry.id]?.state ?? "not_downloaded")
		: null;
	const catalogInspectQuery = useQuery({
		queryKey: ["localLlmCatalogInspect", selectedEntry?.id] as const,
		queryFn: () =>
			selectedEntry
				? inspectLocalLlmCatalogEntry(selectedEntry.id)
				: Promise.resolve(null),
		enabled: selectedEntry !== null && selectedDownloadState === "downloaded",
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const catalogInspect = catalogInspectQuery.data ?? null;

	// Friendly label of whatever the server has loaded right now.
	// Renders as a secondary pill next to "Running" so the user can
	// see at a glance which model is live.
	const activeModelLabel = useMemo(() => {
		if (!status?.model) return null;
		const fromCatalog = catalog.find((entry) => entry.id === activeEntryId);
		if (fromCatalog) return fromCatalog.label;
		// Custom path — fall back to the file's basename so a long
		// absolute path doesn't overflow the header.
		const tail = status.model.split("/").pop();
		return tail && tail.length > 0 ? tail : null;
	}, [status?.model, catalog, activeEntryId]);
	// Runtime context window the server is actually serving. Read
	// straight from status (the backend's `-c` value), NOT from the
	// model's theoretical max — those two are different and showing
	// the model max is a footgun (user sees "128K" but the running
	// llama-server caps at whatever we pass via `-c`).
	const activeContextTokens = status?.contextSize ?? null;

	// What `-c` value WOULD we use for the currently dropdown-selected
	// entry? `catalogInspect` is required: we no longer trust the
	// catalog's hand-coded kv/context estimates — the picker stays
	// blank until the GGUF is on disk and inspected for real.
	const contextTokensForSelected = useMemo(() => {
		if (!selectedEntry || !catalogInspect) return null;
		const override = settings.localLlm.contextOverrides?.[selectedEntry.id];
		if (typeof override === "number" && override > 0) return override;
		return catalogInspect.defaultContextTokens;
	}, [selectedEntry, catalogInspect, settings.localLlm.contextOverrides]);

	const contextTokensForCustom = useMemo(() => {
		if (!customInspect || !customOverrideKey) return null;
		const override = settings.localLlm.contextOverrides?.[customOverrideKey];
		if (typeof override === "number" && override > 0) return override;
		return customInspect.defaultContextTokens;
	}, [customInspect, customOverrideKey, settings.localLlm.contextOverrides]);

	const activeOrPaused = useMemo(() => {
		const rows: Array<{ entry: LocalLlmCatalogEntry; download: DownloadRow }> =
			[];
		for (const entry of catalog) {
			const row = downloads[entry.id];
			if (row && (row.state === "downloading" || row.state === "paused")) {
				rows.push({ entry, download: row });
			}
		}
		return rows;
	}, [catalog, downloads]);

	return (
		<div className="flex flex-col gap-3 py-5">
			{/* Header row — title + release badge on the LEFT, master
			    enable Switch on the RIGHT. Description stacks below.
			    When the switch is off everything else hides — the panel
			    collapses to just this header so it stays compact. */}
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-snug text-foreground">
						<span className="min-w-0">
							<I18nText source={"Local LLM"} />
						</span>
						<SettingsReleaseBadge marker={{ kind: "feature" }} />
					</div>
					<p className="mt-1 text-[12px] leading-snug text-muted-foreground">
						<I18nText
							source={
								"Powers session title / branch name generation and Smart Triage — both run entirely on your device."
							}
						/>
					</p>
				</div>
				<Switch
					checked={settings.localLlm.enabled}
					disabled={pending}
					onCheckedChange={(enabled) => toggleMutation.mutate(enabled)}
				/>
			</div>
			{settings.localLlm.enabled ? (
				<div className="flex w-full flex-col gap-3">
					<StatusHeader
						hasModel={hasModel}
						running={running}
						starting={starting}
						endpoint={status?.endpoint ?? null}
						activeModelLabel={activeModelLabel}
						activeContextTokens={activeContextTokens}
					/>
					{!hasModel ? (
						<NoticeBanner tone="warning">
							<I18nText
								source={
									"No model selected. Pick one from the Models dropdown below to start — including Custom if you already have a GGUF on disk."
								}
							/>
						</NoticeBanner>
					) : null}

					{status?.lastError && !starting ? (
						<NoticeBanner
							tone="error"
							icon={<AlertCircle className="size-3.5" />}
						>
							{status.lastError}
						</NoticeBanner>
					) : null}

					<ModelsSection
						catalog={catalog}
						loading={catalogQuery.isLoading}
						selectedCatalogEntry={selectedEntry}
						isCustomSelected={isCustomSelected}
						customBasename={customBasename}
						customIsActive={!activeEntryId && customActive && running}
						activeEntryId={activeEntryId ?? null}
						recommendedEntryId={recommendedEntryId}
						downloads={downloads}
						onSelect={setSelectedId}
						onDownload={handleDownload}
						onResume={handleResume}
						onCancel={handleCancel}
						onDelete={handleDelete}
					/>

					{activeOrPaused.length > 0 ? (
						<DownloadsSection
							rows={activeOrPaused}
							onPause={handlePause}
							onResume={handleResume}
							onCancel={handleCancel}
						/>
					) : null}

					{isCustomSelected ? (
						<CustomModelPathSection
							value={customPathValue}
							disabled={pending}
							onCommit={(path) => {
								if (path !== settings.localLlm.model) {
									void updateSettings({
										localLlm: { ...settings.localLlm, model: path },
									});
								}
								if (path.length === 0) return;
								// Kick the server to pick up the new path. Idempotent
								// on the backend: same path while running = no-op.
								void startLocalLlm().catch((error) => {
									console.warn(
										"[local-llm] start after custom path commit failed",
										error,
									);
									invalidateStatus();
								});
							}}
						/>
					) : null}

					{isCustomSelected && customInspect ? (
						// Picker is focused on the Custom slot — slider drives
						// the override keyed by `custom:<absolute-path>`.
						<ContextSelector
							target={{
								id: customOverrideKey ?? `custom:${customPathValue}`,
								modelMaxContextTokens: customInspect.contextLength,
								kvBytesPerToken: customInspect.kvBytesPerToken,
								// We don't track the GGUF size in inspect (it's not
								// in the header). Pass 0 so the fit estimate is
								// slightly generous; llama-server caps allocation
								// itself so this can't OOM.
								modelBytes: 0,
							}}
							totalRamGb={hardwareQuery.data?.totalRamGb ?? null}
							currentTokens={contextTokensForCustom}
							defaultTokens={customInspect.defaultContextTokens}
							onCommit={commitContextOverride}
						/>
					) : selectedEntry && catalogInspect ? (
						// Catalog entry, downloaded, GGUF inspected — slider
						// uses real model metadata. If the entry isn't on
						// disk yet (or the file moved / corrupted),
						// `catalogInspect` is null and we render nothing.
						// Pick the entry from the dropdown and the slider
						// re-appears once it's downloaded.
						<ContextSelector
							target={{
								id: selectedEntry.id,
								modelMaxContextTokens: catalogInspect.contextLength,
								kvBytesPerToken: catalogInspect.kvBytesPerToken,
								modelBytes: localLlmEntryTotalBytes(selectedEntry),
							}}
							totalRamGb={hardwareQuery.data?.totalRamGb ?? null}
							currentTokens={contextTokensForSelected}
							defaultTokens={catalogInspect.defaultContextTokens}
							onCommit={commitContextOverride}
						/>
					) : null}
				</div>
			) : null}
			<ConfirmDialog
				open={deleteTargetId !== null}
				onOpenChange={(open) => {
					if (!open) setDeleteTargetId(null);
				}}
				title="Delete this model?"
				description={
					deleteTargetEntry ? (
						<>
							This will remove{" "}
							<span className="font-medium text-foreground">
								{deleteTargetEntry.label}
							</span>{" "}
							({formatBytes(localLlmEntryTotalBytes(deleteTargetEntry))}) from
							disk. You'll have to download it again to use it.
						</>
					) : (
						"This will remove the model from disk."
					)
				}
				confirmLabel="Delete"
				onConfirm={confirmDelete}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Status row — dot pill (Off / Starting / Running / Stopped / No model)
// + active-model + context pills inline. The master toggle lives in the
// panel header above; this row is purely informational.
// ---------------------------------------------------------------------------

function StatusHeader({
	hasModel,
	running,
	starting,
	endpoint,
	activeModelLabel,
	activeContextTokens,
}: {
	hasModel: boolean;
	running: boolean;
	starting: boolean;
	endpoint: string | null;
	activeModelLabel: string | null;
	activeContextTokens: number | null;
}) {
	let label: string;
	let dotClass: string;
	let showSpinner = false;
	let showEndpoint = false;
	if (starting) {
		label = "Starting";
		dotClass = "bg-amber-500";
		showSpinner = true;
	} else if (running) {
		label = "Running";
		dotClass = "bg-emerald-500";
		showEndpoint = true;
	} else if (!hasModel) {
		label = "No model";
		dotClass = "bg-amber-500";
	} else {
		label = "Stopped";
		dotClass = "bg-destructive";
	}

	return (
		<div className="flex min-w-0 items-center gap-2">
			<Cpu className="size-4 shrink-0 text-muted-foreground" />
			<div className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-[12px]">
				{/* Fixed wrapper around the spinner/dot so the Starting→Running
				    swap doesn't grow the pill by the 4 px difference between
				    `size-3` (loader) and `size-2` (dot). */}
				<span
					className="flex size-3 shrink-0 items-center justify-center"
					aria-hidden
				>
					{showSpinner ? (
						<Loader2 className="size-3 animate-spin text-muted-foreground" />
					) : (
						<span className={cn("size-2 rounded-full", dotClass)} />
					)}
				</span>
				<span className="font-medium text-foreground">{label}</span>
				{showEndpoint && endpoint ? (
					<span
						className="font-mono text-[11px] tabular-nums text-muted-foreground/80"
						title={stripScheme(endpoint)}
					>
						{formatEndpointPort(endpoint)}
					</span>
				) : null}
			</div>
			{running && activeModelLabel ? (
				<span className="flex shrink-0 items-center rounded-md border border-border bg-background px-2 py-0.5 text-[12px] font-medium text-foreground">
					{activeModelLabel}
				</span>
			) : null}
			{running && activeContextTokens ? (
				<span className="flex shrink-0 items-center rounded-md border border-border bg-background px-2 py-0.5 text-[12px] font-medium tabular-nums text-foreground">
					{formatContext(activeContextTokens)}
				</span>
			) : null}
		</div>
	);
}

function stripScheme(url: string): string {
	return url.replace(/^https?:\/\//, "");
}

/** Pull the port out of `http://127.0.0.1:52651` → `:52651`. The full
 *  address is always loopback so the host part is noise; the port is
 *  the only thing the user might need (e.g. to curl the endpoint). */
function formatEndpointPort(endpoint: string): string {
	try {
		const port = new URL(endpoint).port;
		if (port) return `:${port}`;
	} catch {
		// Fall through to the raw string if URL parsing fails.
	}
	return stripScheme(endpoint);
}

// ---------------------------------------------------------------------------
// Notice banner (warning / error).
// ---------------------------------------------------------------------------

function NoticeBanner({
	tone,
	icon,
	children,
}: {
	tone: "warning" | "error";
	icon?: React.ReactNode;
	children: React.ReactNode;
}) {
	const localizedChildren = useLocalizedNode(children);
	const palette =
		tone === "error"
			? "border-destructive/30 bg-destructive/5 text-destructive"
			: "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400";
	return (
		<div
			className={cn(
				"flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]",
				palette,
			)}
		>
			{icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
			<span className="leading-5">{localizedChildren}</span>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Models section — dropdown picker. Trigger shows the currently
// selected entry; opening lets the user swap focus to any other
// catalog entry. The contextual CTA row below the trigger drives
// download / use / delete actions for whichever entry is selected.
// ---------------------------------------------------------------------------

function ModelsSection({
	catalog,
	loading,
	selectedCatalogEntry,
	isCustomSelected,
	customBasename,
	customIsActive,
	activeEntryId,
	recommendedEntryId,
	downloads,
	onSelect,
	onDownload,
	onResume,
	onCancel,
	onDelete,
}: {
	catalog: LocalLlmCatalogEntry[];
	loading: boolean;
	selectedCatalogEntry: LocalLlmCatalogEntry | null;
	/// `true` when the picker is focused on the Custom slot rather than
	/// any catalog entry.
	isCustomSelected: boolean;
	/// File basename to render in the Custom slot (path tail). Null when
	/// no Custom path is set.
	customBasename: string | null;
	/// `true` when the running server is loaded with the Custom path
	/// (not a catalog entry). Used to flag the Custom slot as live.
	customIsActive: boolean;
	activeEntryId: string | null;
	recommendedEntryId: string | null;
	downloads: Record<string, DownloadRow>;
	/// Receives a catalog id or `CUSTOM_SLOT_ID`.
	onSelect: (id: string) => void;
	onDownload: (id: string) => void;
	onResume: (id: string) => void;
	onCancel: (id: string) => void;
	onDelete: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);

	if (loading) {
		return (
			<div className="grid gap-1.5">
				<Label className="text-[12px] text-muted-foreground">Models</Label>
				<div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
					<Loader2 className="size-3 animate-spin" />
					<I18nText source={"Loading models…"} />
				</div>
			</div>
		);
	}
	if (!selectedCatalogEntry && !isCustomSelected) return null;

	const selectedState =
		selectedCatalogEntry !== null
			? (downloads[selectedCatalogEntry.id]?.state ?? "not_downloaded")
			: "not_downloaded";
	const isSelectedActive =
		selectedCatalogEntry !== null && activeEntryId === selectedCatalogEntry.id;
	const isSelectedRecommended =
		selectedCatalogEntry !== null &&
		recommendedEntryId === selectedCatalogEntry.id;

	return (
		<div className="grid gap-1.5">
			<Label className="text-[12px] text-muted-foreground">Models</Label>
			<div className="flex items-center gap-1.5">
				<DropdownMenu open={open} onOpenChange={setOpen}>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							className="flex h-8 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 text-[12px] hover:bg-muted/40"
						>
							{isCustomSelected ? (
								<>
									<div className="flex min-w-0 items-center gap-1.5">
										<span className="truncate font-medium text-foreground">
											<I18nText source={"Custom"} />
										</span>
										{customBasename ? (
											<span className="truncate text-muted-foreground">
												{customBasename}
											</span>
										) : null}
									</div>
									<div className="flex shrink-0 items-center gap-2">
										{customIsActive ? (
											<Badge className="rounded-full border-foreground/30 bg-foreground/10 px-1.5 py-0 text-[10px] font-medium text-foreground">
												Active
											</Badge>
										) : null}
										<ChevronDown
											className="size-3 text-muted-foreground"
											strokeWidth={2}
										/>
									</div>
								</>
							) : selectedCatalogEntry ? (
								<>
									<div className="flex min-w-0 items-center gap-1.5">
										<span className="truncate font-medium text-foreground">
											{selectedCatalogEntry.label}
										</span>
										<QuantBadge quant={selectedCatalogEntry.quant} />
									</div>
									<div className="flex shrink-0 items-center gap-2">
										<StateIndicator
											state={selectedState}
											active={isSelectedActive}
											recommended={isSelectedRecommended}
										/>
										{/* Right-align in a fixed slot so pill swaps
										    (Downloading ↔ Paused ↔ Downloaded ↔ none)
										    don't drag the bytes / chevron horizontally. */}
										<span className="min-w-[3.5rem] text-right tabular-nums text-muted-foreground">
											{formatBytes(
												localLlmEntryTotalBytes(selectedCatalogEntry),
											)}
										</span>
										<ChevronDown
											className="size-3 text-muted-foreground"
											strokeWidth={2}
										/>
									</div>
								</>
							) : null}
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="start"
						side="bottom"
						sideOffset={4}
						className="min-w-[440px]"
					>
						<DropdownMenuItem
							onClick={() => onSelect(CUSTOM_SLOT_ID)}
							className="flex flex-col items-start gap-0.5 py-2"
						>
							<div className="flex w-full items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-1.5">
									{isCustomSelected ? (
										<Check className="size-3 shrink-0 text-foreground" />
									) : (
										<span className="size-3 shrink-0" />
									)}
									<span className="truncate font-medium text-foreground">
										Custom
									</span>
									{customBasename ? (
										<span className="truncate text-muted-foreground">
											{customBasename}
										</span>
									) : null}
								</div>
								<div className="flex shrink-0 items-center gap-2">
									{customIsActive ? (
										<Badge className="rounded-full border-foreground/30 bg-foreground/10 px-1.5 py-0 text-[10px] font-medium text-foreground">
											Active
										</Badge>
									) : null}
								</div>
							</div>
							<p className="pl-[18px] text-[11px] leading-4 text-muted-foreground">
								Use your own GGUF file. Set the path below.
							</p>
						</DropdownMenuItem>
						{catalog.map((entry) => {
							const entryState = downloads[entry.id]?.state ?? "not_downloaded";
							const entryActive = activeEntryId === entry.id;
							const entryRecommended = recommendedEntryId === entry.id;
							const isThisRowChecked =
								!isCustomSelected && entry.id === selectedCatalogEntry?.id;
							return (
								<DropdownMenuItem
									key={entry.id}
									onClick={() => onSelect(entry.id)}
									className="flex flex-col items-start gap-0.5 py-2"
								>
									<div className="flex w-full items-center justify-between gap-2">
										<div className="flex min-w-0 items-center gap-1.5">
											{isThisRowChecked ? (
												<Check className="size-3 shrink-0 text-foreground" />
											) : (
												<span className="size-3 shrink-0" />
											)}
											<span className="truncate font-medium text-foreground">
												{entry.label}
											</span>
											<QuantBadge quant={entry.quant} />
										</div>
										<div className="flex shrink-0 items-center gap-2">
											<StateIndicator
												state={entryState}
												active={entryActive}
												recommended={entryRecommended}
											/>
											<span className="min-w-[3.5rem] text-right tabular-nums text-muted-foreground">
												{formatBytes(localLlmEntryTotalBytes(entry))}
											</span>
										</div>
									</div>
									<p className="pl-[18px] text-[11px] leading-4 text-muted-foreground">
										{entry.blurb}
									</p>
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>
				{/* Contextual download / delete buttons only apply to catalog
				    entries — Custom path activation goes through the
				    Custom Model Path input's onCommit. */}
				{selectedCatalogEntry && !isCustomSelected ? (
					<ContextualActions
						state={selectedState}
						active={isSelectedActive}
						optionalComplete={
							downloads[selectedCatalogEntry.id]?.optionalComplete ?? true
						}
						onDownload={() => onDownload(selectedCatalogEntry.id)}
						onResume={() => onResume(selectedCatalogEntry.id)}
						onCancel={() => onCancel(selectedCatalogEntry.id)}
						onDelete={() => onDelete(selectedCatalogEntry.id)}
					/>
				) : null}
			</div>
		</div>
	);
}

function QuantBadge({ quant }: { quant: string }) {
	return (
		<Badge
			variant="outline"
			className="rounded-sm px-1 py-0 text-[10px] font-normal text-muted-foreground"
		>
			{quant}
		</Badge>
	);
}

const GB = 1_073_741_824; // 1024 ** 3
const TIGHT_RAM_FRACTION = 0.7;
const OVER_RAM_FRACTION = 0.9;
const CONTEXT_STEP = 4096;
const MIN_CONTEXT_TOKENS = 4096;

function snapContext(value: number, max: number): number {
	const snapped = Math.round(value / CONTEXT_STEP) * CONTEXT_STEP;
	return Math.min(Math.max(snapped, MIN_CONTEXT_TOKENS), max);
}

/** Slider for the runtime `-c` value, with help tooltip + live KV
 *  cache readout. Dragging changes the local preview (pending);
 *  Apply commits through the regular settings pipeline so React state
 *  and backend both update + the server restarts if needed.
 *
 *  Every numeric input is GGUF-derived truth from the inspect IPC —
 *  callers gate rendering on inspect succeeding so we never paint
 *  catalog estimates here. */
type ContextSelectorTarget = {
	/// Settings-map key the override is persisted under. Catalog entries
	/// use their `id`; custom paths use `custom:<absolute-path>` (matches
	/// the Rust-side `custom_override_key`).
	id: string;
	modelMaxContextTokens: number;
	kvBytesPerToken: number;
	/// Bytes of weights on disk. Catalog reports it from the entry; for
	/// custom paths the caller passes 0 (we under-estimate footprint but
	/// never over-budget — llama-server caps allocation anyway).
	modelBytes: number;
};

function ContextSelector({
	target,
	totalRamGb,
	currentTokens,
	defaultTokens,
	onCommit,
}: {
	target: ContextSelectorTarget;
	totalRamGb: number | null;
	currentTokens: number | null;
	/// Hardware-aware default from the inspect IPC. The slider's Reset
	/// affordance snaps back to this.
	defaultTokens: number;
	onCommit: (entryId: string, tokens: number) => void;
}) {
	const { t } = useI18n();
	const maxTokens = target.modelMaxContextTokens;
	const [pending, setPending] = useState<number | null>(null);

	useEffect(() => {
		// Drop the preview whenever the committed value updates (apply
		// succeeded, or user switched to a different model).
		setPending(null);
	}, [currentTokens, target.id]);

	if (!currentTokens) return null;

	const effective = pending ?? currentTokens;
	const hasPending = pending !== null && pending !== currentTokens;
	const totalRamBytes = totalRamGb ? totalRamGb * GB : null;
	const kvBytes = effective * target.kvBytesPerToken;
	const totalBytes = target.modelBytes + kvBytes;
	const fit: "ok" | "tight" | "over" =
		totalRamBytes === null
			? "ok"
			: totalBytes > totalRamBytes * OVER_RAM_FRACTION
				? "over"
				: totalBytes > totalRamBytes * TIGHT_RAM_FRACTION
					? "tight"
					: "ok";

	const fitColor =
		fit === "over"
			? "text-destructive"
			: fit === "tight"
				? "text-amber-600 dark:text-amber-400"
				: "text-muted-foreground";
	const canReset = pending !== null ? true : currentTokens !== defaultTokens;
	const canApply = hasPending && fit !== "over";

	// CSS grid with explicit column widths. Every left-side slot is
	// fixed so dragging the slider only swaps text inside slots —
	// nothing moves. Column 5 is a `1fr` spacer that absorbs slack,
	// keeping the action buttons pinned to the right while the memory
	// readout (col 4) stays at its natural `auto` width and never gets
	// truncated.
	return (
		<div className="grid grid-cols-[auto_144px_44px_auto_1fr_auto] items-center gap-3 text-[12px]">
			<div className="flex shrink-0 items-center gap-1">
				<Label className="text-[12px] text-muted-foreground">Context</Label>
				{/* SettingsDialog renders outside AppShell's TooltipProvider. */}
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="cursor-help text-muted-foreground hover:text-foreground"
								aria-label={t("What is context size?")}
							>
								<CircleHelp className="size-3.5" strokeWidth={1.8} />
							</button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							className="max-w-[280px] text-[11px] leading-5"
						>
							The total token budget for input + generated output combined.
							Bigger context lets you send longer prompts but uses more RAM and
							takes longer to start.
							<br />
							<br />
							If you're unsure, the default ({formatContext(defaultTokens)}) is
							sized to fit your hardware — leave it as is.
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>

			<Slider
				value={[effective]}
				min={MIN_CONTEXT_TOKENS}
				max={maxTokens}
				step={CONTEXT_STEP}
				onValueChange={(values) => {
					const raw = values[0] ?? currentTokens;
					setPending(snapContext(raw, maxTokens));
				}}
			/>

			{/* Current value — right-aligned in a 44 px slot so even
			    "256K" still anchors its K to the same x-position the
			    "32K" K sits at. Digits grow leftward, slider stays put. */}
			<span
				className={cn(
					"text-right font-medium tabular-nums",
					hasPending ? "text-primary" : "text-foreground",
				)}
			>
				{formatContext(effective)}
			</span>

			{/* Memory readout — `auto` column + `whitespace-nowrap` so the
			    string is always shown in full. Compact format drops the
			    redundant middle "GB" so "KV 12.9 GB · 33.9/48 GB" reads
			    cleanly. Color carries the fit state (no extra warn text
			    so the width doesn't change character by character). */}
			<span className={cn("whitespace-nowrap tabular-nums", fitColor)}>
				<I18nText source={"KV"} /> {formatBytes(kvBytes)}
				{totalRamGb
					? ` · ${formatBytes(totalBytes).replace(" GB", "")}/${totalRamGb} GB`
					: ""}
			</span>

			{/* `1fr` spacer absorbs leftover width so buttons stick to
			    the right edge without forcing the memory column to
			    shrink. */}
			<div aria-hidden />

			{/* Actions — both buttons ALWAYS rendered, just disabled
			    when not applicable. Reset has a dual semantic (discard
			    pending preview OR revert committed override); its
			    tooltip clarifies which one will fire. */}
			<div className="flex shrink-0 items-center gap-1.5">
				<Button
					type="button"
					size="xs"
					variant="ghost"
					disabled={!canReset}
					onClick={() => {
						if (pending !== null) {
							setPending(null);
							return;
						}
						if (currentTokens !== defaultTokens) {
							onCommit(target.id, defaultTokens);
						}
					}}
					title={
						pending !== null ? "Discard pending change" : "Reset to default"
					}
				>
					<Undo2 className="size-3" strokeWidth={1.8} />
					Reset
				</Button>
				<Button
					type="button"
					size="xs"
					variant="default"
					disabled={!canApply}
					onClick={() => {
						if (pending !== null) onCommit(target.id, pending);
					}}
				>
					Apply
				</Button>
			</div>
		</div>
	);
}

/**
 * One status indicator per row. Priority: Active (filled primary pill)
 * > Downloading / Paused / Failed (filled tinted pill) > Downloaded
 * (small green check icon, no text — saves horizontal space) >
 * Recommended (filled sky pill).
 */
function StateIndicator({
	state,
	active,
	recommended,
}: {
	state: LocalLlmDownloadStatus["state"];
	active: boolean;
	recommended: boolean;
}) {
	// Pill rules:
	//   - downloaded → "Downloaded" pill (explicit "it's here" signal)
	//   - not_downloaded → no pill (silence by default; just Recommended)
	//   - in-flight states (downloading / paused / failed) → their own pill
	// `active` isn't a pill — the panel header carries the live-running
	// signal so the dropdown row stays uncluttered.
	void active;
	if (state === "downloading") {
		return (
			<Badge className="rounded-full border-foreground/30 bg-foreground/10 px-1.5 py-0 text-[10px] font-medium text-foreground">
				Downloading
			</Badge>
		);
	}
	if (state === "paused") {
		return (
			<Badge className="rounded-full border-muted-foreground/30 bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
				Paused
			</Badge>
		);
	}
	if (state === "failed") {
		return (
			<Badge className="rounded-full border-destructive/30 bg-destructive/15 px-1.5 py-0 text-[10px] font-medium text-destructive">
				Failed
			</Badge>
		);
	}
	if (state === "downloaded") {
		return (
			<Badge className="rounded-full border-muted-foreground/30 bg-muted/40 px-1.5 py-0 text-[10px] font-medium text-muted-foreground">
				Downloaded
			</Badge>
		);
	}
	// not_downloaded — Recommended is the only pill that surfaces.
	if (!recommended) return null;
	return (
		<Badge className="rounded-full border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
			Recommended
		</Badge>
	);
}

/** CTAs live on their own row below the dropdown so the trigger never
 *  truncates and Delete (which is destructive) gets the visual weight
 *  it deserves. */
function ContextualActions({
	state,
	active,
	optionalComplete,
	onDownload,
	onResume,
	onCancel,
	onDelete,
}: {
	state: LocalLlmDownloadStatus["state"];
	active: boolean;
	/** `false` when essentials are on disk but an optional companion
	 *  (e.g. the vision mmproj) is still missing — surfaces a top-up
	 *  affordance next to Delete so the user doesn't lose the main
	 *  weights to a redownload. */
	optionalComplete: boolean;
	onDownload: () => void;
	onResume: () => void;
	onCancel: () => void;
	onDelete: () => void;
}) {
	// Selection = activation, so we never render "Use this model" any
	// more. The only contextual CTA on the row is whatever's
	// reasonable for the entry's current state:
	//   - downloaded → Delete (red), plus Add vision when mmproj missing
	//   - downloading → Cancel (red)
	//   - paused → Resume (default) + Cancel (red)
	//   - failed → Retry (default) + Cancel (red)
	//   - not_downloaded → Download (default)
	// All buttons sized `sm` (h-7) to match the dropdown trigger.
	void active;
	if (state === "downloaded") {
		return (
			<>
				{optionalComplete ? null : (
					<Button
						type="button"
						size="sm"
						variant="default"
						onClick={onDownload}
					>
						<Download className="size-3.5" strokeWidth={1.8} />
						Add vision
					</Button>
				)}
				<Button
					type="button"
					size="sm"
					variant="destructive"
					onClick={onDelete}
				>
					<Trash2 className="size-3.5" strokeWidth={1.8} />
					Delete
				</Button>
			</>
		);
	}
	if (state === "downloading") {
		return (
			<Button type="button" size="sm" variant="destructive" onClick={onCancel}>
				<X className="size-3.5" strokeWidth={1.8} />
				Cancel
			</Button>
		);
	}
	if (state === "paused") {
		return (
			<>
				<Button type="button" size="sm" variant="default" onClick={onResume}>
					<Play className="size-3.5" strokeWidth={1.8} />
					Resume
				</Button>
				<Button
					type="button"
					size="sm"
					variant="destructive"
					onClick={onCancel}
				>
					<X className="size-3.5" strokeWidth={1.8} />
					Cancel
				</Button>
			</>
		);
	}
	if (state === "failed") {
		return (
			<>
				<Button type="button" size="sm" variant="default" onClick={onDownload}>
					<RotateCcw className="size-3.5" strokeWidth={1.8} />
					Retry
				</Button>
				<Button
					type="button"
					size="sm"
					variant="destructive"
					onClick={onCancel}
				>
					<X className="size-3.5" strokeWidth={1.8} />
					Cancel
				</Button>
			</>
		);
	}
	return (
		<Button type="button" size="sm" variant="default" onClick={onDownload}>
			<Download className="size-3.5" strokeWidth={1.8} />
			Download
		</Button>
	);
}

// ---------------------------------------------------------------------------
// Downloads section — only when there are in-flight or paused rows.
// ---------------------------------------------------------------------------

function DownloadsSection({
	rows,
	onPause,
	onResume,
	onCancel,
}: {
	rows: Array<{ entry: LocalLlmCatalogEntry; download: DownloadRow }>;
	onPause: (id: string) => void;
	onResume: (id: string) => void;
	onCancel: (id: string) => void;
}) {
	return (
		<div className="grid gap-2 rounded-md border border-border/50 bg-muted/20 p-3">
			<div className="text-[11px] uppercase tracking-wide text-muted-foreground">
				<I18nText source={"Downloads"} />
			</div>
			<div className="grid gap-3">
				{rows.map(({ entry, download }) => (
					<DownloadRowView
						key={entry.id}
						entry={entry}
						download={download}
						onPause={() => onPause(entry.id)}
						onResume={() => onResume(entry.id)}
						onCancel={() => onCancel(entry.id)}
					/>
				))}
			</div>
		</div>
	);
}

function DownloadRowView({
	entry,
	download,
	onPause,
	onResume,
	onCancel,
}: {
	entry: LocalLlmCatalogEntry;
	download: DownloadRow;
	onPause: () => void;
	onResume: () => void;
	onCancel: () => void;
}) {
	const paused = download.state === "paused";
	return (
		<div className="grid gap-1.5 text-[12px]">
			<div className="flex min-w-0 items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className="truncate font-medium text-foreground">
						{entry.label}
					</span>
					<QuantBadge quant={entry.quant} />
				</div>
				<div className="flex shrink-0 items-center gap-1.5">
					{paused ? (
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={onResume}
						>
							<Play className="size-3" strokeWidth={1.8} />
							Resume
						</Button>
					) : (
						<Button type="button" size="xs" variant="outline" onClick={onPause}>
							<Pause className="size-3" strokeWidth={1.8} />
							Pause
						</Button>
					)}
					<Button type="button" size="xs" variant="outline" onClick={onCancel}>
						<X className="size-3" strokeWidth={1.8} />
						Cancel
					</Button>
				</div>
			</div>
			<DownloadProgress
				downloaded={download.downloaded}
				total={download.total}
				bytesPerSec={download.bytesPerSec ?? 0}
				paused={paused}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Custom model path.
// ---------------------------------------------------------------------------

function CustomModelPathSection({
	value,
	disabled,
	onCommit,
}: {
	value: string;
	disabled: boolean;
	/** Fired on blur / Enter with the trimmed path. Parent persists it
	 *  and kicks the server. */
	onCommit: (path: string) => void;
}) {
	const { t } = useI18n();
	// Local draft — avoid round-tripping through settings reload while typing.
	const [draft, setDraft] = useState(value);
	const inputRef = useRef<HTMLInputElement>(null);
	// Re-sync only when not focused.
	useEffect(() => {
		if (document.activeElement !== inputRef.current) {
			setDraft(value);
		}
	}, [value]);

	const commit = () => {
		const trimmed = draft.trim();
		if (trimmed !== draft) setDraft(trimmed);
		onCommit(trimmed);
	};

	return (
		<div className="grid gap-1.5">
			<div className="flex items-center gap-1">
				<Label
					htmlFor="local-llm-model"
					className="text-[12px] text-muted-foreground"
				>
					Custom model path
				</Label>
				{/* SettingsDialog renders outside AppShell's TooltipProvider. */}
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="cursor-help text-muted-foreground hover:text-foreground"
								aria-label={t("About custom model path")}
							>
								<CircleHelp className="size-3.5" strokeWidth={1.8} />
							</button>
						</TooltipTrigger>
						<TooltipContent
							side="top"
							className="max-w-[260px] text-[11px] leading-5"
						>
							{/* Wrapped in <span> so the inline <code> doesn't split
							    text into multiple flex items in TooltipContent's
							    inline-flex layout. */}
							<span>
								Point this at a <code>.gguf</code> you've downloaded yourself.
								Curated models above take precedence — clear this field to
								switch back to the picker.
							</span>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
			<Input
				id="local-llm-model"
				ref={inputRef}
				value={draft}
				placeholder="/path/to/model.gguf"
				disabled={disabled}
				onChange={(event) => setDraft(event.currentTarget.value)}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						event.currentTarget.blur();
					}
				}}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Atoms.
// ---------------------------------------------------------------------------

function DownloadProgress({
	downloaded,
	total,
	bytesPerSec,
	paused,
}: {
	downloaded: number;
	total: number;
	bytesPerSec: number;
	paused: boolean;
}) {
	const { t } = useI18n();
	const hasTotal = total > 0 && downloaded <= total;
	const percent = hasTotal
		? Math.min(100, Math.round((downloaded / total) * 100))
		: null;
	const etaLabel =
		!paused && bytesPerSec > 0 && hasTotal && downloaded < total
			? formatEta((total - downloaded) / bytesPerSec)
			: null;
	return (
		<div className="grid gap-1">
			<div className="h-1 w-full overflow-hidden rounded-full bg-muted/40">
				{percent !== null ? (
					<div
						className={cn(
							"h-full transition-[width] duration-200 ease-out",
							paused ? "bg-foreground/30" : "bg-foreground/70",
						)}
						style={{ width: `${percent}%` }}
					/>
				) : (
					<div className="h-full w-1/3 animate-pulse bg-foreground/50" />
				)}
			</div>
			<div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
				<span>
					{hasTotal
						? `${formatBytes(downloaded)} / ${formatBytes(total)}${percent !== null ? ` · ${percent}%` : ""}`
						: formatBytes(downloaded)}
				</span>
				<span>
					{paused
						? t("Paused")
						: bytesPerSec > 0
							? `${formatBytes(bytesPerSec)}/s${etaLabel ? ` · ${etaLabel} left` : ""}`
							: downloaded === 0
								? t("Connecting…")
								: null}
				</span>
			</div>
		</div>
	);
}

function formatEta(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) return "";
	if (seconds < 90) return `${Math.ceil(seconds)}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 90) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rem = minutes % 60;
	return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

// Snapshot wins only when existing row is still `not_downloaded` or snapshot reports `downloaded`.
function isSnapshotMoreAdvanced(
	snap: LocalLlmDownloadStatus,
	existing: DownloadRow,
): boolean {
	if (existing.state === "not_downloaded" && snap.state !== "not_downloaded") {
		return true;
	}
	if (snap.state === "downloaded" && existing.state !== "downloaded") {
		return true;
	}
	return false;
}

function applyDownloadEvent(
	prev: Record<string, DownloadRow>,
	event: LocalLlmDownloadEvent,
): Record<string, DownloadRow> {
	const current = prev[event.entryId];
	const carriedOptionalComplete = current?.optionalComplete ?? true;
	const next = { ...prev };
	switch (event.kind) {
		case "started":
			next[event.entryId] = {
				entryId: event.entryId,
				state: "downloading",
				downloaded: current?.downloaded ?? 0,
				total: event.total,
				optionalComplete: carriedOptionalComplete,
				bytesPerSec: 0,
			};
			break;
		case "progress":
			next[event.entryId] = {
				entryId: event.entryId,
				state: "downloading",
				downloaded: event.downloaded,
				total: event.total,
				optionalComplete: carriedOptionalComplete,
				// Keep the last non-zero rate so a momentary 0 (HF
				// rate-limit window, brief stall) doesn't blank the
				// "X MB/s" readout. A genuinely stuck download surfaces
				// through the `failed` event (chunk-read timeout in the
				// worker) — until then we'd rather show stale speed
				// than make the row look frozen mid-download.
				bytesPerSec:
					event.bytesPerSec > 0
						? event.bytesPerSec
						: (current?.bytesPerSec ?? 0),
			};
			break;
		case "paused":
			next[event.entryId] = {
				entryId: event.entryId,
				state: "paused",
				downloaded: event.downloaded,
				total: event.total,
				optionalComplete: carriedOptionalComplete,
				bytesPerSec: 0,
			};
			break;
		case "cancelled":
			next[event.entryId] = {
				entryId: event.entryId,
				state: "not_downloaded",
				downloaded: 0,
				total: event.total,
				optionalComplete: true,
				bytesPerSec: 0,
			};
			break;
		case "completed":
			next[event.entryId] = {
				entryId: event.entryId,
				state: "downloaded",
				downloaded: event.downloaded,
				total: event.downloaded,
				optionalComplete: event.optionalComplete,
				bytesPerSec: 0,
			};
			break;
		case "failed":
			next[event.entryId] = {
				entryId: event.entryId,
				state: "failed",
				downloaded: current?.downloaded ?? 0,
				total: current?.total ?? 0,
				optionalComplete: carriedOptionalComplete,
				error: event.error,
				bytesPerSec: 0,
			};
			break;
	}
	return next;
}

function formatContext(tokens: number): string {
	if (tokens >= 1_048_576) {
		return `${Math.round(tokens / 1_048_576)}M`;
	}
	return `${Math.round(tokens / 1024)}K`;
}

function formatBytes(n: number): string {
	if (n >= 1_000_000_000) {
		return `${(n / 1_000_000_000).toFixed(1)} GB`;
	}
	if (n >= 1_000_000) {
		return `${(n / 1_000_000).toFixed(0)} MB`;
	}
	if (n >= 1_000) {
		return `${(n / 1_000).toFixed(0)} KB`;
	}
	return `${Math.round(n)} B`;
}
