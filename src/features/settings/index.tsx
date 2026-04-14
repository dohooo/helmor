import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Monitor, Moon, Plus, Settings, Sun } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
import {
	isConductorAvailable,
	loadGithubIdentitySession,
	type RepositoryCreateOption,
} from "@/lib/api";
import { helmorQueryKeys, repositoriesQueryOptions } from "@/lib/query-client";
import type { ThemeMode } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { CliInstallPanel } from "./panels/cli-install";
import { ConductorImportPanel } from "./panels/conductor-import";
import { DevToolsPanel } from "./panels/dev-tools";
import { RepositorySettingsPanel } from "./panels/repository-settings";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

type SettingsSection =
	| "appearance"
	| "workspace"
	| "experimental"
	| "import"
	| "developer"
	| `repo:${string}`;

function sectionLabel(
	section: SettingsSection,
	repos: RepositoryCreateOption[],
): string {
	if (section.startsWith("repo:")) {
		const repoId = section.slice(5);
		return repos.find((r) => r.id === repoId)?.name ?? "Repository";
	}
	return section;
}

export const SettingsDialog = memo(function SettingsDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const queryClient = useQueryClient();
	const [activeSection, setActiveSection] =
		useState<SettingsSection>("appearance");
	const [githubLogin, setGithubLogin] = useState<string | null>(null);
	const [conductorEnabled, setConductorEnabled] = useState(false);

	const reposQuery = useQuery({
		...repositoriesQueryOptions(),
		enabled: open,
	});
	const repositories = reposQuery.data ?? [];

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
		"appearance",
		"workspace",
		"experimental",
		...(conductorEnabled ? (["import"] as const) : []),
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
			<DialogContent className="h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] overflow-hidden rounded-2xl border-border/60 bg-background p-0 shadow-2xl sm:max-w-[860px]">
				<SidebarProvider className="flex h-full min-h-0 w-full gap-0">
					{/* Nav sidebar */}
					<nav className="scrollbar-stable flex w-[200px] shrink-0 flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar pt-14 pb-6">
						<SidebarGroup>
							<SidebarGroupContent>
								<SidebarMenu>
									{fixedSections.map((section) => (
										<SidebarMenuItem key={section}>
											<SidebarMenuButton
												isActive={activeSection === section}
												onClick={() => setActiveSection(section)}
												className="capitalize"
											>
												{section}
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
					<div className="flex flex-1 flex-col">
						{/* Header */}
						<div className="flex items-center border-b border-border/40 px-8 py-4">
							<DialogTitle className="text-[15px] font-semibold text-foreground">
								{activeRepo
									? activeRepo.name
									: sectionLabel(activeSection, repositories)}
							</DialogTitle>
						</div>

						{/* Content area */}
						<div className="flex-1 overflow-y-auto px-8 py-6">
							{activeSection === "appearance" && (
								<div className="flex flex-col gap-3">
									{/* Theme */}
									<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
										<div className="text-[13px] font-medium leading-snug text-foreground">
											Theme
										</div>
										<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
											Switch between light and dark appearance
										</div>
										<ToggleGroup
											type="single"
											value={settings.theme}
											className="mt-3 gap-1.5"
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
									</div>

									{/* Font Size */}
									<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
										<div className="mr-8">
											<div className="text-[13px] font-medium leading-snug text-foreground">
												Font Size
											</div>
											<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
												Adjust the text size for chat messages
											</div>
										</div>

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
									</div>

									{/* Desktop Notifications */}
									<div className="flex items-center justify-between rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
										<div className="mr-8">
											<div className="text-[13px] font-medium leading-snug text-foreground">
												Desktop Notifications
											</div>
											<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
												Show system notifications when sessions complete or need
												input
											</div>
										</div>
										<Switch
											checked={settings.notifications}
											onCheckedChange={(checked) =>
												updateSettings({ notifications: checked })
											}
										/>
									</div>
								</div>
							)}

							{activeSection === "workspace" && (
								<div className="flex flex-col gap-3">
									<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
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
								</div>
							)}

							{activeSection === "experimental" && (
								<div className="flex flex-col gap-3">
									<CliInstallPanel />
								</div>
							)}

							{activeSection === "import" && <ConductorImportPanel />}

							{activeSection === "developer" && <DevToolsPanel />}

							{activeRepo && (
								<RepositorySettingsPanel
									repo={activeRepo}
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
										setActiveSection("appearance");
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

export function SettingsButton({ onClick }: { onClick: () => void }) {
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
				sideOffset={6}
				className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
			>
				<span className="leading-none">Settings</span>
			</TooltipContent>
		</Tooltip>
	);
}
