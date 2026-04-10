import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	Check,
	ChevronDown,
	FolderInput,
	GitBranch,
	Loader2,
	LoaderCircle,
	Minus,
	Monitor,
	Moon,
	Plus,
	Search,
	Settings,
	Sun,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ConductorRepo,
	type ConductorWorkspace,
	importConductorWorkspaces,
	isConductorAvailable,
	listConductorRepos,
	listConductorWorkspaces,
	listRemoteBranches,
	listRepoRemotes,
	loadGithubIdentitySession,
	prefetchRemoteRefs,
	type RepositoryCreateOption,
	updateRepositoryDefaultBranch,
	updateRepositoryRemote,
} from "@/lib/api";
import { helmorQueryKeys, repositoriesQueryOptions } from "@/lib/query-client";
import type { ThemeMode } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "./ui/command";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Field, FieldContent, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

type SettingsSection = "appearance" | "workspace" | "import" | `repo:${string}`;

function sectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
): string {
	if (section.startsWith("repo:")) {
		const repoId = section.slice(5);
		return repos.find((r) => r.id === repoId)?.name ?? "Repository";
	}
	return section;
}

export const SettingsDialog = memo(function SettingsDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const queryClient = useQueryClient();
	const [activeSection, setActiveSection] =
		useState<SettingsSection>("appearance");
	const [githubLogin, setGithubLogin] = useState<string | null>(null);
	const [conductorEnabled, setConductorEnabled] = useState(false);

	const reposQuery = useQuery({
		...repositoriesQueryOptions(),
		enabled: open,
	});
	const repositories = reposQuery.data ?? [];

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

	const fixedSections: SettingsSection[] = conductorEnabled
		? ["appearance", "workspace", "import"]
		: ["appearance", "workspace"];

	const activeRepoId = activeSection.startsWith("repo:")
		? activeSection.slice(5)
		: null;
	const activeRepo = activeRepoId
		? repositories.find((r) => r.id === activeRepoId)
		: null;

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="flex h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] gap-0 overflow-hidden rounded-2xl border-border/60 bg-background p-0 shadow-2xl sm:max-w-[860px]">
				{/* Nav sidebar */}
				<nav className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-border/40 bg-muted/30 px-3 pt-14 pb-6">
					<ToggleGroup
						type="single"
						value={activeSection}
						orientation="vertical"
						className="w-full items-stretch gap-1"
						onValueChange={(value: string) => {
							if (value) {
								setActiveSection(value as SettingsSection);
							}
						}}
					>
						{fixedSections.map((section) => (
							<ToggleGroupItem
								key={section}
								value={section}
								className="w-full justify-start rounded-lg px-3 py-2 text-left text-[13px] font-medium capitalize data-[state=on]:bg-accent data-[state=on]:text-foreground"
							>
								{section}
							</ToggleGroupItem>
						))}
					</ToggleGroup>

					{repositories.length > 0 && (
						<>
							<div className="mx-3 mt-3 mb-1 border-t border-border/30" />
							<div className="px-3 py-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70">
								Repositories
							</div>
							{repositories.map((repo) => {
								const key: SettingsSection = `repo:${repo.id}`;
								return (
									<button
										key={key}
										type="button"
										onClick={() => setActiveSection(key)}
										className={cn(
											"flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors",
											activeSection === key
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
										)}
									>
										{repo.repoIconSrc ? (
											<img
												src={repo.repoIconSrc}
												alt=""
												className="size-4 shrink-0 rounded"
											/>
										) : (
											<span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[8px] font-semibold uppercase text-muted-foreground">
												{repo.repoInitials?.slice(0, 2)}
											</span>
										)}
										<span className="truncate">{repo.name}</span>
									</button>
								);
							})}
						</>
					)}
				</nav>

				{/* Main content */}
				<div className="flex flex-1 flex-col">
					{/* Header */}
					<div className="flex items-center border-b border-border/40 px-8 py-4">
						<DialogTitle className="text-[15px] font-semibold text-foreground">
							{activeRepo
								? activeRepo.name
								: sectionLabel(activeSection, repositories)}
						</DialogTitle>
					</div>

					{/* Content area */}
					<div className="flex-1 overflow-y-auto px-8 py-6">
						{activeSection === "appearance" && (
							<div className="flex flex-col gap-3">
								{/* Theme */}
								<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
									<div className="text-[13px] font-medium leading-snug text-foreground">
										Theme
									</div>
									<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
										Switch between light and dark appearance
									</div>
									<ToggleGroup
										type="single"
										value={settings.theme}
										className="mt-3 gap-1.5"
										onValueChange={(value) => {
											if (value) {
												updateSettings({ theme: value as ThemeMode });
											}
										}}
									>
										{(
											[
												{ value: "system", icon: Monitor, label: "System" },
												{ value: "light", icon: Sun, label: "Light" },
												{ value: "dark", icon: Moon, label: "Dark" },
											] as const
										).map(({ value, icon: Icon, label }) => (
											<ToggleGroupItem
												key={value}
												value={value}
												className="gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												<Icon className="size-3.5" strokeWidth={1.8} />
												{label}
											</ToggleGroupItem>
										))}
									</ToggleGroup>
								</div>

								{/* Font Size */}
								<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
									<div className="mr-8">
										<div className="text-[13px] font-medium leading-snug text-foreground">
											Font Size
										</div>
										<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
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

										<span className="w-12 text-center text-[14px] font-semibold tabular-nums text-foreground">
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
							<div className="flex flex-col gap-3">
								<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
									<div className="text-[13px] font-medium leading-snug text-foreground">
										Branch Prefix
									</div>
									<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
										Prefix added to branch names when creating new workspaces
									</div>
									<RadioGroup
										value={settings.branchPrefixType}
										onValueChange={(value) =>
											updateSettings({
												branchPrefixType: value as "github" | "custom" | "none",
											})
										}
										className="mt-4 gap-1"
									>
										<RadioOption
											value="github"
											label={`GitHub username${githubLogin ? ` (${githubLogin})` : ""}`}
										/>
										<RadioOption value="custom" label="Custom" />
										{settings.branchPrefixType === "custom" && (
											<div className="ml-7">
												<Input
													type="text"
													value={settings.branchPrefixCustom}
													onChange={(e) =>
														updateSettings({
															branchPrefixCustom: e.target.value,
														})
													}
													placeholder="e.g. feat/"
													className="w-full bg-muted/30 text-[13px] text-foreground placeholder:text-muted-foreground/50"
												/>
												{settings.branchPrefixCustom && (
													<div className="mt-1.5 text-[12px] text-muted-foreground">
														Preview: {settings.branchPrefixCustom}tokyo
													</div>
												)}
											</div>
										)}
										<RadioOption value="none" label="None" />
									</RadioGroup>
								</div>
							</div>
						)}

						{activeSection === "import" && <ConductorImportPanel />}

						{activeRepo && (
							<RepositorySettingsPanel
								repo={activeRepo}
								onRepoSettingsChanged={() => {
									void queryClient.invalidateQueries({
										queryKey: helmorQueryKeys.repositories,
									});
									void queryClient.invalidateQueries({
										queryKey: helmorQueryKeys.workspaceGroups,
									});
									// Invalidate all workspace detail caches so
									// open panels pick up the new remote/branch.
									void queryClient.invalidateQueries({
										predicate: (q) => q.queryKey[0] === "workspaceDetail",
									});
								}}
							/>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
});

// ---------------------------------------------------------------------------
// Repository Settings Panel
// ---------------------------------------------------------------------------

function RepositorySettingsPanel({
	repo,
	onRepoSettingsChanged,
}: {
	repo: RepositoryCreateOption;
	onRepoSettingsChanged: () => void;
}) {
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const currentBranch = repo.defaultBranch ?? "main";

	const fetchBranches = useCallback(() => {
		setLoading(true);
		void listRemoteBranches({ repoId: repo.id })
			.then(setBranches)
			.finally(() => setLoading(false));
	}, [repo.id]);

	const handleOpen = useCallback(() => {
		fetchBranches();
		void prefetchRemoteRefs({ repoId: repo.id })
			.then(({ fetched }) => {
				if (fetched) fetchBranches();
			})
			.catch(() => {});
	}, [repo.id, fetchBranches]);

	const handleSelect = useCallback(
		(branch: string) => {
			if (branch === currentBranch) return;
			setOpen(false);
			setError(null);
			void updateRepositoryDefaultBranch(repo.id, branch).then(
				onRepoSettingsChanged,
				(err: unknown) => {
					setError(err instanceof Error ? err.message : String(err));
					onRepoSettingsChanged();
				},
			);
		},
		[repo.id, currentBranch, onRepoSettingsChanged],
	);

	const [remotes, setRemotes] = useState<string[]>([]);
	const [remoteOpen, setRemoteOpen] = useState(false);
	const [remoteError, setRemoteError] = useState<string | null>(null);
	const [remoteNotice, setRemoteNotice] = useState<string | null>(null);

	const currentRemote = repo.remote ?? "origin";

	const fetchRemotes = useCallback(() => {
		void listRepoRemotes(repo.id).then(setRemotes);
	}, [repo.id]);

	const handleRemoteSelect = useCallback(
		(remote: string) => {
			if (remote === currentRemote) return;
			setRemoteOpen(false);
			setRemoteError(null);
			setRemoteNotice(null);
			void updateRepositoryRemote(repo.id, remote).then(
				(response) => {
					if (response.orphanedWorkspaceCount > 0) {
						const n = response.orphanedWorkspaceCount;
						setRemoteNotice(
							`${n} workspace${n === 1 ? "" : "s"} target a branch not on this remote. Update them via the header branch picker.`,
						);
					}
					onRepoSettingsChanged();
				},
				(err: unknown) => {
					setRemoteError(err instanceof Error ? err.message : String(err));
					onRepoSettingsChanged();
				},
			);
		},
		[repo.id, currentRemote, onRepoSettingsChanged],
	);

	return (
		<div className="space-y-3">
			{/* Remote origin */}
			<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
				<div className="text-[13px] font-medium leading-snug text-app-foreground">
					Remote origin
				</div>
				<div className="mt-1 text-[12px] leading-snug text-app-muted">
					Where should we push, pull, and create PRs?
				</div>
				<div className="mt-3">
					<Popover
						open={remoteOpen}
						onOpenChange={(next: boolean) => {
							setRemoteOpen(next);
							if (next) fetchRemotes();
						}}
					>
						<PopoverTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] font-medium text-app-foreground transition-colors hover:border-app-border-strong">
							<span className="truncate">{currentRemote}</span>
							<ChevronDown
								className="size-3 shrink-0 text-app-muted"
								strokeWidth={2}
							/>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-[220px] p-0">
							<Command className="rounded-lg! p-0.5">
								<CommandList className="max-h-52">
									<CommandEmpty>No remotes found</CommandEmpty>
									{remotes.map((remote) => (
										<CommandItem
											key={remote}
											value={remote}
											onSelect={() => handleRemoteSelect(remote)}
											className="flex items-center justify-between gap-2 px-1.5 py-1 text-[12px]"
										>
											<span
												className={cn(
													"truncate",
													remote === currentRemote && "font-semibold",
												)}
											>
												{remote}
											</span>
											{remote === currentRemote && (
												<Check className="size-3.5 shrink-0" strokeWidth={2} />
											)}
										</CommandItem>
									))}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
					{remoteError && (
						<p className="mt-2 text-[12px] text-red-400/90">{remoteError}</p>
					)}
					{remoteNotice && (
						<p className="mt-2 text-[12px] text-amber-400/90">{remoteNotice}</p>
					)}
				</div>
			</div>

			{/* Branch new workspaces from */}
			<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
				<div className="text-[13px] font-medium leading-snug text-app-foreground">
					Branch new workspaces from
				</div>
				<div className="mt-1 text-[12px] leading-snug text-app-muted">
					Each workspace is an isolated copy of your codebase.
				</div>
				<div className="mt-3">
					<Popover
						open={open}
						onOpenChange={(next: boolean) => {
							setOpen(next);
							if (next) handleOpen();
						}}
					>
						<PopoverTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] font-medium text-app-foreground transition-colors hover:border-app-border-strong">
							<GitBranch
								className="size-3.5 text-app-foreground-soft"
								strokeWidth={1.8}
							/>
							<span className="truncate">
								{repo.remote ?? "origin"}/{currentBranch}
							</span>
							<ChevronDown
								className="size-3 shrink-0 text-app-muted"
								strokeWidth={2}
							/>
						</PopoverTrigger>
						<PopoverContent align="start" className="w-[280px] p-0">
							<Command className="rounded-lg! p-0.5">
								<CommandInput placeholder="Search branches..." />
								<CommandList className="max-h-52">
									{loading && branches.length === 0 ? (
										<div className="flex items-center justify-center gap-2 py-5 text-[12px] text-app-muted">
											<LoaderCircle
												className="size-3.5 animate-spin"
												strokeWidth={2}
											/>
											Loading branches...
										</div>
									) : null}
									<CommandEmpty>No branches found</CommandEmpty>
									{branches.map((branch) => (
										<CommandItem
											key={branch}
											value={branch}
											onSelect={() => handleSelect(branch)}
											className="flex items-center justify-between gap-2 px-1.5 py-1 text-[12px]"
										>
											<span
												className={cn(
													"truncate",
													branch === currentBranch && "font-semibold",
												)}
											>
												{branch}
											</span>
											{branch === currentBranch && (
												<Check className="size-3.5 shrink-0" strokeWidth={2} />
											)}
										</CommandItem>
									))}
								</CommandList>
							</Command>
						</PopoverContent>
					</Popover>
					{error && <p className="mt-2 text-[12px] text-red-400/90">{error}</p>}
				</div>
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
				<div className="text-[13px] font-medium leading-snug text-foreground">
					{selectedRepoId
						? (selectedRepo?.name ?? "Repository")
						: "Import from Conductor"}
				</div>
			</div>
			<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
				{selectedRepoId
					? "Select workspaces to import"
					: "Import workspaces from a local Conductor installation"}
			</div>

			{/* Search */}
			{!importing && (
				<div className="mt-4">
					<InputGroup className="border-border/40 bg-muted/30 shadow-none">
						<InputGroupAddon>
							<Search className="text-muted-foreground/60" strokeWidth={1.9} />
						</InputGroupAddon>
						<InputGroupInput
							ref={searchRef}
							type="text"
							value={searchQuery}
							placeholder={
								selectedRepoId ? "Search workspaces" : "Search repositories"
							}
							onChange={(e) => setSearchQuery(e.target.value)}
							onKeyDown={(e) => e.stopPropagation()}
							className="text-[13px] text-foreground placeholder:text-muted-foreground/50"
						/>
					</InputGroup>
				</div>
			)}

			{/* Content list */}
			<div className="mt-3">
				{importing ? (
					<div className="flex flex-col items-center justify-center gap-3 py-8">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
						<div className="text-center">
							<p className="text-[13px] font-medium text-foreground">
								Importing {selectedIds.size} workspace
								{selectedIds.size === 1 ? "" : "s"}
							</p>
							<p className="mt-1 text-[11px] text-muted-foreground">
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
							<Button
								variant="ghost"
								size="xs"
								className="mb-1 w-full justify-start rounded-lg px-2 text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
								onClick={toggleAll}
							>
								{selectedIds.size === importableWorkspaces.length
									? "Deselect all"
									: "Select all"}
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
									<EmptyTitle>No workspaces found</EmptyTitle>
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
								{repos.length === 0
									? "No Conductor repositories found"
									: "No matches"}
							</EmptyTitle>
						</EmptyHeader>
					</Empty>
				)}
			</div>

			{/* Footer — workspace step */}
			{selectedRepoId && !loading && !importing && (
				<div className="mt-4">
					<Separator className="mb-4 bg-border/30" />
					{importError && (
						<p
							className="mb-2 text-[11px] leading-relaxed text-red-400/90"
							title={importError}
						>
							{importError}
						</p>
					)}
					{importSuccess && (
						<p className="mb-2 text-[11px] leading-relaxed text-chart-2">
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
						Import {selectedIds.size} workspace
						{selectedIds.size === 1 ? "" : "s"}
					</Button>
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
		<Button
			type="button"
			variant="ghost"
			className={cn(
				"h-auto w-full justify-start rounded-xl px-2 py-2 text-left transition-colors",
				allImported ? "opacity-40" : "hover:bg-accent/60",
			)}
			onClick={onClick}
		>
			<div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-[11px] font-semibold uppercase text-muted-foreground">
				{repo.name.slice(0, 2)}
			</div>
			<div className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-foreground">
					{repo.name}
				</span>
				<span className="block text-[11px] tracking-[0.04em] text-muted-foreground">
					{allImported
						? "All imported"
						: repo.alreadyImportedCount > 0
							? `${repo.alreadyImportedCount}/${repo.workspaceCount} imported`
							: `${repo.workspaceCount} workspace${repo.workspaceCount === 1 ? "" : "s"}`}
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
	if (workspace.alreadyImported) {
		return (
			<div className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 opacity-40">
				<Checkbox checked disabled aria-hidden />
				<div className="min-w-0 flex-1">
					<span className="block truncate text-[13px] font-medium text-muted-foreground">
						{workspace.prTitle || humanize(workspace.directoryName)}
					</span>
					<span className="block text-[11px] tracking-[0.04em] text-muted-foreground">
						Already imported
					</span>
				</div>
			</div>
		);
	}

	const checkboxId = `settings-import-workspace-${workspace.id}`;

	return (
		<label
			htmlFor={checkboxId}
			className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-accent/60"
		>
			<Checkbox
				id={checkboxId}
				checked={checked}
				onCheckedChange={() => onToggle(workspace.id)}
				aria-label={`Select ${workspace.prTitle || humanize(workspace.directoryName)}`}
			/>
			<div className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-foreground">
					{workspace.prTitle || humanize(workspace.directoryName)}
				</span>
				<div className="flex items-center gap-2 text-[11px] tracking-[0.04em] text-muted-foreground">
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
		</label>
	);
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function RadioOption({
	value,
	label,
}: {
	value: "github" | "custom" | "none";
	label: string;
}) {
	const id = `settings-branch-prefix-${value}`;

	return (
		<Field
			orientation="horizontal"
			className="items-center gap-3 rounded-lg px-1 py-1.5"
		>
			<RadioGroupItem value={value} id={id} />
			<FieldContent>
				<FieldLabel htmlFor={id} className="text-foreground">
					{label}
				</FieldLabel>
			</FieldContent>
		</Field>
	);
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={onClick}
			title="Settings"
			className="text-muted-foreground hover:text-foreground"
		>
			<Settings className="size-[15px]" strokeWidth={1.8} />
		</Button>
	);
}
