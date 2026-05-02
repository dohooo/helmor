import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, GitBranch, X } from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useMemo,
	useState,
} from "react";
import { BranchPickerPopover } from "@/components/branch-picker";
import {
	Command,
	CommandEmpty,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceIcon } from "@/features/inbox/source-icon";
import { WorkspaceAvatar } from "@/features/navigation/avatar";
import type { RepositoryCreateOption } from "@/lib/api";
import { listRemoteBranches } from "@/lib/api";
import { repositoriesQueryOptions } from "@/lib/query-client";
import type { ContextCard } from "@/lib/sources/types";
import { SourceDetailView } from "./source-detail-views";

export type KanbanMainTab = { card: ContextCard; id: string; kind: "card" };

type KanbanMainContentProps = {
	activeTabId: string | null;
	onActiveTabChange: (tabId: string) => void;
	onCloseTab: (tabId: string) => void;
	onRepositorySelect?: (repository: RepositoryCreateOption) => void;
	tabs: KanbanMainTab[];
};

export function KanbanMainContent({
	activeTabId,
	onActiveTabChange,
	onCloseTab,
	onRepositorySelect,
	tabs,
}: KanbanMainContentProps) {
	const repositoriesQuery = useQuery(repositoriesQueryOptions());
	const repositories = repositoriesQuery.data ?? [];
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
	const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
	const selectedRepository = useMemo(
		() => repositories.find((repo) => repo.id === selectedRepoId) ?? null,
		[repositories, selectedRepoId],
	);
	const repoBranchesQuery = useQuery({
		queryKey: ["kanban", "repoBranches", selectedRepoId],
		queryFn: () => listRemoteBranches({ repoId: selectedRepoId ?? undefined }),
		enabled: Boolean(selectedRepoId),
		staleTime: 5 * 60 * 1000,
	});
	const branchOptions = repoBranchesQuery.data ?? [];
	const currentBranch =
		selectedBranch ??
		selectedRepository?.defaultBranch ??
		branchOptions[0] ??
		"";
	const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
	const stopTabActionPointerDown = (event: ReactPointerEvent) => {
		event.preventDefault();
		event.stopPropagation();
	};

	useEffect(() => {
		if (repositories.length === 0) {
			setSelectedRepoId(null);
			setSelectedBranch(null);
			return;
		}

		if (
			!selectedRepoId ||
			!repositories.some((repo) => repo.id === selectedRepoId)
		) {
			const [firstRepository] = repositories;
			setSelectedRepoId(firstRepository.id);
			setSelectedBranch(firstRepository.defaultBranch ?? null);
		}
	}, [repositories, selectedRepoId]);

	useEffect(() => {
		setSelectedBranch(selectedRepository?.defaultBranch ?? null);
	}, [selectedRepository?.id, selectedRepository?.defaultBranch]);

	useEffect(() => {
		if (!selectedRepository || selectedBranch || branchOptions.length === 0) {
			return;
		}

		setSelectedBranch(branchOptions[0]);
	}, [branchOptions, selectedBranch, selectedRepository]);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
			<header className="relative z-20 min-w-0 shrink-0">
				<div
					aria-label="Kanban content header"
					className="flex h-9 items-center gap-2 px-[18px] text-[12.5px]"
					data-tauri-drag-region
				>
					<RepositoryPicker
						repositories={repositories}
						selectedRepository={selectedRepository}
						onRepositorySelect={(repository) => {
							setSelectedRepoId(repository.id);
							setSelectedBranch(repository.defaultBranch ?? null);
							onRepositorySelect?.(repository);
						}}
					/>
					<BranchPickerPopover
						currentBranch={currentBranch}
						branches={branchOptions}
						loading={repoBranchesQuery.isFetching}
						onOpen={() => {
							if (selectedRepoId) {
								void repoBranchesQuery.refetch();
							}
						}}
						onSelect={setSelectedBranch}
					>
						<button
							type="button"
							disabled={!selectedRepository}
							className="inline-flex h-6 min-w-0 max-w-[220px] cursor-pointer items-center gap-1 rounded-md px-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
						>
							<GitBranch className="size-3.5 shrink-0" strokeWidth={1.8} />
							<span className="truncate">
								{currentBranch
									? `${selectedRepository?.remote ?? "origin"}/${currentBranch}`
									: "No branch"}
							</span>
							<ChevronDown className="size-3 shrink-0" strokeWidth={2} />
						</button>
					</BranchPickerPopover>
				</div>

				<div className="flex min-w-0 items-center px-4 pb-1">
					<div className="group/tabs-scroll relative min-w-0 flex-1 overflow-hidden">
						<div className="scrollbar-none min-w-0 max-w-full overflow-x-auto">
							{tabs.length > 0 ? (
								<Tabs
									value={activeTab?.id ?? tabs[0]?.id}
									onValueChange={onActiveTabChange}
									className="w-max min-w-full gap-0"
								>
									<TabsList
										aria-label="Inbox source tabs"
										className="inline-flex min-w-full w-max justify-start self-start"
									>
										{tabs.map((tab) => (
											<TabsTrigger
												key={tab.id}
												value={tab.id}
												className="group/tab relative h-full w-auto min-w-[6.5rem] max-w-[14rem] shrink-0 flex-none justify-start gap-1.5 overflow-hidden pr-5 text-[13px] text-muted-foreground data-[state=active]:text-foreground"
											>
												<span className="tab-content-fade flex min-w-0 flex-1 items-center gap-1.5">
													<TabIcon tab={tab} />
													<span className="truncate font-medium">
														{tab.card.externalId}
													</span>
												</span>
												<span className="pointer-events-none invisible absolute inset-y-0 right-0 flex items-center gap-0.5 pr-1 group-hover/tab:pointer-events-auto group-hover/tab:visible">
													<span
														role="button"
														aria-label={`Close ${tab.card.externalId}`}
														onPointerDown={stopTabActionPointerDown}
														onClick={(event) => {
															event.stopPropagation();
															onCloseTab(tab.id);
														}}
														className="flex cursor-pointer items-center justify-center rounded-sm p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
													>
														<X className="size-3" strokeWidth={2} />
													</span>
												</span>
											</TabsTrigger>
										))}
									</TabsList>
								</Tabs>
							) : (
								<div className="h-8 min-w-full" />
							)}
						</div>
					</div>
				</div>
			</header>

			<div className="min-h-0 flex-1 px-4 py-3">
				<KanbanTabContent tab={activeTab} />
			</div>
		</div>
	);
}

function TabIcon({ tab }: { tab: KanbanMainTab }) {
	return <SourceIcon source={tab.card.source} size={13} className="shrink-0" />;
}

function RepositoryPicker({
	onRepositorySelect,
	repositories,
	selectedRepository,
}: {
	onRepositorySelect: (repository: RepositoryCreateOption) => void;
	repositories: RepositoryCreateOption[];
	selectedRepository: RepositoryCreateOption | null;
}) {
	const [open, setOpen] = useState(false);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex h-6 min-w-0 max-w-[220px] cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent/60"
				>
					{selectedRepository ? (
						<WorkspaceAvatar
							repoIconSrc={selectedRepository.repoIconSrc}
							repoInitials={selectedRepository.repoInitials}
							repoName={selectedRepository.name}
							title={selectedRepository.name}
							className="size-4 rounded-[5px]"
							fallbackClassName="text-[7px]"
						/>
					) : null}
					<span className="truncate">
						{selectedRepository?.name ?? "Repository"}
					</span>
					<ChevronDown
						className="size-3 shrink-0 text-muted-foreground"
						strokeWidth={2}
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-[260px] p-0">
				<Command className="rounded-lg! p-0.5">
					<CommandList className="max-h-64">
						<CommandEmpty>No repositories found.</CommandEmpty>
						{repositories.map((repository) => (
							<CommandItem
								key={repository.id}
								value={`${repository.name} ${repository.defaultBranch ?? ""}`}
								onSelect={() => {
									onRepositorySelect(repository);
									setOpen(false);
								}}
								className="rounded-lg [&>svg:last-child]:hidden"
							>
								<div className="flex min-w-0 flex-1 items-center justify-between gap-3">
									<div className="flex min-w-0 items-center gap-2">
										<WorkspaceAvatar
											repoIconSrc={repository.repoIconSrc}
											repoInitials={repository.repoInitials}
											repoName={repository.name}
											title={repository.name}
											className="size-5 rounded-md"
											fallbackClassName="text-[8px]"
										/>
										<span className="truncate font-medium">
											{repository.name}
										</span>
									</div>
									{repository.id === selectedRepository?.id ? (
										<Check className="size-3.5 shrink-0" strokeWidth={2} />
									) : null}
								</div>
							</CommandItem>
						))}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function KanbanTabContent({ tab }: { tab: KanbanMainTab | null }) {
	if (!tab) {
		return null;
	}

	return <SourceDetailView card={tab.card} />;
}
