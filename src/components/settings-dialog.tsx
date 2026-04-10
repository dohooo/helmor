import { useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	Check,
	Download,
	FolderInput,
	GitBranch,
	Loader2,
	Minus,
	Monitor,
	Moon,
	Plus,
	Search,
	Settings,
	Sun,
	Terminal,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type CliStatus,
	type ConductorRepo,
	type ConductorWorkspace,
	getCliStatus,
	importConductorWorkspaces,
	installCli,
	isConductorAvailable,
	listConductorRepos,
	listConductorWorkspaces,
	loadGithubIdentitySession,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import type { ThemeMode } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

type SettingsSection = "appearance" | "workspace" | "experimental" | "import";

export const SettingsDialog = memo(function SettingsDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const [activeSection, setActiveSection] =
		useState<SettingsSection>("appearance");
	const [githubLogin, setGithubLogin] = useState<string | null>(null);
	const [conductorEnabled, setConductorEnabled] = useState(false);

	useEffect(() => {
		if (open) {
			void loadGithubIdentitySession().then((snapshot) => {
				if (snapshot.status === "connected") {
					setGithubLogin(snapshot.session.login);
				}
			});
			void isConductorAvailable().then(setConductorEnabled);
		}
	}, [open]);

	const sections: SettingsSection[] = conductorEnabled
		? ["appearance", "workspace", "experimental", "import"]
		: ["appearance", "workspace", "experimental"];

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="flex h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] sm:max-w-[860px] gap-0 overflow-hidden rounded-2xl border border-app-border/60 bg-app-sidebar p-0 shadow-2xl">
				{/* Nav sidebar */}
				<nav className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-app-border/40 bg-app-base/40 px-3 pt-14 pb-6">
					{sections.map((section) => (
						<button
							key={section}
							type="button"
							onClick={() => setActiveSection(section)}
							className={cn(
								"rounded-lg px-3 py-2 text-left text-[13px] font-medium capitalize transition-colors",
								activeSection === section
									? "bg-app-foreground/[0.07] text-app-foreground"
									: "text-app-muted hover:bg-app-foreground/[0.04] hover:text-app-foreground",
							)}
						>
							{section}
						</button>
					))}
				</nav>

				{/* Main content */}
				<div className="flex flex-1 flex-col">
					{/* Header */}
					<div className="flex items-center border-b border-app-border/40 px-8 py-4">
						<DialogTitle className="text-[15px] font-semibold capitalize text-app-foreground">
							{activeSection}
						</DialogTitle>
					</div>

					{/* Content area */}
					<div className="flex-1 overflow-y-auto px-8 py-6">
						{activeSection === "appearance" && (
							<div className="space-y-3">
								{/* Theme */}
								<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
									<div className="text-[13px] font-medium leading-snug text-app-foreground">
										Theme
									</div>
									<div className="mt-1 text-[12px] leading-snug text-app-muted">
										Switch between light and dark appearance
									</div>
									<div className="mt-3 flex gap-1.5">
										{(
											[
												{ value: "system", icon: Monitor, label: "System" },
												{ value: "light", icon: Sun, label: "Light" },
												{ value: "dark", icon: Moon, label: "Dark" },
											] as const
										).map(({ value, icon: Icon, label }) => (
											<button
												key={value}
												type="button"
												onClick={() =>
													updateSettings({ theme: value as ThemeMode })
												}
												className={cn(
													"flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
													settings.theme === value
														? "bg-app-foreground/[0.09] text-app-foreground"
														: "text-app-muted hover:bg-app-foreground/[0.04] hover:text-app-foreground",
												)}
											>
												<Icon className="size-3.5" strokeWidth={1.8} />
												{label}
											</button>
										))}
									</div>
								</div>

								{/* Font Size */}
								<div className="flex items-center justify-between rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
									<div className="mr-8">
										<div className="text-[13px] font-medium leading-snug text-app-foreground">
											Font Size
										</div>
										<div className="mt-1 text-[12px] leading-snug text-app-muted">
											Adjust the text size for chat messages
										</div>
									</div>

									<div className="flex items-center gap-3">
										<Button
											variant="outline"
											size="icon-sm"
											onClick={() =>
												updateSettings({
													fontSize: Math.max(
														MIN_FONT_SIZE,
														settings.fontSize - 1,
													),
												})
											}
											disabled={settings.fontSize <= MIN_FONT_SIZE}
										>
											<Minus className="size-3.5" strokeWidth={2} />
										</Button>

										<span className="w-12 text-center text-[14px] font-semibold tabular-nums text-app-foreground">
											{settings.fontSize}px
										</span>

										<Button
											variant="outline"
											size="icon-sm"
											onClick={() =>
												updateSettings({
													fontSize: Math.min(
														MAX_FONT_SIZE,
														settings.fontSize + 1,
													),
												})
											}
											disabled={settings.fontSize >= MAX_FONT_SIZE}
										>
											<Plus className="size-3.5" strokeWidth={2} />
										</Button>
									</div>
								</div>
							</div>
						)}

						{activeSection === "workspace" && (
							<div className="space-y-3">
								<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
									<div className="text-[13px] font-medium leading-snug text-app-foreground">
										Branch Prefix
									</div>
									<div className="mt-1 text-[12px] leading-snug text-app-muted">
										Prefix added to branch names when creating new workspaces
									</div>
									<div className="mt-4 flex flex-col gap-1">
										<RadioOption
											checked={settings.branchPrefixType === "github"}
											onChange={() =>
												updateSettings({ branchPrefixType: "github" })
											}
											label={`GitHub username${githubLogin ? ` (${githubLogin})` : ""}`}
										/>

										<RadioOption
											checked={settings.branchPrefixType === "custom"}
											onChange={() =>
												updateSettings({ branchPrefixType: "custom" })
											}
											label="Custom"
										/>
										{settings.branchPrefixType === "custom" && (
											<div className="ml-7">
												<input
													type="text"
													value={settings.branchPrefixCustom}
													onChange={(e) =>
														updateSettings({
															branchPrefixCustom: e.target.value,
														})
													}
													placeholder="e.g. feat/"
													className="w-full rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] text-app-foreground placeholder:text-app-muted/50 focus:border-app-border-strong focus:outline-none"
												/>
												{settings.branchPrefixCustom && (
													<div className="mt-1.5 text-[12px] text-app-muted">
														Preview: {settings.branchPrefixCustom}tokyo
													</div>
												)}
											</div>
										)}

										<RadioOption
											checked={settings.branchPrefixType === "none"}
											onChange={() =>
												updateSettings({ branchPrefixType: "none" })
											}
											label="None"
										/>
									</div>
								</div>
							</div>
						)}

						{activeSection === "experimental" && (
							<div className="space-y-3">
								<CliInstallPanel />
							</div>
						)}

						{activeSection === "import" && <ConductorImportPanel />}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
});

// ---------------------------------------------------------------------------
// CLI Install Panel (embedded in settings > experimental)
// ---------------------------------------------------------------------------

function CliInstallPanel() {
	const [status, setStatus] = useState<CliStatus | null>(null);
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void getCliStatus().then(setStatus);
	}, []);

	const handleInstall = useCallback(async () => {
		setInstalling(true);
		setError(null);
		try {
			const result = await installCli();
			setStatus(result);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setInstalling(false);
		}
	}, []);

	return (
		<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
			<div className="flex items-center gap-2">
				<Terminal
					className="size-4 text-app-foreground-soft"
					strokeWidth={1.8}
				/>
				<div className="text-[13px] font-medium leading-snug text-app-foreground">
					Command Line Tool
				</div>
			</div>
			<div className="mt-1 text-[12px] leading-snug text-app-muted">
				Install the{" "}
				<code className="rounded bg-app-elevated px-1 py-0.5 text-[11px]">
					helmor
				</code>{" "}
				command to manage workspaces and sessions from the terminal.{" "}
				{status?.buildMode === "development" ? "Debug" : "Release"} build.
			</div>

			<div className="mt-4">
				{status?.installed ? (
					<div className="space-y-3">
						<div className="flex items-center gap-2 text-[12px] text-green-400/90">
							<Check className="size-3.5" strokeWidth={2} />
							<span>
								Installed at{" "}
								<code className="rounded bg-app-elevated px-1.5 py-0.5 text-[11px]">
									{status.installPath}
								</code>
							</span>
						</div>
						<button
							type="button"
							onClick={handleInstall}
							disabled={installing}
							className="flex h-8 items-center gap-2 rounded-lg bg-app-elevated px-4 text-[12px] font-medium text-app-foreground transition-colors hover:brightness-110 disabled:opacity-40"
						>
							{installing ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Download className="size-3.5" strokeWidth={1.8} />
							)}
							Reinstall
						</button>
					</div>
				) : (
					<button
						type="button"
						onClick={handleInstall}
						disabled={installing}
						className="flex h-8 items-center gap-2 rounded-lg bg-app-elevated px-4 text-[13px] font-medium text-app-foreground transition-colors hover:brightness-110 disabled:opacity-40"
					>
						{installing ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Download className="size-3.5" strokeWidth={1.8} />
						)}
						Install to /usr/local/bin
					</button>
				)}

				{error && (
					<p className="mt-2 text-[11px] leading-relaxed text-red-400/90">
						{error}
					</p>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Conductor Import Panel (embedded in settings)
// ---------------------------------------------------------------------------

function humanize(directoryName: string): string {
	return directoryName
		.replace(/[-_]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function statusLabel(ws: ConductorWorkspace): string {
	if (ws.state === "archived") return "Archived";
	if (ws.derivedStatus === "done") return "Done";
	if (ws.derivedStatus === "in-progress") return "In progress";
	return ws.derivedStatus ?? ws.state;
}

function SkeletonRow() {
	return (
		<div className="flex items-center gap-2 rounded-xl px-2 py-2">
			<div className="size-7 shrink-0 animate-pulse rounded-lg bg-app-elevated" />
			<div className="flex-1 space-y-1.5">
				<div className="h-3 w-28 animate-pulse rounded bg-app-elevated" />
				<div className="h-2.5 w-16 animate-pulse rounded bg-app-elevated" />
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

function ConductorImportPanel() {
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

	// Load repos on mount
	useEffect(() => {
		setLoadingRepos(true);
		listConductorRepos()
			.then(setRepos)
			.catch(() => setRepos([]))
			.finally(() => setLoadingRepos(false));
	}, []);

	// Load workspaces when repo selected
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

	// Focus search on step change
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
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.workspaceGroups,
		});
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.archivedWorkspaces,
		});
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
					`${result.importedCount} imported, ${result.errors.length} failed: ${result.errors[0]}`,
				);
			} else {
				setImportSuccess(
					`Successfully imported ${result.importedCount} workspace${result.importedCount === 1 ? "" : "s"}`,
				);
				// Refresh workspace list to update "already imported" state
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
			setImportError(e instanceof Error ? e.message : "Import failed");
		} finally {
			setImporting(false);
		}
	}, [importing, selectedIds, invalidateAfterImport, selectedRepoId]);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId);

	return (
		<>
			<div className="flex items-center gap-2">
				{selectedRepoId ? (
					<button
						type="button"
						disabled={importing}
						className="flex size-6 items-center justify-center rounded-md text-app-foreground-soft transition-colors hover:text-app-foreground disabled:opacity-40"
						onClick={() => {
							setSelectedRepoId(null);
							setImportSuccess(null);
						}}
					>
						<ArrowLeft className="size-3.5" strokeWidth={2} />
					</button>
				) : (
					<FolderInput
						className="size-3.5 text-app-foreground-soft"
						strokeWidth={1.8}
					/>
				)}
				<div className="text-[13px] font-medium leading-snug text-app-foreground">
					{selectedRepoId
						? (selectedRepo?.name ?? "Repository")
						: "Import from Conductor"}
				</div>
			</div>
			<div className="mt-1 text-[12px] leading-snug text-app-muted">
				{selectedRepoId
					? "Select workspaces to import"
					: "Import workspaces from a local Conductor installation"}
			</div>

			{/* Search */}
			{!importing && (
				<div className="mt-4">
					<div className="relative">
						<Search
							className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-app-foreground-soft/60"
							strokeWidth={1.9}
						/>
						<input
							ref={searchRef}
							type="text"
							value={searchQuery}
							placeholder={
								selectedRepoId ? "Search workspaces" : "Search repositories"
							}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							className="h-8 w-full rounded-lg border border-app-border/40 bg-app-base/30 px-8 text-[13px] text-app-foreground outline-none placeholder:text-app-muted/50 focus:border-app-border-strong"
						/>
					</div>
				</div>
			)}

			{/* Content list */}
			<div className="mt-3">
				{importing ? (
					<div className="flex flex-col items-center justify-center gap-3 py-8">
						<Loader2 className="size-5 animate-spin text-app-foreground-soft" />
						<div className="text-center">
							<p className="text-[13px] font-medium text-app-foreground">
								Importing {selectedIds.size} workspace
								{selectedIds.size === 1 ? "" : "s"}
							</p>
							<p className="mt-1 text-[11px] text-app-muted">
								Setting up repositories and copying data...
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
							<button
								type="button"
								className="mb-1 w-full rounded-lg px-2 py-1.5 text-left text-[11px] uppercase tracking-[0.14em] text-app-foreground-soft/70 transition-colors hover:text-app-foreground-soft"
								onClick={toggleAll}
							>
								{selectedIds.size === importableWorkspaces.length
									? "Deselect all"
									: "Select all"}
							</button>
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
							<p className="py-6 text-center text-[13px] text-app-muted">
								No workspaces found
							</p>
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
					<p className="py-6 text-center text-[13px] text-app-muted">
						{repos.length === 0
							? "No Conductor repositories found"
							: "No matches"}
					</p>
				)}
			</div>

			{/* Footer — workspace step */}
			{selectedRepoId && !loading && !importing && (
				<div className="mt-4 border-t border-app-border/30 pt-4">
					{importError && (
						<p
							className="mb-2 text-[11px] leading-relaxed text-red-400/90"
							title={importError}
						>
							{importError}
						</p>
					)}
					{importSuccess && (
						<p className="mb-2 text-[11px] leading-relaxed text-green-400/90">
							{importSuccess}
						</p>
					)}
					<button
						type="button"
						disabled={selectedIds.size === 0}
						onClick={handleImport}
						className="flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-app-elevated text-[13px] font-medium text-app-foreground transition-colors hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
					>
						<FolderInput className="size-3.5" strokeWidth={1.8} />
						Import {selectedIds.size} workspace
						{selectedIds.size === 1 ? "" : "s"}
					</button>
				</div>
			)}
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
	const allImported =
		repo.workspaceCount > 0 && repo.alreadyImportedCount >= repo.workspaceCount;

	return (
		<button
			type="button"
			className={cn(
				"flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors",
				allImported ? "opacity-40" : "hover:bg-app-row-hover",
			)}
			onClick={onClick}
		>
			<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-app-elevated text-[11px] font-semibold uppercase text-app-foreground-soft">
				{repo.name.slice(0, 2)}
			</div>
			<div className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-app-foreground">
					{repo.name}
				</span>
				<span className="block text-[11px] tracking-[0.04em] text-app-muted">
					{allImported
						? "All imported"
						: repo.alreadyImportedCount > 0
							? `${repo.alreadyImportedCount}/${repo.workspaceCount} imported`
							: `${repo.workspaceCount} workspace${repo.workspaceCount === 1 ? "" : "s"}`}
				</span>
			</div>
		</button>
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
	if (workspace.alreadyImported) {
		return (
			<div className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 opacity-40">
				<div className="flex size-4 shrink-0 items-center justify-center rounded border border-app-border-strong text-app-foreground-soft">
					<Check className="size-3" strokeWidth={2.5} />
				</div>
				<div className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-medium text-app-foreground-soft">
						{workspace.prTitle || humanize(workspace.directoryName)}
					</span>
					<span className="block text-[11px] tracking-[0.04em] text-app-muted">
						Already imported
					</span>
				</div>
			</div>
		);
	}

	return (
		<button
			type="button"
			className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-app-row-hover"
			onClick={() => onToggle(workspace.id)}
		>
			<div
				className={cn(
					"flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
					checked
						? "border-app-foreground-soft bg-app-foreground-soft text-app-base"
						: "border-app-border-strong",
				)}
			>
				{checked && <Check className="size-3" strokeWidth={2.5} />}
			</div>

			<div className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-app-foreground">
					{workspace.prTitle || humanize(workspace.directoryName)}
				</span>
				<div className="flex items-center gap-2 text-[11px] tracking-[0.04em] text-app-muted">
					{workspace.branch && (
						<span className="flex items-center gap-0.5 truncate">
							<GitBranch className="size-2.5 shrink-0" strokeWidth={2} />
							{workspace.branch}
						</span>
					)}
					<span>{statusLabel(workspace)}</span>
					<span>
						{workspace.sessionCount} session
						{workspace.sessionCount === 1 ? "" : "s"}
					</span>
				</div>
			</div>
		</button>
	);
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function RadioOption({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: () => void;
	label: string;
}) {
	return (
		<label className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5">
			<input
				type="radio"
				checked={checked}
				onChange={onChange}
				className="accent-app-project"
			/>
			<span className="text-[13px] text-app-foreground">{label}</span>
		</label>
	);
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={onClick}
			title="Settings"
			className="text-app-muted hover:text-app-foreground"
		>
			<Settings className="size-[15px]" strokeWidth={1.8} />
		</Button>
	);
}
