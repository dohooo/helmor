import { ChevronDown, GitBranch, X } from "lucide-react";
import { useCallback, useEffect } from "react";
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
import type { RepositoryCreateOption } from "@/lib/api";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";

const SWITCH_REPOSITORY_SHORTCUT = "Shift+Tab";

type WorkspaceStartPageProps = {
	repositories: RepositoryCreateOption[];
	selectedRepository: RepositoryCreateOption | null;
	onSelectRepository: (repository: RepositoryCreateOption) => void;
	selectedBranch: string;
	branches: string[];
	branchesLoading: boolean;
	onOpenBranchPicker: () => void;
	onSelectBranch: (branch: string) => void;
	previewCard?: ContextCard | null;
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
	previewCard = null,
	onClosePreview,
	children,
}: WorkspaceStartPageProps) {
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
							<div className="flex h-8 shrink-0 items-center justify-end border-border/60 border-b px-3">
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
							<div className="min-h-0 flex-1 px-0 pt-4 pb-3">
								{previewCard ? <SourceDetailView card={previewCard} /> : null}
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
						<BranchPickerPopover
							currentBranch={selectedBranch}
							branches={branches}
							loading={branchesLoading}
							onOpen={onOpenBranchPicker}
							onSelect={onSelectBranch}
						>
							<button
								type="button"
								disabled={!selectedRepository}
								className="inline-flex h-7 max-w-[13rem] cursor-pointer items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
							>
								<GitBranch className="size-3.5 shrink-0" strokeWidth={1.8} />
								<span className="min-w-0 truncate">
									{selectedRepository?.remote ?? "origin"}/{selectedBranch}
								</span>
								<ChevronDown
									className="size-3 shrink-0 text-muted-foreground"
									strokeWidth={2}
								/>
							</button>
						</BranchPickerPopover>
					</div>
				</div>
			</div>
		</div>
	);
}
