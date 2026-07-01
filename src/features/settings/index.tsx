import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	ChevronDown,
	HelpCircle,
	Settings,
	Volume2,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { ModelIcon } from "@/components/model-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { getShortcut } from "@/features/shortcuts/registry";
import { ShortcutsSettingsPanel } from "@/features/shortcuts/settings-panel";
import { InlineShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { AgentModelSection, RepositoryCreateOption } from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";
import {
	NOTIFICATION_SOUND_LABELS,
	playNotificationSound,
} from "@/lib/notification-sound";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	repositoriesQueryOptions,
} from "@/lib/query-client";
import type {
	AppSettings,
	ClaudeThinkingDisplay,
	NotificationSound,
} from "@/lib/settings";
import { useSettings, VALID_NOTIFICATION_SOUNDS } from "@/lib/settings";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { cn } from "@/lib/utils";
import { clampEffort, findModelOption } from "@/lib/workspace-helpers";
import { SettingsGroup, SettingsRow } from "./components/settings-row";
import { SettingsSelect } from "./components/settings-select";
import { AccountPanel } from "./panels/account";
import { AppUpdatesPanel } from "./panels/app-updates";
import { AppearancePanel } from "./panels/appearance";
import { ArchiveCleanupPanel } from "./panels/archive-cleanup";
import { ComponentsPanel } from "./panels/components";
import { DevToolsPanel } from "./panels/dev-tools";
import { InboxSettingsPanel } from "./panels/inbox";
import { LocalLlmPanel } from "./panels/local-llm";
import { MobileCompanionPanel } from "./panels/mobile-companion";
import { ProvidersPanel } from "./panels/providers";
import { RepositorySettingsPanel } from "./panels/repository-settings";

const FALLBACK_EFFORT_LEVELS = ["low", "medium", "high"];

const NOTIFICATION_SOUND_OPTIONS = VALID_NOTIFICATION_SOUNDS.map((value) => ({
	value,
	label: NOTIFICATION_SOUND_LABELS[value],
})) satisfies readonly { value: NotificationSound; label: string }[];

export type { ContextProviderTab, SettingsSection } from "./types";

import type { ContextProviderTab, SettingsSection } from "./types";

/// Display labels for settings sections in the sidebar / dialog title.
/// Most match the section key with a leading capital, but a few names
/// don't pluralise nicely under that rule — keep the overrides explicit.
const SECTION_LABEL_OVERRIDES: Partial<Record<SettingsSection, string>> = {
	model: "models",
	account: "accounts",
	inbox: "contexts",
};

/// Optional muted-caption next to the title in the dialog header.
/// Lets a panel surface a one-liner without rendering its own header
/// row (which otherwise duplicates the section name).
const SECTION_TITLE_CAPTIONS: Partial<Record<SettingsSection, string>> = {
	account: "syncedLocalGhGlabCli",
	inbox: "pickWhichItemsEachConnectedAccount",
};

function sidebarSectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
	t: (source: string) => string,
): string {
	if (section.startsWith("repo:")) {
		const repoId = section.slice(5);
		return repos.find((r) => r.id === repoId)?.name ?? t("repository");
	}
	const override = SECTION_LABEL_OVERRIDES[section];
	if (override) return t(override);
	return t(section);
}

function titleSectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
	t: (source: string) => string,
): string {
	return sidebarSectionLabel(section, repos, t);
}

export const SettingsDialog = memo(function SettingsDialog({
	open,
	workspaceId,
	workspaceRepoId,
	initialSection,
	initialInboxProvider,
	onClose,
}: {
	open: boolean;
	workspaceId: string | null;
	workspaceRepoId: string | null;
	initialSection?: SettingsSection;
	initialInboxProvider?: ContextProviderTab;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const { t } = useI18n();
	const queryClient = useQueryClient();
	const [activeSection, setActiveSection] =
		useState<SettingsSection>("general");

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
	// Same source as the composer picker, so the Default/Review/PR rows show
	// exactly the user's selected models, grouped by section (the section header
	// distinguishes a custom `gpt-5.5` from the official one).
	const modelSectionsQuery = useQuery({
		...agentModelSectionsQueryOptions(),
		enabled: open,
	});
	const modelSections = modelSectionsQuery.data ?? [];

	// Note: null review/pr model fields used to be promoted to default
	// values here on every dialog open. That migration now runs once in
	// `materialize_review_pr_model_defaults` (src-tauri/src/schema.rs) at
	// schema upgrade time. Consumers fall back to `?? settings.defaultX`
	// for the brief window between first-time default-set and next
	// cold-start, which is what the existing UI bindings already do.

	const isDev = import.meta.env.DEV;

	const fixedSections: SettingsSection[] = [
		"general",
		"appearance",
		"model",
		"providers",
		"shortcuts",
		"account",
		"inbox",
		"experimental",
		// Developer is intentionally last in the fixed group — it sits
		// directly above the dynamic repository entries in the sidebar
		// (so the bottom of the static nav reads: experimental →
		// developer → <repos>). Hidden in non-dev builds.
		...(isDev ? (["developer"] as const) : []),
	];

	const activeRepoId = activeSection.startsWith("repo:")
		? activeSection.slice(5)
		: null;
	const activeRepo = activeRepoId
		? repositories.find((r) => r.id === activeRepoId)
		: null;

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] overflow-hidden rounded-2xl border-border/60 bg-settings-content p-0 shadow-2xl sm:max-w-[860px]">
				<SidebarProvider className="flex h-full min-h-0 w-full min-w-0 gap-0 overflow-hidden">
					{/* Nav sidebar */}
					<nav className="scrollbar-stable flex w-[200px] shrink-0 flex-col overflow-x-hidden overflow-y-auto border-r border-sidebar-border bg-settings-nav py-6">
						<SidebarGroup>
							<SidebarGroupContent>
								<SidebarMenu>
									{fixedSections.map((section) => (
										<SidebarMenuItem key={section}>
											<SidebarMenuButton
												isActive={activeSection === section}
												onClick={() => setActiveSection(section)}
											>
												{sidebarSectionLabel(section, repositories, t)}
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
									<SidebarGroupLabel>
										<I18nText source="repositories" />
									</SidebarGroupLabel>
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
																<span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-nano font-semibold uppercase text-muted-foreground">
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
						<div className="flex items-baseline gap-3 border-b border-border/40 px-8 py-4">
							<DialogTitle className="text-title font-semibold text-foreground">
								{activeRepo
									? activeRepo.name
									: titleSectionLabel(activeSection, repositories, t)}
							</DialogTitle>
							{!activeRepo && SECTION_TITLE_CAPTIONS[activeSection] ? (
								<span className="truncate text-small text-muted-foreground/70">
									{t(SECTION_TITLE_CAPTIONS[activeSection])}
								</span>
							) : null}
						</div>

						{/* Content area — `scrollbar-stable` reserves the scrollbar
						    gutter so expanding/collapsing a provider row (which
						    toggles the vertical scrollbar) never reflows the body
						    width, matching the nav's stable gutter. */}
						<div className="scrollbar-stable min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 pt-1 pb-6">
							{activeSection === "general" && (
								<SettingsGroup>
									<SettingsRow
										title="desktopNotifications"
										description="showSystemNotificationsWhenSessionsComplete"
									>
										<Switch
											checked={settings.notifications}
											onCheckedChange={(checked) =>
												updateSettings({ notifications: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="notificationSound"
										description="playSoundWhenDesktopNotificationFires"
									>
										<div className="flex items-center gap-1.5">
											<SettingsSelect<NotificationSound>
												value={settings.notificationSound}
												options={NOTIFICATION_SOUND_OPTIONS}
												onChange={(next) =>
													updateSettings({ notificationSound: next })
												}
												disabled={!settings.notifications}
												ariaLabel="notificationSound"
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label="testNotificationSound"
												className="size-8"
												disabled={
													!settings.notifications ||
													settings.notificationSound === "off"
												}
												onClick={() =>
													playNotificationSound(settings.notificationSound)
												}
											>
												<Volume2
													className="size-4 text-muted-foreground"
													strokeWidth={1.8}
												/>
											</Button>
										</div>
									</SettingsRow>
									<SettingsRow
										title="expandTerminalsHover"
										description="enlargeInspectorTerminalsWhenCursorRests"
									>
										<Switch
											checked={settings.terminalHoverExpansion}
											onCheckedChange={(checked) =>
												updateSettings({ terminalHoverExpansion: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="terminalMode"
										releaseMarker={{ kind: "feature" }}
										description="addsComposerToggleOpensPromptAgent"
									>
										<Switch
											checked={settings.enableTerminalMode}
											onCheckedChange={(checked) =>
												updateSettings({ enableTerminalMode: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="alwaysShowContextUsage"
										description="byDefaultContextUsageOnlyShown"
									>
										<Switch
											checked={settings.alwaysShowContextUsage}
											onCheckedChange={(checked) =>
												updateSettings({ alwaysShowContextUsage: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="usageStats"
										description="showAccountRateLimitsBesideComposer"
									>
										<Switch
											checked={settings.showUsageStats}
											onCheckedChange={(checked) =>
												updateSettings({ showUsageStats: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="autoArchiveMerge"
										description="whenWorkspaceSLinkedPrMr"
									>
										<Switch
											checked={settings.autoArchiveOnMerge}
											onCheckedChange={(checked) =>
												updateSettings({ autoArchiveOnMerge: checked })
											}
										/>
									</SettingsRow>
									<SettingsRow
										title="followUpBehavior"
										description={
											<>
												<I18nText source="queueFollowUpsWhileAgentRuns" />
												{(() => {
													const toggleHotkey = getShortcut(
														settings.shortcuts,
														"composer.toggleFollowUpBehavior",
													);
													if (!toggleHotkey) return null;
													return (
														<>
															{" "}
															<I18nText source="press" />{" "}
															<InlineShortcutDisplay
																hotkey={toggleHotkey}
																className="align-baseline text-muted-foreground"
															/>{" "}
															<I18nText source="doOppositeOneMessage" />
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
											className="gap-1"
										>
											<ToggleGroupItem
												value="queue"
												aria-label="queue"
												className="h-7 rounded-md px-2.5 text-small font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												<I18nText source="queue" />
											</ToggleGroupItem>
											<ToggleGroupItem
												value="steer"
												aria-label="steer"
												className="h-7 rounded-md px-2.5 text-small font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												<I18nText source="steer" />
											</ToggleGroupItem>
										</ToggleGroup>
									</SettingsRow>
									<SettingsRow
										title={
											<span className="inline-flex items-center gap-1.5">
												<I18nText source="claudeCodeThinkingDisplay" />
												{/* SettingsDialog renders outside AppShell's
												 *  TooltipProvider tree, so panels need their
												 *  own — same pattern as repository-settings /
												 *  cursor-provider. */}
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<HelpCircle
																className="size-3 cursor-help text-muted-foreground/70"
																strokeWidth={1.8}
															/>
														</TooltipTrigger>
														<TooltipContent
															side="top"
															className="max-w-[320px] text-left"
														>
															<div className="space-y-1.5">
																<div>
																	<span className="font-medium">
																		<I18nText source="summarized" />
																	</span>
																	{" — "}
																	<I18nText source="thinkingBlocksContainSummarizedText" />
																</div>
																<div>
																	<span className="font-medium">
																		<I18nText source="omitted" />
																	</span>
																	{" — "}
																	<I18nText source="thinkingBlocksEmptyServerSkipsStreaming" />
																</div>
															</div>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</span>
										}
										description="controlsHowClaudeCodeReturnsThinking"
									>
										<ToggleGroup
											type="single"
											value={settings.claudeThinkingDisplay}
											onValueChange={(value) => {
												if (value === "summarized" || value === "omitted") {
													updateSettings({
														claudeThinkingDisplay:
															value as ClaudeThinkingDisplay,
													});
												}
											}}
											className="gap-1"
										>
											<ToggleGroupItem
												value="summarized"
												aria-label="summarized"
												className="h-7 rounded-md px-2.5 text-small font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												<I18nText source="summarized" />
											</ToggleGroupItem>
											<ToggleGroupItem
												value="omitted"
												aria-label="omitted"
												className="h-7 rounded-md px-2.5 text-small font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												<I18nText source="omitted" />
											</ToggleGroupItem>
										</ToggleGroup>
									</SettingsRow>
									<ArchiveCleanupPanel />
									<AppUpdatesPanel />
									<ComponentsPanel />
								</SettingsGroup>
							)}

							{activeSection === "shortcuts" && (
								<ShortcutsSettingsPanel
									overrides={settings.shortcuts}
									onChange={(shortcuts) => updateSettings({ shortcuts })}
								/>
							)}

							{activeSection === "appearance" && (
								<AppearancePanel
									settings={settings}
									updateSettings={updateSettings}
								/>
							)}

							{activeSection === "model" && (
								<SettingsGroup>
									<ModelSettingRow
										title="defaultModel"
										description="modelNewChats"
										modelSections={modelSections}
										isLoadingModels={modelSectionsQuery.isPending}
										// Each row reads its own state directly. The `?? default*`
										// fallbacks here only cover the brief moment between
										// dialog open and `hasMaterialized` running — once the
										// migration lands, stored values are explicit and these
										// fallbacks no-op.
										modelId={settings.defaultModel?.modelId ?? null}
										effort={settings.defaultEffort}
										fastMode={settings.defaultFastMode}
										ariaPrefix="Default"
										onChange={(p) => {
											const patch: Partial<AppSettings> = {};
											if (p.modelId !== undefined)
												patch.defaultModel = {
													provider: p.provider ?? null,
													modelId: p.modelId,
												};
											if (p.effort !== undefined)
												patch.defaultEffort = p.effort;
											if (p.fastMode !== undefined)
												patch.defaultFastMode = p.fastMode;
											void updateSettings(patch);
										}}
									/>
									<ModelSettingRow
										title="reviewModel"
										description="modelCodeReview"
										modelSections={modelSections}
										isLoadingModels={modelSectionsQuery.isPending}
										modelId={
											settings.reviewModel?.modelId ??
											settings.defaultModel?.modelId ??
											null
										}
										effort={settings.reviewEffort ?? settings.defaultEffort}
										fastMode={
											settings.reviewFastMode ?? settings.defaultFastMode
										}
										ariaPrefix="Review"
										onChange={(p) => {
											const patch: Partial<AppSettings> = {};
											if (p.modelId !== undefined)
												patch.reviewModel = {
													provider: p.provider ?? null,
													modelId: p.modelId,
												};
											if (p.effort !== undefined) patch.reviewEffort = p.effort;
											if (p.fastMode !== undefined)
												patch.reviewFastMode = p.fastMode;
											void updateSettings(patch);
										}}
									/>
									<ModelSettingRow
										title="actionModel"
										description="modelPrsMrsCommitPush"
										modelSections={modelSections}
										isLoadingModels={modelSectionsQuery.isPending}
										modelId={
											settings.prModel?.modelId ??
											settings.defaultModel?.modelId ??
											null
										}
										effort={settings.prEffort ?? settings.defaultEffort}
										fastMode={settings.prFastMode ?? settings.defaultFastMode}
										ariaPrefix="Action"
										onChange={(p) => {
											const patch: Partial<AppSettings> = {};
											if (p.modelId !== undefined)
												patch.prModel = {
													provider: p.provider ?? null,
													modelId: p.modelId,
												};
											if (p.effort !== undefined) patch.prEffort = p.effort;
											if (p.fastMode !== undefined)
												patch.prFastMode = p.fastMode;
											void updateSettings(patch);
										}}
									/>
								</SettingsGroup>
							)}

							{activeSection === "providers" && <ProvidersPanel />}

							{activeSection === "experimental" && (
								<SettingsGroup>
									<LocalLlmPanel
										settings={settings}
										updateSettings={updateSettings}
									/>
									<MobileCompanionPanel />
								</SettingsGroup>
							)}

							{activeSection === "developer" && <DevToolsPanel />}

							{activeSection === "account" && <AccountPanel />}

							{activeSection === "inbox" && (
								<InboxSettingsPanel
									repositories={repositories}
									initialProvider={initialInboxProvider}
								/>
							)}

							{activeRepo && (
								<RepositorySettingsPanel
									repo={activeRepo}
									workspaceId={
										activeRepo.id === workspaceRepoId ? workspaceId : null
									}
									onRepoSettingsChanged={() => {
										void queryClient.invalidateQueries({
											queryKey: helmorQueryKeys.repositories,
										});
										requestSidebarReconcile(queryClient);
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
										requestSidebarReconcile(queryClient);
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

function effortLabel(level: string): string {
	if (level === "xhigh") return "Extra High";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

type ModelRowChange = {
	modelId?: string;
	/** Provider of the picked model — captured at selection so the stored
	 *  pref carries it (slug-based providers can't be re-derived from the id). */
	provider?: string | null;
	effort?: string;
	fastMode?: boolean;
};

/// One row of the Model settings panel: model picker + effort picker + fast
/// mode switch. Shared by Default / Review / PR-MR rows so they all carry the
/// same clamp + display logic. Each row is fully independent — the parent
/// passes its row's own (modelId, effort, fastMode) and gets back a partial
/// patch on any change.
function ModelSettingRow({
	title,
	description,
	modelSections,
	isLoadingModels,
	modelId,
	effort,
	fastMode,
	ariaPrefix,
	onChange,
}: {
	title: string;
	description: string;
	modelSections: AgentModelSection[];
	isLoadingModels: boolean;
	modelId: string | null;
	effort: string | null;
	fastMode: boolean;
	ariaPrefix: string;
	onChange: (patch: ModelRowChange) => void;
}) {
	const { t } = useI18n();
	const selected = findModelOption(modelSections, modelId);
	// Key off real model metadata — Haiku reports `effortLevels: []`, and
	// the wire format may also drop the field entirely when empty. Either
	// way `?.length ?? 0` resolves to 0 → disabled. The fallback list only
	// keeps the dropdown from rendering empty while metadata is loading.
	const supportsEffort = (selected?.effortLevels?.length ?? 0) > 0;
	const effortLevels = supportsEffort
		? (selected?.effortLevels ?? FALLBACK_EFFORT_LEVELS)
		: FALLBACK_EFFORT_LEVELS;
	const supportsFastMode = selected?.supportsFastMode === true;
	const label =
		selected?.label ?? (isLoadingModels ? t("loading2") : t("selectModel"));
	const displayEffort = effort ?? "high";

	// Auto-clamp effort when model changes — but only after model metadata
	// has actually loaded, otherwise the fallback levels silently kill
	// max/xhigh.
	useEffect(() => {
		if (!selected) return;
		if (!effort) return;
		if (effortLevels.length > 0 && !effortLevels.includes(effort)) {
			onChange({ effort: clampEffort(effort, effortLevels) });
		}
	}, [selected, effort, effortLevels, onChange]);

	return (
		<SettingsRow title={t(title)} description={t(description)}>
			<div className="flex w-[360px] items-center gap-2">
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(
							"flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-ui text-foreground hover:bg-muted/50",
							"min-w-0 flex-1 gap-1.5",
						)}
					>
						<span className="flex min-w-0 items-center gap-1.5">
							<ModelIcon model={selected} className="size-[13px] shrink-0" />
							<span className="min-w-0 truncate whitespace-nowrap">
								{label}
							</span>
						</span>
						<ChevronDown className="size-3 shrink-0 opacity-40" />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						sideOffset={4}
						className="max-h-[320px] min-w-[10rem] overflow-y-auto"
					>
						{/* Grouped by section like the composer, so a custom `gpt-5.5`
						    sits under its provider header, not next to the official one. */}
						{modelSections.map((section, index) => (
							<DropdownMenuGroup key={section.id}>
								{index > 0 ? <DropdownMenuSeparator /> : null}
								<DropdownMenuLabel className="text-mini text-muted-foreground">
									{section.label}
								</DropdownMenuLabel>
								{section.options.map((m) => (
									<DropdownMenuItem
										key={m.id}
										onClick={() =>
											onChange({ modelId: m.id, provider: m.provider })
										}
										className="justify-between gap-2"
									>
										<span className="flex min-w-0 items-center gap-2">
											<ModelIcon model={m} className="size-4" />
											{m.label}
										</span>
										<CheckCircle2
											className={cn(
												"size-3.5 shrink-0 text-emerald-500",
												m.id !== modelId && "invisible",
											)}
										/>
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={!supportsEffort}
						className={cn(
							"flex h-8 items-center rounded-lg border border-border/50 bg-muted/30 px-3 text-ui",
							"shrink-0 gap-1.5",
							supportsEffort
								? "cursor-interactive text-foreground hover:bg-muted/50"
								: "cursor-not-allowed text-muted-foreground opacity-60",
						)}
					>
						<span>{effortLabel(displayEffort)}</span>
						<ChevronDown className="size-3 opacity-40" />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="end"
						sideOffset={4}
						className="min-w-[8rem]"
					>
						{effortLevels.map((l) => (
							<DropdownMenuItem key={l} onClick={() => onChange({ effort: l })}>
								{effortLabel(l)}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				<div
					className={cn(
						"flex h-8 cursor-interactive items-center rounded-lg border border-border/50 bg-muted/30 px-3 text-ui text-foreground hover:bg-muted/50",
						"shrink-0 gap-2",
					)}
				>
					<span
						className={
							supportsFastMode
								? "text-ui text-foreground"
								: "text-ui text-muted-foreground"
						}
					>
						<I18nText source="fastMode" />
					</span>
					<Switch
						checked={supportsFastMode && fastMode}
						disabled={!supportsFastMode}
						onCheckedChange={(checked) => onChange({ fastMode: checked })}
						aria-label={`${ariaPrefix} fast mode`}
					/>
				</div>
			</div>
		</SettingsRow>
	);
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
				className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
			>
				<span className="leading-none">
					<I18nText source="settings" />
				</span>
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
