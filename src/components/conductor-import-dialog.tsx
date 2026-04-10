import {
	ArrowLeft,
	FolderInput,
	GitBranch,
	Loader2,
	Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ConductorRepo,
	type ConductorWorkspace,
	importConductorWorkspaces,
	listConductorRepos,
	listConductorWorkspaces,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Empty, EmptyHeader, EmptyTitle } from "./ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Skeleton placeholders
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConductorImportDialog({
	open,
	onClose,
	onImported,
}: {
	open: boolean;
	onClose: () => void;
	onImported: () => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);

	// --- data state ---
	const [repos, setRepos] = useState<ConductorRepo[]>([]);
	const [workspaces, setWorkspaces] = useState<ConductorWorkspace[]>([]);
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	// --- ui state ---
	const [loadingRepos, setLoadingRepos] = useState(false);
	const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);

	const loading = loadingRepos || loadingWorkspaces;

	// --- load repos when dialog opens ---
	useEffect(() => {
		if (!open) return;
		setSelectedRepoId(null);
		setWorkspaces([]);
		setSelectedIds(new Set());
		setSearchQuery("");
		setImportError(null);
		setLoadingRepos(true);
		listConductorRepos()
			.then(setRepos)
			.catch(() => setRepos([]))
			.finally(() => setLoadingRepos(false));
	}, [open]);

	// --- load workspaces when repo selected ---
	useEffect(() => {
		if (!selectedRepoId) return;
		setSearchQuery("");
		setImportError(null);
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

	// --- focus search on step change ---
	useEffect(() => {
		if (open) {
			requestAnimationFrame(() => searchRef.current?.focus());
		}
	}, [open, selectedRepoId]);

	// --- close on escape / click outside ---
	useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (importing) return;
			if (e.key === "Escape") {
				if (selectedRepoId) {
					setSelectedRepoId(null);
				} else {
					onClose();
				}
			}
		};

		const handlePointerDown = (e: PointerEvent) => {
			if (importing) return;
			if (e.target instanceof Node && !panelRef.current?.contains(e.target)) {
				onClose();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("pointerdown", handlePointerDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("pointerdown", handlePointerDown);
		};
	}, [open, selectedRepoId, importing, onClose]);

	// --- filtered repos ---
	const filteredRepos = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return repos;
		return repos.filter((r) => r.name.toLowerCase().includes(q));
	}, [repos, searchQuery]);

	// --- filtered workspaces ---
	const filteredWorkspaces = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return workspaces;
		return workspaces.filter((w) => {
			const haystack =
				`${w.directoryName} ${w.branch ?? ""} ${w.prTitle ?? ""}`.toLowerCase();
			return haystack.includes(q);
		});
	}, [workspaces, searchQuery]);

	// --- selection helpers ---
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

	// --- import handler ---
	const handleImport = useCallback(async () => {
		if (importing || selectedIds.size === 0) return;
		setImporting(true);
		setImportError(null);
		try {
			const result = await importConductorWorkspaces(Array.from(selectedIds));
			if (result.importedCount > 0) {
				onImported();
			}
			if (result.errors.length > 0) {
				setImportError(
					`${result.importedCount} imported, ${result.errors.length} failed: ${result.errors[0]}`,
				);
			} else {
				onClose();
			}
		} catch (e) {
			setImportError(e instanceof Error ? e.message : "Import failed");
		} finally {
			setImporting(false);
		}
	}, [importing, selectedIds, onImported, onClose]);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId);

	return (
		<Dialog open={open} onOpenChange={(v) => !v && !importing && onClose()}>
			<DialogContent
				ref={panelRef}
				showCloseButton={!importing}
				className="flex w-[24rem] max-w-[24rem] flex-col gap-0 rounded-xl border border-border bg-background p-0 shadow-2xl"
			>
				{/* Header */}
				<div className="flex items-center gap-2 px-4 pt-4 pb-2">
					{selectedRepoId ? (
						<Button
							disabled={importing}
							variant="ghost"
							size="icon-xs"
							className="text-muted-foreground hover:text-foreground"
							onClick={() => setSelectedRepoId(null)}
						>
							<ArrowLeft className="size-3.5" strokeWidth={2} />
						</Button>
					) : (
						<FolderInput
							className="size-3.5 text-muted-foreground"
							strokeWidth={1.8}
						/>
					)}
					<DialogTitle className="flex-1 text-[13px] font-medium tracking-[-0.01em] text-foreground">
						{selectedRepoId ? selectedRepo?.name : "Import from Conductor"}
					</DialogTitle>
				</div>

				{/* Search — hidden while importing */}
				{!importing && (
					<div className="px-3 pb-2">
						<InputGroup className="bg-muted/30 shadow-none">
							<InputGroupAddon>
								<Search
									className="text-muted-foreground/60"
									strokeWidth={1.9}
								/>
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
								className="text-[13px] font-medium text-foreground placeholder:text-muted-foreground/60"
							/>
						</InputGroup>
					</div>
				)}

				{/* Content */}
				<div className="max-h-80 min-h-[6rem] overflow-y-auto px-2 pb-2">
					{importing ? (
						// --- Importing state ---
						<div className="flex flex-col items-center justify-center gap-3 py-10">
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
						// --- Workspace list ---
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
									<WorkspaceRow
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
					) : // --- Repo list ---
					filteredRepos.length > 0 ? (
						filteredRepos.map((repo) => (
							<RepoRow
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

				{/* Footer — workspace step, not importing */}
				{selectedRepoId && !loading && !importing && (
					<div className="px-4 py-3">
						<Separator className="mb-3 bg-border" />
						{importError && (
							<p
								className="mb-2 text-[11px] leading-relaxed text-red-400/90"
								title={importError}
							>
								{importError}
							</p>
						)}
						<Button
							disabled={selectedIds.size === 0}
							onClick={handleImport}
							variant="secondary"
							className="h-8 w-full rounded-full"
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
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RepoRow({
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

function WorkspaceRow({
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

	const checkboxId = `conductor-import-workspace-${workspace.id}`;

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
