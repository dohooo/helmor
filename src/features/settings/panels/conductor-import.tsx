import { useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	FolderInput,
	GitBranch,
	Loader2,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "@/components/ui/input-group";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
	type ConductorRepo,
	type ConductorWorkspace,
	importConductorWorkspaces,
	listConductorRepos,
	listConductorWorkspaces,
} from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

function humanize(directoryName: string): string {
	return directoryName
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusLabel(ws: ConductorWorkspace): string {
	if (ws.state === "archived") return "archived";
	if (ws.status === "done") return "done";
	if (ws.status === "in-progress") return "progress";
	return ws.status ?? ws.state;
}

function SkeletonRow() {
	return (
		<div className="flex items-center gap-2 rounded-xl px-2 py-2">
			<Skeleton className="size-7 shrink-0 rounded-lg bg-muted" />
			<div className="flex flex-1 flex-col gap-1.5">
				<Skeleton className="h-3 w-28 bg-muted" />
				<Skeleton className="h-2.5 w-16 bg-muted" />
			</div>
		</div>
	);
}

function SkeletonList({ rows = 3 }: { rows?: number }) {
	return (
		<>
			{Array.from({ length: rows }, (_, i) => (
				<SkeletonRow key={i} />
			))}
		</>
	);
}

function ImportRepoRow({
	repo,
	onClick,
}: {
	repo: ConductorRepo;
	onClick: () => void;
}) {
	const { t, f } = useI18n();
	const allImported =
		repo.workspaceCount > 0 && repo.alreadyImportedCount >= repo.workspaceCount;

	return (
		<Button
			type="button"
			variant="ghost"
			className={cn(
				"h-auto w-full justify-start rounded-xl px-2 py-2 text-left transition-colors",
				allImported ? "opacity-40" : "hover:bg-accent/60",
			)}
			onClick={onClick}
		>
			<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-mini font-semibold uppercase text-muted-foreground">
				{repo.name.slice(0, 2)}
			</div>
			<div className="min-w-0 flex-1">
				<span className="block truncate text-ui font-medium text-foreground">
					{repo.name}
				</span>
				<span className="block text-mini tracking-[0.04em] text-muted-foreground">
					{allImported
						? t("settingsAllImported")
						: repo.alreadyImportedCount > 0
							? f("settingsCountTotalImported", {
									count: repo.alreadyImportedCount,
									total: repo.workspaceCount,
								})
							: f("settingsCountWorkspaces", {
									count: repo.workspaceCount,
								})}
				</span>
			</div>
		</Button>
	);
}

function ImportWorkspaceRow({
	workspace,
	checked,
	onToggle,
}: {
	workspace: ConductorWorkspace;
	checked: boolean;
	onToggle: (id: string) => void;
}) {
	const { t, f } = useI18n();
	if (workspace.alreadyImported) {
		return (
			<div className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 opacity-40">
				<Checkbox checked disabled aria-hidden />
				<div className="min-w-0 flex-1">
					<span className="block truncate text-ui font-medium text-muted-foreground">
						{workspace.prTitle || humanize(workspace.directoryName)}
					</span>
					<span className="block text-mini tracking-[0.04em] text-muted-foreground">
						<I18nText source="alreadyImported" />
					</span>
				</div>
			</div>
		);
	}

	const checkboxId = `settings-import-workspace-${workspace.id}`;

	return (
		<label
			htmlFor={checkboxId}
			className="flex w-full cursor-interactive items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-accent/60"
		>
			<Checkbox
				id={checkboxId}
				checked={checked}
				onCheckedChange={() => onToggle(workspace.id)}
				aria-label={f("settingsSelectName", {
					name: workspace.prTitle || humanize(workspace.directoryName),
				})}
			/>
			<div className="min-w-0 flex-1">
				<span className="block truncate text-ui font-medium text-foreground">
					{workspace.prTitle || humanize(workspace.directoryName)}
				</span>
				<div className="flex items-center gap-2 text-mini tracking-[0.04em] text-muted-foreground">
					{workspace.branch && (
						<span className="flex items-center gap-0.5 truncate">
							<GitBranch className="size-2.5 shrink-0" strokeWidth={2} />
							{workspace.branch}
						</span>
					)}
					<span>{t(statusLabel(workspace))}</span>
					<span>
						{workspace.sessionCount} <I18nText source={"session2"} />
						{workspace.sessionCount === 1 ? "" : "s"}
					</span>
				</div>
			</div>
		</label>
	);
}

export function ConductorImportPanel() {
	const { t, f } = useI18n();
	const queryClient = useQueryClient();
	const searchRef = useRef<HTMLInputElement>(null);

	const [repos, setRepos] = useState<ConductorRepo[]>([]);
	const [workspaces, setWorkspaces] = useState<ConductorWorkspace[]>([]);
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	const [loadingRepos, setLoadingRepos] = useState(true);
	const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [importSuccess, setImportSuccess] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");

	const loading = loadingRepos || loadingWorkspaces;

	useEffect(() => {
		setLoadingRepos(true);
		listConductorRepos()
			.then(setRepos)
			.catch(() => setRepos([]))
			.finally(() => setLoadingRepos(false));
	}, []);

	useEffect(() => {
		if (!selectedRepoId) return;
		setSearchQuery("");
		setImportError(null);
		setImportSuccess(null);
		setLoadingWorkspaces(true);
		listConductorWorkspaces(selectedRepoId)
			.then((ws) => {
				setWorkspaces(ws);
				const importable = ws
					.filter((w) => !w.alreadyImported)
					.map((w) => w.id);
				setSelectedIds(new Set(importable));
			})
			.catch(() => setWorkspaces([]))
			.finally(() => setLoadingWorkspaces(false));
	}, [selectedRepoId]);

	useEffect(() => {
		requestAnimationFrame(() => searchRef.current?.focus());
	}, [selectedRepoId]);

	const filteredRepos = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return repos;
		return repos.filter((r) => r.name.toLowerCase().includes(q));
	}, [repos, searchQuery]);

	const filteredWorkspaces = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return workspaces;
		return workspaces.filter((w) => {
			const haystack =
				`${w.directoryName} ${w.branch ?? ""} ${w.prTitle ?? ""}`.toLowerCase();
			return haystack.includes(q);
		});
	}, [workspaces, searchQuery]);

	const toggleId = useCallback((id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const importableWorkspaces = useMemo(
		() => workspaces.filter((w) => !w.alreadyImported),
		[workspaces],
	);

	const toggleAll = useCallback(() => {
		if (selectedIds.size === importableWorkspaces.length) {
			setSelectedIds(new Set());
		} else {
			setSelectedIds(new Set(importableWorkspaces.map((w) => w.id)));
		}
	}, [selectedIds.size, importableWorkspaces]);

	const invalidateAfterImport = useCallback(() => {
		requestSidebarReconcile(queryClient);
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.repositories,
		});
	}, [queryClient]);

	const handleImport = useCallback(async () => {
		if (importing || selectedIds.size === 0) return;
		setImporting(true);
		setImportError(null);
		setImportSuccess(null);
		try {
			const result = await importConductorWorkspaces(Array.from(selectedIds));
			if (result.importedCount > 0) {
				invalidateAfterImport();
			}
			if (result.errors.length > 0) {
				setImportError(
					f("settingsImportPartialFailed", {
						count: result.importedCount,
						failed: result.errors.length,
						error: result.errors[0],
					}),
				);
			} else {
				setImportSuccess(
					f("settingsSuccessfullyImportedCount", {
						count: result.importedCount,
					}),
				);
				if (selectedRepoId) {
					setLoadingWorkspaces(true);
					listConductorWorkspaces(selectedRepoId)
						.then((ws) => {
							setWorkspaces(ws);
							const importable = ws
								.filter((w) => !w.alreadyImported)
								.map((w) => w.id);
							setSelectedIds(new Set(importable));
						})
						.catch(() => {})
						.finally(() => setLoadingWorkspaces(false));
				}
			}
		} catch (e) {
			setImportError(
				e instanceof Error ? e.message : t("settingsImportFailed"),
			);
		} finally {
			setImporting(false);
		}
	}, [
		importing,
		invalidateAfterImport,
		t,
		f,
		queryClient,
		selectedIds,
		selectedRepoId,
	]);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId);

	return (
		<>
			<SettingsGroup>
				<SettingsRow
					title={
						<span className="flex items-center gap-2">
							{selectedRepoId ? (
								<Button
									disabled={importing}
									variant="ghost"
									size="icon-xs"
									className="text-muted-foreground hover:text-foreground"
									onClick={() => {
										setSelectedRepoId(null);
										setImportSuccess(null);
									}}
								>
									<ArrowLeft className="size-3.5" strokeWidth={2} />
								</Button>
							) : (
								<FolderInput
									className="size-3.5 text-muted-foreground"
									strokeWidth={1.8}
								/>
							)}
							<span>
								{selectedRepoId
									? (selectedRepo?.name ?? t("repository"))
									: t("importFromConductor")}
							</span>
						</span>
					}
					description={
						selectedRepoId
							? "selectWorkspacesImport"
							: "importWorkspacesFromLocalConductorInstallation"
					}
				/>
			</SettingsGroup>

			{!importing && (
				<div>
					<InputGroup className="border-border/40 bg-muted/30 shadow-none">
						<InputGroupAddon>
							<Search className="text-muted-foreground/60" strokeWidth={1.9} />
						</InputGroupAddon>
						<InputGroupInput
							ref={searchRef}
							type="text"
							value={searchQuery}
							placeholder={
								selectedRepoId
									? "settingsSearchWorkspaces"
									: "searchRepositories"
							}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							className="text-ui text-foreground placeholder:text-muted-foreground/50"
						/>
					</InputGroup>
				</div>
			)}

			<div className="mt-3">
				{importing ? (
					<div className="flex flex-col items-center justify-center gap-3 py-8">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
						<div className="text-center">
							<p className="text-ui font-medium text-foreground">
								<I18nText source="importing" /> {selectedIds.size}{" "}
								<I18nText source={"workspace2"} />
								{selectedIds.size === 1 ? "" : "s"}
							</p>
							<p className="mt-1 text-mini text-muted-foreground">
								<I18nText source="settingUpRepositoriesCopyingData" />
							</p>
						</div>
					</div>
				) : loadingRepos ? (
					<SkeletonList rows={3} />
				) : loadingWorkspaces ? (
					<SkeletonList rows={4} />
				) : selectedRepoId ? (
					<>
						{importableWorkspaces.length > 1 && (
							<Button
								variant="ghost"
								size="xs"
								className="mb-1 w-full justify-start rounded-lg px-2 text-mini uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
								onClick={toggleAll}
							>
								{selectedIds.size === importableWorkspaces.length
									? t("settingsDeselectAll")
									: t("settingsSelectAll")}
							</Button>
						)}
						{filteredWorkspaces.length > 0 ? (
							filteredWorkspaces.map((ws) => (
								<ImportWorkspaceRow
									key={ws.id}
									workspace={ws}
									checked={selectedIds.has(ws.id)}
									onToggle={toggleId}
								/>
							))
						) : (
							<Empty className="py-6">
								<EmptyHeader>
									<EmptyTitle>
										<I18nText source="noWorkspacesFound" />
									</EmptyTitle>
								</EmptyHeader>
							</Empty>
						)}
					</>
				) : filteredRepos.length > 0 ? (
					filteredRepos.map((repo) => (
						<ImportRepoRow
							key={repo.id}
							repo={repo}
							onClick={() => setSelectedRepoId(repo.id)}
						/>
					))
				) : (
					<Empty className="py-6">
						<EmptyHeader>
							<EmptyTitle>
								{repos.length === 0 ? (
									<I18nText source="settingsNoConductorRepositories" />
								) : (
									<I18nText source="noMatches" />
								)}
							</EmptyTitle>
						</EmptyHeader>
					</Empty>
				)}
			</div>

			{selectedRepoId && !loading && !importing && (
				<div className="mt-4">
					<Separator className="mb-4 bg-border/30" />
					{importError && (
						<p
							className="mb-2 text-mini leading-relaxed text-red-400/90"
							title={importError}
						>
							{importError}
						</p>
					)}
					{importSuccess && (
						<p className="mb-2 text-mini leading-relaxed text-chart-2">
							{importSuccess}
						</p>
					)}
					<Button
						disabled={selectedIds.size === 0}
						onClick={handleImport}
						variant="secondary"
						className="h-8 w-full rounded-lg"
					>
						<FolderInput
							data-icon="inline-start"
							className="size-3.5"
							strokeWidth={1.8}
						/>
						{f("settingsImportCountWorkspaces", { count: selectedIds.size })}
					</Button>
				</div>
			)}
		</>
	);
}
