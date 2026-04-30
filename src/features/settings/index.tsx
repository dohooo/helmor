import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronDown,
	Minus,
	Monitor,
	Moon,
	Plus,
	Settings,
	Sun,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { ModelIcon } from "@/components/model-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarSeparator,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getShortcut } from "@/features/shortcuts/registry";
import { ShortcutsSettingsPanel } from "@/features/shortcuts/settings-panel";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	isConductorAvailable,
	loadGithubIdentitySession,
	type RepositoryCreateOption,
} from "@/lib/api";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	repositoriesQueryOptions,
} from "@/lib/query-client";
import type { ThemeMode } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { clampEffort, findModelOption } from "@/lib/workspace-helpers";
import { SettingsGroup, SettingsRow } from "./components/settings-row";
import { AccountPanel } from "./panels/account";
import { AppUpdatesPanel } from "./panels/app-updates";
import { CliInstallPanel } from "./panels/cli-install";
import { ConductorImportPanel } from "./panels/conductor-import";
import { DevToolsPanel } from "./panels/dev-tools";
import { ClaudeCustomProvidersPanel } from "./panels/model-providers";
import { RepositorySettingsPanel } from "./panels/repository-settings";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const FALLBACK_EFFORT_LEVELS = ["low", "medium", "high"];

export type SettingsSection =
	| "general"
	| "shortcuts"
	| "appearance"
	| "model"
	| "git"
	| "experimental"
	| "import"
	| "developer"
	| "account"
	| `repo:${string}`;

function sidebarSectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
): string {
	if (section.startsWith("repo:")) {
		const repoId = section.slice(5);
		return repos.find((r) => r.id === repoId)?.name ?? "Repository";
	}
	return section.charAt(0).toUpperCase() + section.slice(1);
}

function titleSectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
): string {
	return sidebarSectionLabel(section, repos);
}

export const SettingsDialog = memo(function SettingsDialog({
	open,
	workspaceId,
	workspaceRepoId,
	initialSection,
	onClose,
}: {
	open: boolean;
	workspaceId: string | null;
	workspaceRepoId: string | null;
	initialSection?: SettingsSection;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const queryClient = useQueryClient();
	const [activeSection, setActiveSection] =
		useState<SettingsSection>("general");
	const [githubLogin, setGithubLogin] = useState<string | null>(null);
	const [conductorEnabled, setConductorEnabled] = useState(false);

	useEffect(() => {
		if (open && initialSection) {
			setActiveSection(initialSection);
		}
	}, [open, initialSection]);

	const reposQuery = useQuery({
		...repositoriesQueryOptions(),
		enabled: open,
	});
	const repositories = reposQuery.data ?? [];
	const modelSectionsQuery = useQuery({
		...agentModelSectionsQueryOptions(),
		enabled: open,
	});
	const allModels = (modelSectionsQuery.data ?? []).flatMap((s) => s.options);
	const selectedDefaultModel = findModelOption(
		modelSectionsQuery.data ?? [],
		settings.defaultModelId,
	);
	const defaultEffortLevels =
		selectedDefaultModel?.effortLevels ?? FALLBACK_EFFORT_LEVELS;
	const defaultModelSupportsFastMode =
		selectedDefaultModel?.supportsFastMode === true;
	const defaultModelLabel =
		selectedDefaultModel?.label ??
		(modelSectionsQuery.isPending ? "Loading…" : "Select model");
	// Auto-clamp effort when model changes — but only after model metadata
	// has actually loaded, otherwise the fallback levels silently kill max/xhigh.
	useEffect(() => {
		if (!selectedDefaultModel) return;
		const current = settings.defaultEffort ?? "high";
		if (
			defaultEffortLevels.length > 0 &&
			!defaultEffortLevels.includes(current)
		) {
			updateSettings({
				defaultEffort: clampEffort(current, defaultEffortLevels),
			});
		}
	}, [
		selectedDefaultModel,
		settings.defaultEffort,
		defaultEffortLevels,
		updateSettings,
	]);

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

	const isDev = import.meta.env.DEV;

	const fixedSections: SettingsSection[] = [
		"general",
		"appearance",
		"model",
		"shortcuts",
		"git",
		"experimental",
		...(conductorEnabled ? (["import"] as const) : []),
		...(isDev ? (["developer"] as const) : []),
		"account",
	];

	const activeRepoId = activeSection.startsWith("repo:")
		? activeSection.slice(5)
		: null;
	const activeRepo = activeRepoId
		? repositories.find((r) => r.id === activeRepoId)
		: null;

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] overflow-hidden rounded-2xl border-border/60 bg-background p-0 shadow-2xl sm:max-w-[860px]">
				<SidebarProvider className="flex h-full min-h-0 w-full min-w-0 gap-0 overflow-hidden">
					{/* Nav sidebar */}
					<nav className="scrollbar-stable flex w-[200px] shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-sidebar-border bg-sidebar py-6">
						<SidebarGroup>
							<SidebarGroupContent>
								<SidebarMenu>
									{fixedSections.map((section) => (
										<SidebarMenuItem key={section}>
											<SidebarMenuButton
												isActive={activeSection === section}
												onClick={() => setActiveSection(section)}
											>
												{sidebarSectionLabel(section, repositories)}
											</SidebarMenuButton>
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>

						{repositories.length > 0 && (
							<>
								<SidebarSeparator />
								<SidebarGroup>
									<SidebarGroupLabel>Repositories</SidebarGroupLabel>
									<SidebarGroupContent>
										<SidebarMenu>
											{repositories.map((repo) => {
												const key: SettingsSection = `repo:${repo.id}`;
												return (
													<SidebarMenuItem key={key}>
														<SidebarMenuButton
															isActive={activeSection === key}
															onClick={() => setActiveSection(key)}
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
															<span>{repo.name}</span>
														</SidebarMenuButton>
													</SidebarMenuItem>
												);
											})}
										</SidebarMenu>
									</SidebarGroupContent>
								</SidebarGroup>
							</>
						)}
					</nav>

					{/* Main content */}
					<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
						{/* Header */}
						<div className="flex items-center border-b border-border/40 px-8 py-4">
							<DialogTitle className="text-[15px] font-semibold text-foreground">
								{activeRepo
									? activeRepo.name
									: titleSectionLabel(activeSection, repositories)}
							</DialogTitle>
						</div>

						{/* Content area */}
						<div className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 pt-1 pb-6">
							{activeSection === "general" && (
								<SettingsGroup>
									<SettingsRow
										title="Desktop Notifications"
										description="Show system notifications when sessions complete or need input"
									>
										<Switch
											checked={settings.notifications}
											onCheckedChange={(checked) =>
												updateSettings({ notifications: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="Always show context usage"
										description="By default, context usage is only shown when more than 70% is used."
									>
										<Switch
											checked={settings.alwaysShowContextUsage}
											onCheckedChange={(checked) =>
												updateSettings({ alwaysShowContextUsage: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="Usage Stats"
										description="Show account rate limits beside the composer."
									>
										<Switch
											checked={settings.showUsageStats}
											onCheckedChange={(checked) =>
												updateSettings({ showUsageStats: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="Follow-up behavior"
										description={
											<>
												Queue follow-ups while the agent runs or steer the
												current run.
												{(() => {
													const toggleHotkey = getShortcut(
														settings.shortcuts,
														"composer.toggleFollowUpBehavior",
													);
													if (!toggleHotkey) return null;
													return (
														<>
															{" "}
															Press{" "}
															<InlineShortcutDisplay
																hotkey={toggleHotkey}
																className="align-baseline text-muted-foreground"
															/>{" "}
															to do the opposite for one message.
														</>
													);
												})()}
											</>
										}
									>
										<ToggleGroup
											type="single"
											value={settings.followUpBehavior}
											onValueChange={(value) => {
												if (value === "queue" || value === "steer") {
													updateSettings({ followUpBehavior: value });
												}
											}}
											className="gap-1 bg-muted/40"
										>
											<ToggleGroupItem
												value="queue"
												aria-label="Queue"
												className="h-7 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												Queue
											</ToggleGroupItem>
											<ToggleGroupItem
												value="steer"
												aria-label="Steer"
												className="h-7 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												Steer
											</ToggleGroupItem>
										</ToggleGroup>
									</SettingsRow>
									<AppUpdatesPanel />
								</SettingsGroup>
							)}

							{activeSection === "shortcuts" && (
								<ShortcutsSettingsPanel
									overrides={settings.shortcuts}
									onChange={(shortcuts) => updateSettings({ shortcuts })}
								/>
							)}

							{activeSection === "appearance" && (
								<SettingsGroup>
									<SettingsRow
										title="Theme"
										description="Switch between light and dark appearance"
									>
										<ToggleGroup
											type="single"
											value={settings.theme}
											className="gap-1.5"
											onValueChange={(value: string) => {
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
									</SettingsRow>
									<SettingsRow
										title="Font Size"
										description="Adjust the text size for chat messages"
									>
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
									</SettingsRow>
								</SettingsGroup>
							)}

							{activeSection === "model" && (
								<SettingsGroup>
									<SettingsRow
										title="Default model"
										description="Model for new chats"
									>
										<div className="flex w-[360px] items-center gap-2">
											<DropdownMenu>
												<DropdownMenuTrigger
													className={cn(
														"flex h-8 cursor-pointer items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
														"min-w-0 flex-1 gap-1.5",
													)}
												>
													<span className="flex min-w-0 items-center gap-1.5">
														<ModelIcon
															model={selectedDefaultModel}
															className="size-[13px] shrink-0"
														/>
														<span className="min-w-0 truncate whitespace-nowrap">
															{defaultModelLabel}
														</span>
													</span>
													<ChevronDown className="size-3 shrink-0 opacity-40" />
												</DropdownMenuTrigger>
												<DropdownMenuContent
													align="end"
													sideOffset={4}
													className="min-w-[10rem]"
												>
													{allModels.map((m) => (
														<DropdownMenuItem
															key={m.id}
															onClick={() =>
																updateSettings({ defaultModelId: m.id })
															}
															className="gap-2"
														>
															<ModelIcon model={m} className="size-4" />
															{m.label}
														</DropdownMenuItem>
													))}
												</DropdownMenuContent>
											</DropdownMenu>
											<DropdownMenu>
												<DropdownMenuTrigger
													className={cn(
														"flex h-8 cursor-pointer items-center rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
														"shrink-0 gap-1.5",
													)}
												>
													<span>
														{effortLabel(settings.defaultEffort ?? "high")}
													</span>
													<ChevronDown className="size-3 opacity-40" />
												</DropdownMenuTrigger>
												<DropdownMenuContent
													align="end"
													sideOffset={4}
													className="min-w-[8rem]"
												>
													{defaultEffortLevels.map((l) => (
														<DropdownMenuItem
															key={l}
															onClick={() =>
																updateSettings({ defaultEffort: l })
															}
														>
															{effortLabel(l)}
														</DropdownMenuItem>
													))}
												</DropdownMenuContent>
											</DropdownMenu>
											<div
												className={cn(
													"flex h-8 cursor-pointer items-center rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
													"shrink-0 gap-2",
												)}
											>
												<span
													className={
														defaultModelSupportsFastMode
															? "text-[13px] text-foreground"
															: "text-[13px] text-muted-foreground"
													}
												>
													Fast mode
												</span>
												<Switch
													checked={
														defaultModelSupportsFastMode &&
														settings.defaultFastMode
													}
													disabled={!defaultModelSupportsFastMode}
													onCheckedChange={(checked) =>
														updateSettings({ defaultFastMode: checked })
													}
													aria-label="Default fast mode"
												/>
											</div>
										</div>
									</SettingsRow>
									<ClaudeCustomProvidersPanel />
								</SettingsGroup>
							)}

							{activeSection === "git" && (
								<SettingsGroup>
									<div className="py-5">
										<div className="text-[13px] font-medium leading-snug text-foreground">
											Branch Prefix
										</div>
										<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
											Prefix added to branch names when creating new workspaces
										</div>
										<RadioGroup
											value={settings.branchPrefixType}
											onValueChange={(value: string) =>
												updateSettings({
													branchPrefixType: value as
														| "github"
														| "custom"
														| "none",
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
								</SettingsGroup>
							)}

							{activeSection === "experimental" && (
								<div className="flex flex-col gap-3">
									<CliInstallPanel />
								</div>
							)}

							{activeSection === "import" && <ConductorImportPanel />}

							{activeSection === "developer" && <DevToolsPanel />}

							{activeSection === "account" && (
								<AccountPanel
									repositories={repositories}
									onSignedOut={onClose}
								/>
							)}

							{activeRepo && (
								<RepositorySettingsPanel
									repo={activeRepo}
									githubLogin={githubLogin}
									workspaceId={
										activeRepo.id === workspaceRepoId ? workspaceId : null
									}
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
									onRepoDeleted={() => {
										setActiveSection("general");
										void queryClient.invalidateQueries({
											queryKey: helmorQueryKeys.repositories,
										});
										void queryClient.invalidateQueries({
											queryKey: helmorQueryKeys.workspaceGroups,
										});
									}}
								/>
							)}
						</div>
					</div>
				</SidebarProvider>
			</DialogContent>
		</Dialog>
	);
});

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

function effortLabel(level: string): string {
	if (level === "xhigh") return "Extra High";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

export function SettingsButton({
	onClick,
	shortcut,
}: {
	onClick: () => void;
	shortcut?: string | null;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					onClick={onClick}
					className="text-muted-foreground hover:text-foreground"
				>
					<Settings className="size-[15px]" strokeWidth={1.8} />
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="top"
				sideOffset={4}
				className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
			>
				<span className="leading-none">Settings</span>
				{shortcut ? (
					<InlineShortcutDisplay
						hotkey={shortcut}
						className="text-background/60"
					/>
				) : null}
			</TooltipContent>
		</Tooltip>
	);
}
