import { ChevronDown, GitBranch, Laptop, Plus, Split, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BranchPickerPopover } from "@/components/branch-picker";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceAvatar } from "@/features/navigation/avatar";
import {
	InlineShortcutDisplay,
	ShortcutDisplay,
} from "@/features/shortcuts/shortcut-display";
import { SourceDetailView } from "@/features/source-detail";
import type { RepositoryCreateOption, WorkspaceMode } from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { CreateBranchDialog } from "./create-branch-dialog";

const SWITCH_REPOSITORY_SHORTCUT = "Shift+Tab";

function defaultBranchPrefix(repo: RepositoryCreateOption | null): string {
	if (!repo) return "";
	switch (repo.branchPrefixType ?? null) {
		case "username":
			return repo.forgeLogin ? `${repo.forgeLogin}/` : "";
		case "custom":
			return repo.branchPrefixCustom ? `${repo.branchPrefixCustom}/` : "";
		case "none":
			return "";
		default:
			return repo.forgeLogin ? `${repo.forgeLogin}/` : "";
	}
}

type WorkspaceStartPageProps = {
	repositories: RepositoryCreateOption[];
	selectedRepository: RepositoryCreateOption | null;
	onSelectRepository: (repository: RepositoryCreateOption) => void;
	selectedBranch: string;
	branches: string[];
	branchesLoading: boolean;
	onOpenBranchPicker: () => void;
	onSelectBranch: (branch: string) => void;
	mode: WorkspaceMode;
	onModeChange: (mode: WorkspaceMode) => void;
	/** Called when the user creates a new branch via the picker footer.
	 * Caller is responsible for the underlying `git checkout -b`. */
	onCreateAndCheckoutBranch?: (branch: string) => Promise<void>;
	previewCard?: ContextCard | null;
	previewAppendContextTarget?: ComposerInsertTarget;
	onClosePreview?: () => void;
	children: React.ReactNode;
};

export function WorkspaceStartPage({
	repositories,
	selectedRepository,
	onSelectRepository,
	selectedBranch,
	branches,
	branchesLoading,
	onOpenBranchPicker,
	onSelectBranch,
	mode,
	onModeChange,
	onCreateAndCheckoutBranch,
	previewCard = null,
	previewAppendContextTarget,
	onClosePreview,
	children,
}: WorkspaceStartPageProps) {
	const [createBranchOpen, setCreateBranchOpen] = useState(false);
	const selectNextRepository = useCallback(() => {
		if (repositories.length === 0) {
			return;
		}

		const currentIndex = selectedRepository
			? repositories.findIndex(
					(repository) => repository.id === selectedRepository.id,
				)
			: -1;
		const nextIndex = (currentIndex + 1) % repositories.length;
		onSelectRepository(repositories[nextIndex]);
	}, [onSelectRepository, repositories, selectedRepository]);

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || !event.shiftKey || event.defaultPrevented) {
				return;
			}

			const activeElement = document.activeElement;
			if (!(activeElement instanceof HTMLElement)) {
				return;
			}

			if (!activeElement.closest('[aria-label="Workspace composer"]')) {
				return;
			}

			event.preventDefault();
			selectNextRepository();
		};

		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, [selectNextRepository]);

	useEffect(() => {
		if (!previewCard || !onClosePreview) {
			return;
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) {
				return;
			}
			event.preventDefault();
			onClosePreview();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClosePreview, previewCard]);

	return (
		<div className="flex min-h-0 flex-1 justify-center">
			<div className="relative h-full min-h-0 w-full max-w-5xl">
				<div
					className={cn(
						"grid w-full min-h-0 transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
						previewCard
							? "h-[calc(100%-12rem)] grid-rows-[1fr] opacity-100"
							: "h-0 grid-rows-[0fr] opacity-0",
					)}
				>
					<div className="min-h-0 overflow-hidden">
						<div className="relative flex h-full min-h-[320px] flex-col overflow-hidden bg-background">
							<div className="flex h-8 shrink-0 items-center justify-between gap-3 border-border/60 border-b px-3">
								{previewCard ? (
									<h2 className="flex h-full min-w-0 flex-1 translate-y-[2px] items-center text-[13px] font-medium leading-5 text-foreground">
										<span className="min-w-0 truncate">
											{previewCard.title}
										</span>
										<span className="ml-2 shrink-0 font-normal text-muted-foreground">
											#{sourceCardNumber(previewCard)}
										</span>
									</h2>
								) : (
									<div className="min-w-0 flex-1" />
								)}
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={onClosePreview}
									aria-label="Close source preview"
									className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
								>
									<ShortcutDisplay hotkey="Escape" />
									<X className="size-3.5" strokeWidth={1.8} />
								</Button>
							</div>
							<div className="min-h-0 flex-1 px-0 pb-3">
								{previewCard ? (
									<SourceDetailView
										card={previewCard}
										appendContextTarget={previewAppendContextTarget}
									/>
								) : null}
							</div>
							<div
								aria-hidden="true"
								className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background/55 via-background/24 to-transparent shadow-[inset_0_-10px_18px_color-mix(in_oklch,var(--background)_55%,transparent)]"
							/>
						</div>
					</div>
				</div>

				<div
					className={cn(
						"absolute left-1/2 flex w-full max-w-3xl -translate-x-1/2 flex-col items-center transition-[top,transform,opacity,gap] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
						previewCard
							? "top-[calc(100%-11rem)] gap-0"
							: "top-1/2 gap-7 -translate-y-1/2",
					)}
				>
					<div
						aria-hidden={previewCard ? true : undefined}
						className={cn(
							"relative w-full overflow-hidden transition-[height,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
							previewCard
								? "pointer-events-none h-0 translate-y-2 opacity-0"
								: "h-10 translate-y-0 opacity-100",
						)}
					>
						<div
							className={cn(
								"absolute top-0 flex items-center gap-x-2 whitespace-nowrap text-center font-semibold leading-tight tracking-normal text-foreground transition-[left,transform,font-size] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
								"left-1/2 -translate-x-1/2 text-[24px]",
							)}
						>
							<span
								className={cn(
									"inline-block overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
									previewCard
										? "max-w-0 -translate-y-1 opacity-0"
										: "max-w-[22rem] translate-y-0 opacity-100",
								)}
							>
								What should we build
							</span>
							<span
								className={cn(
									"inline-block overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
									previewCard
										? "max-w-0 -translate-y-1 opacity-0"
										: "max-w-[2rem] translate-y-0 opacity-100",
								)}
							>
								in
							</span>
							<DropdownMenu>
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												disabled={repositories.length === 0}
												className={cn(
													"font-semibold leading-none tracking-normal transition-[height,max-width,padding,font-size,gap] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
													"h-9 max-w-[18rem] gap-1.5 px-2 text-[24px]",
												)}
											>
												{selectedRepository ? (
													<>
														<WorkspaceAvatar
															repoIconSrc={selectedRepository.repoIconSrc}
															repoInitials={selectedRepository.repoInitials}
															repoName={selectedRepository.name}
															title={selectedRepository.name}
															className={cn(
																"rounded-md transition-[width,height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
																"size-6",
															)}
															fallbackClassName="text-[9px]"
														/>
														<span className="min-w-0 truncate">
															{selectedRepository.name}
														</span>
														<ChevronDown
															className={cn(
																"shrink-0 text-muted-foreground transition-[width,height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
																"size-4",
															)}
															strokeWidth={2}
														/>
													</>
												) : (
													<span className="text-muted-foreground">
														a repository
													</span>
												)}
											</Button>
										</DropdownMenuTrigger>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										sideOffset={4}
										className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
									>
										<span>Switch repository</span>
										<InlineShortcutDisplay
											hotkey={SWITCH_REPOSITORY_SHORTCUT}
											className="text-background/60"
										/>
									</TooltipContent>
								</Tooltip>
								<DropdownMenuContent align="center" className="min-w-56">
									{repositories.map((repository) => (
										<DropdownMenuItem
											key={repository.id}
											onClick={() => onSelectRepository(repository)}
											className="gap-2"
										>
											<WorkspaceAvatar
												repoIconSrc={repository.repoIconSrc}
												repoInitials={repository.repoInitials}
												repoName={repository.name}
												title={repository.name}
												className="size-5 rounded-md"
												fallbackClassName="text-[8px]"
											/>
											<span className="min-w-0 flex-1 truncate">
												{repository.name}
											</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
							<span
								className={cn(
									"inline-block overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
									previewCard
										? "max-w-0 -translate-y-1 opacity-0"
										: "max-w-[2rem] translate-y-0 opacity-100",
								)}
							>
								?
							</span>
						</div>
					</div>
					<div className="w-full px-4">{children}</div>
					<div
						className={cn(
							"flex w-full items-center gap-2 overflow-hidden px-4 transition-[height,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
							previewCard
								? "h-10 translate-y-0.5 opacity-100"
								: "-mt-5 h-7 translate-y-0 opacity-100",
						)}
					>
						{previewCard ? (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										disabled={repositories.length === 0}
										className="inline-flex h-7 max-w-[13rem] cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
									>
										{selectedRepository ? (
											<>
												<WorkspaceAvatar
													repoIconSrc={selectedRepository.repoIconSrc}
													repoInitials={selectedRepository.repoInitials}
													repoName={selectedRepository.name}
													title={selectedRepository.name}
													className="size-4 rounded-md"
													fallbackClassName="text-[7px]"
												/>
												<span className="min-w-0 truncate">
													{selectedRepository.name}
												</span>
												<ChevronDown
													className="size-3 shrink-0 text-muted-foreground"
													strokeWidth={2}
												/>
											</>
										) : (
											<span className="truncate">Repository</span>
										)}
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="min-w-56">
									{repositories.map((repository) => (
										<DropdownMenuItem
											key={repository.id}
											onClick={() => onSelectRepository(repository)}
											className="gap-2"
										>
											<WorkspaceAvatar
												repoIconSrc={repository.repoIconSrc}
												repoInitials={repository.repoInitials}
												repoName={repository.name}
												title={repository.name}
												className="size-5 rounded-md"
												fallbackClassName="text-[8px]"
											/>
											<span className="min-w-0 flex-1 truncate">
												{repository.name}
											</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											disabled={!selectedRepository}
											className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
										>
											{mode === "local" ? (
												<Laptop
													className="size-3.5 shrink-0"
													strokeWidth={1.8}
												/>
											) : (
												<Split
													className="size-3.5 shrink-0 rotate-90"
													strokeWidth={1.8}
												/>
											)}
											<span>
												{mode === "local" ? "Work locally" : "New worktree"}
											</span>
											<ChevronDown
												className="size-3 shrink-0 text-muted-foreground"
												strokeWidth={2}
											/>
										</button>
									</DropdownMenuTrigger>
								</TooltipTrigger>
								<TooltipContent
									side="top"
									sideOffset={4}
									className="rounded-md px-2 text-[12px] leading-none"
								>
									Select where to run the task
								</TooltipContent>
							</Tooltip>
							<DropdownMenuContent align="start" className="w-fit min-w-36">
								<DropdownMenuItem
									onClick={() => onModeChange("local")}
									className="gap-2 pr-3"
									data-checked={mode === "local" ? "true" : undefined}
								>
									<Laptop className="size-3.5" strokeWidth={1.8} />
									<span>Work locally</span>
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() => onModeChange("worktree")}
									className="gap-2 pr-3"
									data-checked={mode === "worktree" ? "true" : undefined}
								>
									<Split className="size-3.5 rotate-90" strokeWidth={1.8} />
									<span>New worktree</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<Tooltip>
							<BranchPickerPopover
								currentBranch={selectedBranch}
								branches={branches}
								loading={branchesLoading}
								onOpen={onOpenBranchPicker}
								onSelect={onSelectBranch}
								renderFooter={
									mode === "local" && onCreateAndCheckoutBranch
										? ({ close }) => (
												<button
													type="button"
													className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
													onClick={() => {
														close();
														setCreateBranchOpen(true);
													}}
												>
													<Plus className="size-3.5" strokeWidth={2} />
													<span>Create and checkout new branch…</span>
												</button>
											)
										: undefined
								}
							>
								<TooltipTrigger asChild>
									<button
										type="button"
										disabled={!selectedRepository}
										className="inline-flex h-7 max-w-[13rem] cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
									>
										<GitBranch
											className="size-3.5 shrink-0"
											strokeWidth={1.8}
										/>
										<span className="min-w-0 truncate">
											{mode === "local"
												? selectedBranch
												: `${selectedRepository?.remote ?? "origin"}/${selectedBranch}`}
										</span>
										<ChevronDown
											className="size-3 shrink-0 text-muted-foreground"
											strokeWidth={2}
										/>
									</button>
								</TooltipTrigger>
							</BranchPickerPopover>
							<TooltipContent
								side="top"
								sideOffset={4}
								className="rounded-md px-2 text-[12px] leading-none"
							>
								{mode === "local"
									? "Switch branch"
									: "What branch should this task start from?"}
							</TooltipContent>
						</Tooltip>
						<CreateBranchDialog
							open={createBranchOpen}
							onOpenChange={setCreateBranchOpen}
							defaultPrefix={defaultBranchPrefix(selectedRepository)}
							existingBranches={branches}
							onSubmit={async (branch) => {
								if (!onCreateAndCheckoutBranch) return;
								await onCreateAndCheckoutBranch(branch);
							}}
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

function sourceCardNumber(card: ContextCard): string {
	if (
		card.meta.type === "github_issue" ||
		card.meta.type === "github_pr" ||
		card.meta.type === "github_discussion"
	) {
		return String(card.meta.number);
	}

	const idx = card.externalId.lastIndexOf("#");
	return idx === -1 ? "" : card.externalId.slice(idx + 1);
}
