import { Check, ChevronDown, GitBranch, LoaderCircle } from "lucide-react";
import { useCallback, useState } from "react";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	listRemoteBranches,
	listRepoRemotes,
	prefetchRemoteRefs,
	type RepositoryCreateOption,
	updateRepositoryDefaultBranch,
	updateRepositoryRemote,
} from "@/lib/api";
import { cn } from "@/lib/utils";

export function RepositorySettingsPanel({
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
