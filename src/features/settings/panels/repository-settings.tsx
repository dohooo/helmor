import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BranchPickerPopover } from "@/components/branch-picker";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	deleteRepository,
	listRemoteBranches,
	listRepoRemotes,
	loadRepoScripts,
	prefetchRemoteRefs,
	type RepositoryCreateOption,
	updateRepoScripts,
	updateRepositoryDefaultBranch,
	updateRepositoryRemote,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export function RepositorySettingsPanel({
	repo,
	onRepoSettingsChanged,
	onRepoDeleted,
}: {
	repo: RepositoryCreateOption;
	onRepoSettingsChanged: () => void;
	onRepoDeleted: () => void;
}) {
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
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

			<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
				<div className="text-[13px] font-medium leading-snug text-app-foreground">
					Branch new workspaces from
				</div>
				<div className="mt-1 text-[12px] leading-snug text-app-muted">
					Each workspace is an isolated copy of your codebase.
				</div>
				<div className="mt-3">
					<BranchPickerPopover
						currentBranch={currentBranch}
						branches={branches}
						loading={loading}
						onOpen={handleOpen}
						onSelect={handleSelect}
					>
						<button
							type="button"
							className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] font-medium text-app-foreground transition-colors hover:border-app-border-strong"
						>
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
						</button>
					</BranchPickerPopover>
					{error && <p className="mt-2 text-[12px] text-red-400/90">{error}</p>}
				</div>
			</div>

			<ScriptsSection repoId={repo.id} />

			<DeleteRepoSection repo={repo} onDeleted={onRepoDeleted} />
		</div>
	);
}

function ScriptField({
	label,
	description,
	placeholder,
	value,
	locked,
	onChange,
}: {
	label: string;
	description: string;
	placeholder: string;
	value: string;
	locked: boolean;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}) {
	const textarea = (
		<Textarea
			className="mt-2 min-h-[72px] resize-y bg-app-base/30 font-mono text-[12px]"
			placeholder={placeholder}
			value={value}
			onChange={onChange}
			readOnly={locked}
			disabled={locked}
		/>
	);

	return (
		<div>
			<div className="text-[12px] font-medium text-app-foreground">{label}</div>
			<div className="mt-0.5 text-[11px] text-app-muted">{description}</div>
			{locked ? (
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>{textarea}</TooltipTrigger>
						<TooltipContent side="top">
							来自项目配置 helmor.json，无法在此编辑
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			) : (
				textarea
			)}
		</div>
	);
}

function ScriptsSection({ repoId }: { repoId: string }) {
	const queryClient = useQueryClient();
	const scriptsQuery = useQuery({
		queryKey: ["repoScripts", repoId],
		queryFn: () => loadRepoScripts(repoId),
		staleTime: 0,
	});

	const data = scriptsQuery.data;
	const setupLocked = data?.setupFromProject ?? false;
	const runLocked = data?.runFromProject ?? false;
	const archiveLocked = data?.archiveFromProject ?? false;

	const [setupScript, setSetupScript] = useState("");
	const [runScript, setRunScript] = useState("");
	const [archiveScript, setArchiveScript] = useState("");
	const initialized = useRef(false);

	useEffect(() => {
		if (!data) return;
		const shouldSyncSetup = setupLocked || !initialized.current;
		const shouldSyncRun = runLocked || !initialized.current;
		const shouldSyncArchive = archiveLocked || !initialized.current;
		if (shouldSyncSetup) setSetupScript(data.setupScript ?? "");
		if (shouldSyncRun) setRunScript(data.runScript ?? "");
		if (shouldSyncArchive) setArchiveScript(data.archiveScript ?? "");
		if (!setupLocked && !runLocked && !archiveLocked) {
			initialized.current = true;
		}
	}, [data, setupLocked, runLocked, archiveLocked]);

	// Reset when switching repos.
	useEffect(() => {
		initialized.current = false;
	}, [repoId]);

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const save = useCallback(
		(nextSetup: string, nextRun: string, nextArchive: string) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(() => {
				void updateRepoScripts(
					repoId,
					nextSetup.trim() || null,
					nextRun.trim() || null,
					nextArchive.trim() || null,
				).then(() => {
					void queryClient.invalidateQueries({
						queryKey: ["repoScripts", repoId],
					});
				});
			}, 600);
		},
		[repoId, queryClient],
	);

	const handleSetupChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setSetupScript(value);
			save(value, runScript, archiveScript);
		},
		[runScript, archiveScript, save],
	);

	const handleRunChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setRunScript(value);
			save(setupScript, value, archiveScript);
		},
		[setupScript, archiveScript, save],
	);

	const handleArchiveChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setArchiveScript(value);
			save(setupScript, runScript, value);
		},
		[setupScript, runScript, save],
	);

	return (
		<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
			<div className="text-[13px] font-medium leading-snug text-app-foreground">
				Scripts
			</div>
			<div className="mt-1 text-[12px] leading-snug text-app-muted">
				Commands that run when workspaces are set up, run, or archived.
			</div>

			<div className="mt-4 space-y-4">
				<ScriptField
					label="Setup script"
					description="Runs when a new workspace is created"
					placeholder="e.g., npm install"
					value={setupScript}
					locked={setupLocked}
					onChange={handleSetupChange}
				/>
				<ScriptField
					label="Run script"
					description="Runs when you click the play button"
					placeholder="e.g., npm run dev"
					value={runScript}
					locked={runLocked}
					onChange={handleRunChange}
				/>
				<ScriptField
					label="Archive script"
					description="Runs when a workspace is archived"
					placeholder="e.g., docker compose down"
					value={archiveScript}
					locked={archiveLocked}
					onChange={handleArchiveChange}
				/>
			</div>
		</div>
	);
}

function DeleteRepoSection({
	repo,
	onDeleted,
}: {
	repo: RepositoryCreateOption;
	onDeleted: () => void;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleDelete = useCallback(async () => {
		setDeleting(true);
		setError(null);
		try {
			await deleteRepository(repo.id);
			setConfirmOpen(false);
			onDeleted();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setDeleting(false);
		}
	}, [repo.id, onDeleted]);

	return (
		<>
			<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
				<div className="flex items-center gap-2 text-[13px] font-medium leading-snug text-app-foreground">
					<Trash2 className="size-3.5 text-destructive" strokeWidth={1.8} />
					Delete Repository
				</div>
				<div className="mt-1 text-[12px] leading-snug text-app-muted">
					Permanently remove this repository and all its workspaces, sessions,
					and messages.
				</div>
				<Button
					variant="destructive"
					size="sm"
					className="mt-3"
					onClick={() => {
						setError(null);
						setConfirmOpen(true);
					}}
				>
					Delete Repository
				</Button>
				{error && (
					<div className="mt-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
						{error}
					</div>
				)}
			</div>

			<Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<DialogContent className="max-w-[320px] gap-0 p-4">
					<DialogTitle className="text-[13px] font-semibold">
						Delete {repo.name}?
					</DialogTitle>
					<DialogDescription className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
						This will permanently delete all workspaces, sessions, and messages
						associated with{" "}
						<strong className="text-foreground/80">{repo.name}</strong>. This
						cannot be undone.
					</DialogDescription>
					<div className="mt-3 flex justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirmOpen(false)}
							disabled={deleting}
						>
							Cancel
						</Button>
						<Button
							variant="destructive"
							size="sm"
							onClick={() => void handleDelete()}
							disabled={deleting}
						>
							{deleting ? (
								<>
									<Loader2 className="mr-1.5 size-3.5 animate-spin" />
									Deleting...
								</>
							) : (
								"Delete"
							)}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
