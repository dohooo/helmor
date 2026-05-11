import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	ChevronDown,
	HelpCircle,
	Minus,
	Monitor,
	Moon,
	Plus,
	Settings,
	Sun,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { ModelIcon } from "@/components/model-icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
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
import {
	type AgentModelOption,
	type AgentModelSection,
	isConductorAvailable,
	type RepositoryCreateOption,
} from "@/lib/api";
import {
	agentModelSectionsQueryOptions,
	helmorQueryKeys,
	repositoriesQueryOptions,
} from "@/lib/query-client";
import type {
	AppSettings,
	ClaudeThinkingDisplay,
	DarkTheme,
	ThemeMode,
} from "@/lib/settings";
import { resolveTheme, useSettings } from "@/lib/settings";
import { requestSidebarReconcile } from "@/lib/sidebar-mutation-gate";
import { cn } from "@/lib/utils";
import { clampEffort, findModelOption } from "@/lib/workspace-helpers";
import { SettingsGroup, SettingsRow } from "./components/settings-row";
import { AccountPanel } from "./panels/account";
import { AppUpdatesPanel } from "./panels/app-updates";
import { CliInstallPanel } from "./panels/cli-install";
import { ConductorImportPanel } from "./panels/conductor-import";
import { CursorProviderPanel } from "./panels/cursor-provider";
import { DevToolsPanel } from "./panels/dev-tools";
import { InboxSettingsPanel } from "./panels/inbox";
import { ClaudeCustomProvidersPanel } from "./panels/model-providers";
import { RepositorySettingsPanel } from "./panels/repository-settings";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const FALLBACK_EFFORT_LEVELS = ["low", "medium", "high"];

const DARK_THEME_OPTIONS: Array<{
	id: DarkTheme;
	label: string;
	/** Gradient stop colors for dark-mode swatch (vivid, hue-family) */
	bg: string;
	accent: string;
	/** Gradient stop colors for light-mode swatch (vivid, hue-family) */
	lightBg: string;
	lightAccent: string;
}> = [
	{
		id: "default",
		label: "Default",
		bg: "oklch(0.38 0 0)",
		accent: "oklch(0.18 0 0)",
		lightBg: "oklch(0.88 0 0)",
		lightAccent: "oklch(0.52 0 0)",
	},
	{
		id: "midnight",
		label: "Midnight",
		bg: "oklch(0.62 0.14 258)",
		accent: "oklch(0.30 0.10 260)",
		lightBg: "oklch(0.82 0.09 258)",
		lightAccent: "oklch(0.46 0.20 255)",
	},
	{
		id: "forest",
		label: "Forest",
		bg: "oklch(0.58 0.13 150)",
		accent: "oklch(0.28 0.08 155)",
		lightBg: "oklch(0.80 0.09 152)",
		lightAccent: "oklch(0.44 0.17 148)",
	},
	{
		id: "ember",
		label: "Ember",
		bg: "oklch(0.66 0.15 55)",
		accent: "oklch(0.32 0.09 48)",
		lightBg: "oklch(0.84 0.11 60)",
		lightAccent: "oklch(0.52 0.19 50)",
	},
	{
		id: "aurora",
		label: "Aurora",
		bg: "oklch(0.60 0.15 286)",
		accent: "oklch(0.28 0.09 292)",
		lightBg: "oklch(0.80 0.10 289)",
		lightAccent: "oklch(0.46 0.20 284)",
	},
];

export type { SettingsSection } from "./types";

import type { SettingsSection } from "./types";

/// Display labels for settings sections in the sidebar / dialog title.
/// Most match the section key with a leading capital, but a few names
/// don't pluralise nicely under that rule — keep the overrides explicit.
const SECTION_LABEL_OVERRIDES: Partial<Record<SettingsSection, string>> = {
	account: "Accounts",
	inbox: "Contexts",
};

/// Optional muted-caption next to the title in the dialog header.
/// Lets a panel surface a one-liner without rendering its own header
/// row (which otherwise duplicates the section name).
const SECTION_TITLE_CAPTIONS: Partial<Record<SettingsSection, string>> = {
	account: "Synced with your local gh / glab CLI.",
	inbox: "Pick which items each connected account contributes to Contexts.",
};

function sidebarSectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
): string {
	if (section.startsWith("repo:")) {
		const repoId = section.slice(5);
		return repos.find((r) => r.id === repoId)?.name ?? "Repository";
	}
	const override = SECTION_LABEL_OVERRIDES[section];
	if (override) return override;
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
	const modelSections = modelSectionsQuery.data ?? [];
	const allModels = modelSections.flatMap((s) => s.options);

	// Materialize null Review/PR fields once per dialog open. Each model row
	// (default / review / pr) owns its three controls (model, effort, fast
	// mode) independently — `null` was the legacy "follow default" sentinel,
	// but that coupling caused review/pr displays to flip whenever the
	// default row changed. We promote nulls to explicit copies of the
	// current default values so the three rows are fully decoupled going
	// forward. Wait until `defaultModelId` is set so we don't materialize
	// to `null` on first launch.
	const hasMaterialized = useRef(false);
	useEffect(() => {
		if (!open) {
			hasMaterialized.current = false;
			return;
		}
		if (hasMaterialized.current) return;
		if (settings.defaultModelId === null) return;

		const patch: Partial<AppSettings> = {};
		if (settings.reviewModelId === null) {
			patch.reviewModelId = settings.defaultModelId;
		}
		if (settings.reviewEffort === null) {
			patch.reviewEffort = settings.defaultEffort;
		}
		if (settings.reviewFastMode === null) {
			patch.reviewFastMode = settings.defaultFastMode;
		}
		if (settings.prModelId === null) {
			patch.prModelId = settings.defaultModelId;
		}
		if (settings.prEffort === null) {
			patch.prEffort = settings.defaultEffort;
		}
		if (settings.prFastMode === null) {
			patch.prFastMode = settings.defaultFastMode;
		}

		hasMaterialized.current = true;
		if (Object.keys(patch).length > 0) {
			void updateSettings(patch);
		}
	}, [open, settings, updateSettings]);

	useEffect(() => {
		if (open) {
			void isConductorAvailable().then(setConductorEnabled);
		}
	}, [open]);

	const isDev = import.meta.env.DEV;

	const fixedSections: SettingsSection[] = [
		"general",
		"appearance",
		"model",
		"shortcuts",
		...(conductorEnabled ? (["import"] as const) : []),
		...(isDev ? (["developer"] as const) : []),
		"account",
		"inbox",
		"experimental",
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
						<div className="flex items-baseline gap-3 border-b border-border/40 px-8 py-4">
							<DialogTitle className="text-[15px] font-semibold text-foreground">
								{activeRepo
									? activeRepo.name
									: titleSectionLabel(activeSection, repositories)}
							</DialogTitle>
							{!activeRepo && SECTION_TITLE_CAPTIONS[activeSection] ? (
								<span className="truncate text-[12px] text-muted-foreground/70">
									{SECTION_TITLE_CAPTIONS[activeSection]}
								</span>
							) : null}
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
									<SettingsRow
										title={
											<span className="inline-flex items-center gap-1.5">
												Claude Code Thinking Display
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
																		Summarized
																	</span>
																	{" — "}
																	thinking blocks contain summarized text.
																</div>
																<div>
																	<span className="font-medium">Omitted</span>
																	{" — "}
																	thinking blocks are empty. The server skips
																	streaming thinking tokens, so the final text
																	streams sooner. Reduces latency, not cost.
																</div>
															</div>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											</span>
										}
										description="Controls how Claude Code returns thinking content."
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
											className="gap-1 bg-muted/40"
										>
											<ToggleGroupItem
												value="summarized"
												aria-label="Summarized"
												className="h-7 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												Summarized
											</ToggleGroupItem>
											<ToggleGroupItem
												value="omitted"
												aria-label="Omitted"
												className="h-7 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-foreground"
											>
												Omitted
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
										title="Color Theme"
										description="Choose an accent palette"
									>
										{(() => {
											const isLight = resolveTheme(settings.theme) === "light";
											return (
												<div className="flex gap-2">
													{DARK_THEME_OPTIONS.map((opt) => {
														const swatchBg = isLight ? opt.lightBg : opt.bg;
														const swatchAccent = isLight
															? opt.lightAccent
															: opt.accent;
														const isSelected = settings.darkTheme === opt.id;
														return (
															<button
																key={opt.id}
																type="button"
																title={opt.label}
																aria-label={opt.label}
																aria-pressed={isSelected}
																className={cn(
																	"h-7 w-7 cursor-pointer rounded-full transition-transform duration-150",
																	isSelected ? "scale-105" : "hover:scale-105",
																)}
																style={{
																	background: `linear-gradient(135deg, ${swatchBg}, ${swatchAccent})`,
																	boxShadow: isSelected
																		? `0 0 0 2px var(--background), 0 0 0 3.5px ${swatchBg}`
																		: undefined,
																}}
																onClick={() =>
																	updateSettings({ darkTheme: opt.id })
																}
															/>
														);
													})}
												</div>
											);
										})()}
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
									<ModelSettingRow
										title="Default model"
										description="Model for new chats"
										models={allModels}
										modelSections={modelSections}
										isLoadingModels={modelSectionsQuery.isPending}
										// Each row reads its own state directly. The `?? default*`
										// fallbacks here only cover the brief moment between
										// dialog open and `hasMaterialized` running — once the
										// migration lands, stored values are explicit and these
										// fallbacks no-op.
										modelId={settings.defaultModelId}
										effort={settings.defaultEffort}
										fastMode={settings.defaultFastMode}
										ariaPrefix="Default"
										onChange={(p) => {
											const patch: Partial<AppSettings> = {};
											if (p.modelId !== undefined)
												patch.defaultModelId = p.modelId;
											if (p.effort !== undefined)
												patch.defaultEffort = p.effort;
											if (p.fastMode !== undefined)
												patch.defaultFastMode = p.fastMode;
											void updateSettings(patch);
										}}
									/>
									<ModelSettingRow
										title="Review model"
										description="Model for code review"
										models={allModels}
										modelSections={modelSections}
										isLoadingModels={modelSectionsQuery.isPending}
										modelId={settings.reviewModelId ?? settings.defaultModelId}
										effort={settings.reviewEffort ?? settings.defaultEffort}
										fastMode={
											settings.reviewFastMode ?? settings.defaultFastMode
										}
										ariaPrefix="Review"
										onChange={(p) => {
											const patch: Partial<AppSettings> = {};
											if (p.modelId !== undefined)
												patch.reviewModelId = p.modelId;
											if (p.effort !== undefined) patch.reviewEffort = p.effort;
											if (p.fastMode !== undefined)
												patch.reviewFastMode = p.fastMode;
											void updateSettings(patch);
										}}
									/>
									<ModelSettingRow
										title="PR / MR model"
										description="Model for PRs and MRs"
										models={allModels}
										modelSections={modelSections}
										isLoadingModels={modelSectionsQuery.isPending}
										modelId={settings.prModelId ?? settings.defaultModelId}
										effort={settings.prEffort ?? settings.defaultEffort}
										fastMode={settings.prFastMode ?? settings.defaultFastMode}
										ariaPrefix="PR / MR"
										onChange={(p) => {
											const patch: Partial<AppSettings> = {};
											if (p.modelId !== undefined) patch.prModelId = p.modelId;
											if (p.effort !== undefined) patch.prEffort = p.effort;
											if (p.fastMode !== undefined)
												patch.prFastMode = p.fastMode;
											void updateSettings(patch);
										}}
									/>
									<ClaudeCustomProvidersPanel />
									<CursorProviderPanel />
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
								<AccountPanel repositories={repositories} />
							)}

							{activeSection === "inbox" && (
								<InboxSettingsPanel repositories={repositories} />
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
	models,
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
	models: AgentModelOption[];
	modelSections: AgentModelSection[];
	isLoadingModels: boolean;
	modelId: string | null;
	effort: string | null;
	fastMode: boolean;
	ariaPrefix: string;
	onChange: (patch: ModelRowChange) => void;
}) {
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
		selected?.label ?? (isLoadingModels ? "Loading…" : "Select model");
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
		<SettingsRow title={title} description={description}>
			<div className="flex w-[360px] items-center gap-2">
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(
							"flex h-8 cursor-pointer items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
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
						className="min-w-[10rem]"
					>
						{models.map((m) => (
							<DropdownMenuItem
								key={m.id}
								onClick={() => onChange({ modelId: m.id })}
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
					</DropdownMenuContent>
				</DropdownMenu>
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={!supportsEffort}
						className={cn(
							"flex h-8 items-center rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px]",
							"shrink-0 gap-1.5",
							supportsEffort
								? "cursor-pointer text-foreground hover:bg-muted/50"
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
						"flex h-8 cursor-pointer items-center rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
						"shrink-0 gap-2",
					)}
				>
					<span
						className={
							supportsFastMode
								? "text-[13px] text-foreground"
								: "text-[13px] text-muted-foreground"
						}
					>
						Fast mode
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
