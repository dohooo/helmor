import {
	ChevronDown,
	FolderPlus,
	GitBranch,
	GitBranchPlus,
	GitMerge,
	Laptop,
	MessageCircle,
	Plus,
	Split,
	X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	BranchPickerPopover,
	resolveBranchSource,
} from "@/components/branch-picker";
import { TrafficLightSpacer } from "@/components/chrome/traffic-light-spacer";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceAvatar } from "@/features/navigation/avatar";
import { getShortcut } from "@/features/shortcuts/registry";
import {
	InlineShortcutDisplay,
	ShortcutDisplay,
} from "@/features/shortcuts/shortcut-display";
import { useAppShortcuts } from "@/features/shortcuts/use-app-shortcuts";
import { SourceDetailView } from "@/features/source-detail";
import type {
	BranchPickerEntry,
	RepositoryCreateOption,
	WorkspaceBranchIntent,
	WorkspaceMode,
} from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import { I18nText, useI18n } from "@/lib/i18n";
import { useSettings } from "@/lib/settings";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";
import { publishShellEvent } from "@/shell/event-bus";
import { CreateBranchDialog } from "./create-branch-dialog";

const COMPACT_TRAFFIC_LIGHT_SPACER_WIDTH = 60;
const PREVIEW_TRAFFIC_LIGHT_SPACER_WIDTH = 52;

function defaultBranchPrefix(repo: RepositoryCreateOption | null): string {
	if (!repo) return "";
	switch (repo.branchPrefixType ?? null) {
		case "username":
			return repo.forgeLogin ? `${repo.forgeLogin}/` : "";
		case "custom":
			return repo.branchPrefixCustom ?? "";
		case "none":
			return "";
		default:
			return repo.forgeLogin ? `${repo.forgeLogin}/` : "";
	}
}

/** Helper to extract "owner/repo" from remote URL */
function extractRepoName(remoteUrl?: string | null): string | null {
	if (!remoteUrl) return null;

	// Match github.com/owner/repo or gitlab.com/owner/repo patterns
	const match = remoteUrl.match(/[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
	return match ? match[1] : null;
}

function RepositoryPicker({
	repositories,
	selectedRepository,
	onSelect,
	disabled,
	showFullRepoName = true,
}: {
	repositories: RepositoryCreateOption[];
	selectedRepository: RepositoryCreateOption | null;
	onSelect: (repo: RepositoryCreateOption) => void;
	disabled?: boolean;
	showFullRepoName?: boolean;
}) {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);

	const handleSelect = useCallback(
		(repoId: string) => {
			const repo = repositories.find((r) => r.id === repoId);
			if (repo) {
				onSelect(repo);
				setOpen(false);
			}
		},
		[repositories, onSelect],
	);

	// Keyboard handler for number keys 1-9
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			const key = event.key;
			if (/^[1-9]$/.test(key) && !event.metaKey && !event.ctrlKey) {
				event.preventDefault();
				const index = Number.parseInt(key, 10) - 1;
				if (index < repositories.length) {
					handleSelect(repositories[index].id);
				}
			}
		},
		[repositories, handleSelect],
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					disabled={disabled}
					className="h-9 max-w-[18rem] gap-1.5 px-2 text-[24px] font-semibold leading-none tracking-normal transition-[height,max-width,padding,font-size,gap] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
				>
					{selectedRepository ? (
						<>
							<WorkspaceAvatar
								repoIconSrc={selectedRepository.repoIconSrc}
								repoInitials={selectedRepository.repoInitials}
								repoName={selectedRepository.name}
								title={selectedRepository.name}
								className="size-6 rounded-md transition-[width,height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
								fallbackClassName="text-nano"
							/>
							<span className="min-w-0 truncate">
								{selectedRepository.name}
							</span>
							<ChevronDown
								className="size-4 shrink-0 text-muted-foreground transition-[width,height] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
								strokeWidth={2}
							/>
						</>
					) : (
						<span className="text-muted-foreground">
							<I18nText source="repository2" />
						</span>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="center" className="w-96 p-0">
				<Command onKeyDown={handleKeyDown}>
					<CommandInput placeholder={t("searchRepositories")} className="h-9" />
					<CommandList className="max-h-80">
						<CommandEmpty>
							<I18nText source="noRepositoriesFound" />
						</CommandEmpty>
						{repositories.slice(0, 9).map((repository, index) => {
							const repoName = extractRepoName(repository.remoteUrl);
							return (
								<CommandItem
									key={repository.id}
									value={`${repository.name} ${repoName || ""}`}
									onSelect={() => handleSelect(repository.id)}
									className="gap-2"
								>
									{/* Number badge for first 9 repos */}
									<kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
										{index + 1}
									</kbd>
									<WorkspaceAvatar
										repoIconSrc={repository.repoIconSrc}
										repoInitials={repository.repoInitials}
										repoName={repository.name}
										title={repository.name}
										className="size-5 rounded-md"
										fallbackClassName="text-nano"
									/>
									<div className="flex min-w-0 flex-1 flex-col">
										{showFullRepoName && repoName ? (
											<>
												<span className="truncate text-[13px] font-medium">
													{repoName}
												</span>
												<span className="truncate text-[11px] text-muted-foreground">
													{repository.name}
												</span>
											</>
										) : (
											<span className="truncate text-[13px]">
												{repository.name}
											</span>
										)}
									</div>
								</CommandItem>
							);
						})}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

type WorkspaceStartPageProps = {
	repositories: RepositoryCreateOption[];
	selectedRepository: RepositoryCreateOption | null;
	onSelectRepository: (repository: RepositoryCreateOption) => void;
	selectedBranch: string;
	branches: BranchPickerEntry[];
	branchesLoading: boolean;
	onOpenBranchPicker: () => void;
	onSelectBranch: (branch: string) => void;
	mode: WorkspaceMode;
	onModeChange: (mode: WorkspaceMode) => void;
	/** Worktree mode only. */
	branchIntent: WorkspaceBranchIntent;
	onBranchIntentChange: (intent: WorkspaceBranchIntent) => void;
	/** Called when the user creates a new branch via the picker footer.
	 * Caller is responsible for the underlying `git checkout -b`. */
	onCreateAndCheckoutBranch?: (branch: string) => Promise<void>;
	previewCard?: ContextCard | null;
	previewAppendContextTarget?: ComposerInsertTarget;
	headerLeading?: React.ReactNode;
	showWindowSafeTop?: boolean;
	onClosePreview?: () => void;
	/** Quick panel layout: pin the composer to the bottom edge and center
	 * the heading in the space above it (instead of centering the whole
	 * block at mid-height). */
	composerAtBottom?: boolean;
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
	branchIntent,
	onBranchIntentChange,
	onCreateAndCheckoutBranch,
	previewCard = null,
	previewAppendContextTarget,
	headerLeading,
	showWindowSafeTop = false,
	onClosePreview,
	composerAtBottom = false,
	children,
}: WorkspaceStartPageProps) {
	const { t } = useI18n();
	const [createBranchOpen, setCreateBranchOpen] = useState(false);
	// Split the localized heading on the {repo} token so the repo picker keeps
	// its place while word order follows each language (en: text→repo→"?",
	// zh: "在 "→repo→" 里构建什么？").
	const [buildHeadingBefore, buildHeadingAfter] = t("whatShouldWeBuildRepo")
		.split("{repo}")
		.map((part) => part.trim());

	// Local mode mirrors git DWIM (local-first) for icon resolution; UseBranch
	// has the same shape. Worktree mode follows the user-picked intent.
	const effectivePickerIntent: WorkspaceBranchIntent =
		mode === "worktree" ? branchIntent : "use_branch";
	const selectedBranchEntry = branches.find((b) => b.name === selectedBranch);
	const selectedBranchSource: "local" | "remote" = selectedBranchEntry
		? resolveBranchSource(selectedBranchEntry, effectivePickerIntent)
		: // Unknown branch (e.g. pending new from the "Create and checkout"
			// footer) — treat as local: no `origin/` prefix in the pill.
			"local";

	const { settings } = useSettings();
	const cycleRepositoryShortcut = getShortcut(
		settings.shortcuts,
		"startSurface.cycleRepository",
	);
	const justChatShortcut = getShortcut(
		settings.shortcuts,
		"workspace.justChat",
	);

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

	// Cycle-repository goes through the central shortcuts registry. Its
	// `start-composer` scope is a sibling of `workspace-composer`, so the
	// Shift+Tab plan-mode toggle that lives on the workspace composer does
	// NOT fire on the start surface (the start surface composer carries
	// `data-focus-scope="start-composer"`).
	useAppShortcuts({
		overrides: settings.shortcuts,
		handlers: [
			{
				id: "startSurface.cycleRepository",
				callback: selectNextRepository,
				enabled: repositories.length > 1,
			},
		],
	});

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
		<div
			data-focus-scope="start-composer"
			className="relative flex min-h-0 flex-1 justify-center"
		>
			{headerLeading ? (
				<div className="absolute left-0 top-0 z-30 flex h-9 items-center">
					<TrafficLightSpacer
						side="left"
						width={COMPACT_TRAFFIC_LIGHT_SPACER_WIDTH}
						className="hidden max-[960px]:block"
					/>
					{headerLeading}
				</div>
			) : null}
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
							<div
								className="relative z-20 flex h-8 shrink-0 items-center justify-between gap-3 border-border/60 border-b px-3"
								data-tauri-drag-region
							>
								{showWindowSafeTop ? (
									<TrafficLightSpacer
										side="left"
										width={PREVIEW_TRAFFIC_LIGHT_SPACER_WIDTH}
									/>
								) : null}
								{previewCard ? (
									<h2
										data-tauri-drag-region
										className="flex h-full min-w-0 flex-1 translate-y-[2px] items-center text-ui font-medium leading-5 text-foreground"
									>
										<span className="min-w-0 truncate">
											{previewCard.title}
										</span>
										<span className="ml-2 shrink-0 font-normal text-muted-foreground">
											#{sourceCardNumber(previewCard)}
										</span>
									</h2>
								) : (
									<div data-tauri-drag-region className="min-w-0 flex-1" />
								)}
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={onClosePreview}
									aria-label="closeSourcePreview"
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
						composerAtBottom
							? "inset-y-0 gap-7 pb-3"
							: previewCard
								? "top-[calc(100%-11rem)] gap-0"
								: "top-1/2 gap-7 -translate-y-1/2",
					)}
				>
					<div
						aria-hidden={previewCard ? true : undefined}
						className={cn(
							"relative w-full overflow-hidden transition-[height,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
							composerAtBottom
								? "min-h-0 flex-1"
								: previewCard
									? "pointer-events-none h-0 translate-y-2 opacity-0"
									: "h-10 translate-y-0 opacity-100",
						)}
					>
						<div
							className={cn(
								"absolute flex items-center gap-x-2 whitespace-nowrap text-center font-semibold leading-tight tracking-normal text-foreground transition-[left,transform,font-size] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
								"left-1/2 -translate-x-1/2 text-[24px]",
								composerAtBottom ? "top-1/2 -translate-y-1/2" : "top-0",
							)}
						>
							{mode === "chat" ? (
								<span
									className={cn(
										"inline-block overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
										previewCard
											? "max-w-0 -translate-y-1 opacity-0"
											: "max-w-[32rem] translate-y-0 opacity-100",
									)}
								>
									<I18nText source="whatShouldWeWork" />
								</span>
							) : (
								<>
									<span
										className={cn(
											"inline-block overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
											previewCard
												? "max-w-0 -translate-y-1 opacity-0"
												: "max-w-[24rem] translate-y-0 opacity-100",
										)}
									>
										{buildHeadingBefore}
									</span>
									<Tooltip>
										<TooltipTrigger asChild>
											<div>
												<RepositoryPicker
													repositories={repositories}
													selectedRepository={selectedRepository}
													onSelect={onSelectRepository}
													disabled={repositories.length === 0}
													showFullRepoName={true}
												/>
											</div>
										</TooltipTrigger>
										<TooltipContent
											side="top"
											sideOffset={4}
											className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
										>
											<I18nText source="switchRepository" />
											<InlineShortcutDisplay
												hotkey={cycleRepositoryShortcut}
												className="text-background/60"
											/>
										</TooltipContent>
									</Tooltip>
									<span
										className={cn(
											"inline-block overflow-hidden transition-[max-width,opacity,transform] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]",
											previewCard
												? "max-w-0 -translate-y-1 opacity-0"
												: "max-w-[12rem] translate-y-0 opacity-100",
										)}
									>
										{buildHeadingAfter}
									</span>
								</>
							)}
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
						{/* Preview-mode repo selector: hidden in chat mode (no repo). */}
						{previewCard && mode !== "chat" ? (
							<Popover>
								<PopoverTrigger asChild>
									<button
										type="button"
										disabled={repositories.length === 0}
										className="inline-flex h-7 max-w-[13rem] cursor-interactive items-center gap-1 rounded-md px-1.5 text-ui font-medium text-muted-foreground transition-colors hover:bg-muted/45 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
									>
										{selectedRepository ? (
											<>
												<WorkspaceAvatar
													repoIconSrc={selectedRepository.repoIconSrc}
													repoInitials={selectedRepository.repoInitials}
													repoName={selectedRepository.name}
													title={selectedRepository.name}
													className="size-4 rounded-md"
													fallbackClassName="text-nano"
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
											<span className="truncate">
												<I18nText source="repository" />
											</span>
										)}
									</button>
								</PopoverTrigger>
								<PopoverContent align="start" className="w-96 p-0">
									<Command
										onKeyDown={(event: React.KeyboardEvent) => {
											const key = event.key;
											if (
												/^[1-9]$/.test(key) &&
												!event.metaKey &&
												!event.ctrlKey
											) {
												event.preventDefault();
												const index = Number.parseInt(key, 10) - 1;
												if (index < repositories.length) {
													onSelectRepository(repositories[index]);
												}
											}
										}}
									>
										<CommandInput
											placeholder={t("searchRepositories")}
											className="h-9"
										/>
										<CommandList className="max-h-80">
											<CommandEmpty>
												<I18nText source="noRepositoriesFound" />
											</CommandEmpty>
											{repositories.slice(0, 9).map((repository, index) => {
												const repoName = extractRepoName(repository.remoteUrl);
												return (
													<CommandItem
														key={repository.id}
														value={`${repository.name} ${repoName || ""}`}
														onSelect={() => onSelectRepository(repository)}
														className="gap-2"
													>
														<kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
															{index + 1}
														</kbd>
														<WorkspaceAvatar
															repoIconSrc={repository.repoIconSrc}
															repoInitials={repository.repoInitials}
															repoName={repository.name}
															title={repository.name}
															className="size-5 rounded-md"
															fallbackClassName="text-nano"
														/>
														<div className="flex min-w-0 flex-1 flex-col">
															{repoName ? (
																<>
																	<span className="truncate text-[13px] font-medium">
																		{repoName}
																	</span>
																	<span className="truncate text-[11px] text-muted-foreground">
																		{repository.name}
																	</span>
																</>
															) : (
																<span className="truncate text-[13px]">
																	{repository.name}
																</span>
															)}
														</div>
													</CommandItem>
												);
											})}
										</CommandList>
									</Command>
								</PopoverContent>
							</Popover>
						) : null}
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											// Chat mode is always enabled (no repo needed);
											// other modes require a selected repository.
											disabled={mode !== "chat" && !selectedRepository}
											className="inline-flex h-7 cursor-interactive items-center gap-1 rounded-md px-1.5 text-ui font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
										>
											{mode === "local" ? (
												<Laptop
													className="size-3.5 shrink-0"
													strokeWidth={1.8}
												/>
											) : mode === "chat" ? (
												<MessageCircle
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
												{mode === "local"
													? t("workLocally")
													: mode === "chat"
														? t("justChat")
														: t("newWorktree")}
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
									className="rounded-md px-2 text-small leading-none"
								>
									<I18nText source="selectWhereRunTask" />
								</TooltipContent>
							</Tooltip>
							{/* Skip focus return so the wrapping Tooltip doesn't re-open via onFocus after selection. */}
							<DropdownMenuContent
								align="start"
								className="w-fit min-w-36"
								onCloseAutoFocus={(event) => event.preventDefault()}
							>
								{repositories.length === 0 ? (
									// No repos → swap the repo-bound modes for an "Add a
									// repository" CTA that fires `helmor:open-add-repository`
									// (sidebar listener opens its add-repo sub-menu).
									<>
										<DropdownMenuItem
											onClick={() =>
												publishShellEvent({ type: "open-add-repository" })
											}
											className="gap-2 pr-3"
										>
											<FolderPlus className="size-3.5" strokeWidth={1.8} />
											<I18nText source="addRepository" />
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() => onModeChange("chat")}
											className="gap-2 pr-3"
											data-checked="true"
										>
											<MessageCircle className="size-3.5" strokeWidth={1.8} />
											<I18nText source="justChat" />
											{justChatShortcut ? (
												<InlineShortcutDisplay
													hotkey={justChatShortcut}
													className="ml-auto text-muted-foreground"
												/>
											) : null}
										</DropdownMenuItem>
									</>
								) : (
									<>
										<DropdownMenuItem
											onClick={() => onModeChange("local")}
											className="gap-2 pr-3"
											data-checked={mode === "local" ? "true" : undefined}
										>
											<Laptop className="size-3.5" strokeWidth={1.8} />
											<I18nText source="workLocally" />
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => onModeChange("worktree")}
											className="gap-2 pr-3"
											data-checked={mode === "worktree" ? "true" : undefined}
										>
											<Split className="size-3.5 rotate-90" strokeWidth={1.8} />
											<I18nText source="newWorktree" />
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => onModeChange("chat")}
											className="gap-2 pr-3"
											data-checked={mode === "chat" ? "true" : undefined}
										>
											<MessageCircle className="size-3.5" strokeWidth={1.8} />
											<I18nText source="justChat" />
											{justChatShortcut ? (
												<InlineShortcutDisplay
													hotkey={justChatShortcut}
													className="ml-auto text-muted-foreground"
												/>
											) : null}
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
						{/* Branch intent picker. Worktree mode only. */}
						{mode === "worktree" ? (
							<DropdownMenu>
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>
											<button
												type="button"
												disabled={!selectedRepository}
												className="inline-flex h-7 cursor-interactive items-center gap-1 rounded-md px-1.5 text-ui font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
											>
												{branchIntent === "use_branch" ? (
													<GitMerge
														className="size-3.5 shrink-0"
														strokeWidth={1.8}
													/>
												) : (
													<GitBranchPlus
														className="size-3.5 shrink-0"
														strokeWidth={1.8}
													/>
												)}
												<span>
													{branchIntent === "use_branch"
														? t("reuse")
														: t("branchOff")}
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
										className="rounded-md px-2 text-small leading-none"
									>
										{branchIntent === "use_branch"
											? t("checkOutPickedBranchDirectly")
											: t("forkFreshBranchOffPickedBase")}
									</TooltipContent>
								</Tooltip>
								{/* Skip focus return so the wrapping Tooltip doesn't re-open via onFocus after selection. */}
								<DropdownMenuContent
									align="start"
									className="w-72"
									onCloseAutoFocus={(event) => event.preventDefault()}
								>
									<DropdownMenuItem
										onClick={() => onBranchIntentChange("from_branch")}
										className="flex-col items-start gap-1 pr-3"
										data-checked={
											branchIntent === "from_branch" ? "true" : undefined
										}
									>
										<div className="flex items-center gap-2">
											<GitBranchPlus className="size-3.5" strokeWidth={1.8} />
											<I18nText source="branchOff" />
										</div>
										<span className="pl-[1.375rem] text-mini text-muted-foreground">
											<I18nText source="forkFreshBranchOffPickedBase" />
										</span>
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={() => onBranchIntentChange("use_branch")}
										className="flex-col items-start gap-1 pr-3"
										data-checked={
											branchIntent === "use_branch" ? "true" : undefined
										}
									>
										<div className="flex items-center gap-2">
											<GitMerge className="size-3.5" strokeWidth={1.8} />
											<I18nText source="reuse" />
										</div>
										<span className="pl-[1.375rem] text-mini text-muted-foreground">
											<I18nText source="checkOutPickedBranchDirectly" />
										</span>
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
						{/* Branch picker: hidden in chat mode (no branches). */}
						{mode !== "chat" ? (
							<>
								<Tooltip>
									<BranchPickerPopover
										currentBranch={selectedBranch}
										entries={branches}
										loading={branchesLoading}
										onOpen={onOpenBranchPicker}
										onSelect={onSelectBranch}
										// Skip focus return so the wrapping Tooltip doesn't re-open via onFocus after selection.
										onCloseAutoFocus={(event) => event.preventDefault()}
										renderFooter={
											mode === "local" && onCreateAndCheckoutBranch
												? ({ close }) => (
														<button
															type="button"
															className="flex w-full cursor-interactive items-center gap-2 rounded-md px-2 py-1.5 text-left text-small text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
															onClick={() => {
																close();
																setCreateBranchOpen(true);
															}}
														>
															<Plus className="size-3.5" strokeWidth={2} />
															<span>
																<I18nText source="createCheckoutNewBranch" />
															</span>
														</button>
													)
												: undefined
										}
									>
										<TooltipTrigger asChild>
											<button
												type="button"
												disabled={!selectedRepository}
												className="inline-flex h-7 max-w-[13rem] cursor-interactive items-center gap-1 rounded-md px-1.5 text-ui font-medium text-muted-foreground outline-none transition-colors hover:bg-muted/45 hover:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
											>
												<GitBranch
													className="size-3.5 shrink-0"
													strokeWidth={1.8}
												/>
												<span className="min-w-0 truncate">
													{/* Pill prefix follows the resolved source of the
													 *  selected branch: `origin/<x>` when it'll come
													 *  from remote, bare `<x>` when from local. */}
													{selectedBranchSource === "remote"
														? `${selectedRepository?.remote ?? "origin"}/${selectedBranch}`
														: selectedBranch}
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
										className="rounded-md px-2 text-small leading-none"
									>
										{mode === "local"
											? t("miscSwitchBranch")
											: branchIntent === "use_branch"
												? t("miscBranchToReuse")
												: t("miscBaseToForkOff")}
									</TooltipContent>
								</Tooltip>
								<CreateBranchDialog
									open={createBranchOpen}
									onOpenChange={setCreateBranchOpen}
									defaultPrefix={defaultBranchPrefix(selectedRepository)}
									existingBranches={branches.map((b) => b.name)}
									onSubmit={async (branch) => {
										if (!onCreateAndCheckoutBranch) return;
										await onCreateAndCheckoutBranch(branch);
									}}
								/>
							</>
						) : null}
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
		card.meta.type === "github_discussion" ||
		card.meta.type === "gitlab_issue" ||
		card.meta.type === "gitlab_mr"
	) {
		return String(card.meta.number);
	}

	// `#` is GitHub / GitLab issues; `!` is GitLab MRs.
	const hashIdx = card.externalId.lastIndexOf("#");
	const bangIdx = card.externalId.lastIndexOf("!");
	const idx = Math.max(hashIdx, bangIdx);
	return idx === -1 ? "" : card.externalId.slice(idx + 1);
}
