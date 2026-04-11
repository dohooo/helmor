import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Monitor, Moon, Plus, Settings, Sun } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldContent, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	isConductorAvailable,
	loadGithubIdentitySession,
	type RepositoryCreateOption,
} from "@/lib/api";
import { helmorQueryKeys, repositoriesQueryOptions } from "@/lib/query-client";
import type { ThemeMode } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { CliInstallPanel } from "./panels/cli-install";
import { ConductorImportPanel } from "./panels/conductor-import";
import { RepositorySettingsPanel } from "./panels/repository-settings";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

type SettingsSection =
	| "appearance"
	| "workspace"
	| "experimental"
	| "import"
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

	const fixedSections: SettingsSection[] = conductorEnabled
		? ["appearance", "workspace", "experimental", "import"]
		: ["appearance", "workspace", "experimental"];

	const activeRepoId = activeSection.startsWith("repo:")
		? activeSection.slice(5)
		: null;
	const activeRepo = activeRepoId
		? repositories.find((r) => r.id === activeRepoId)
		: null;

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="flex h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] gap-0 overflow-hidden rounded-2xl border-border/60 bg-background p-0 shadow-2xl sm:max-w-[860px]">
				{/* Nav sidebar */}
				<nav className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-border/40 bg-muted/30 px-3 pt-14 pb-6">
					<ToggleGroup
						type="single"
						value={activeSection}
						orientation="vertical"
						className="w-full items-stretch gap-1"
						onValueChange={(value: string) => {
							if (value) {
								setActiveSection(value as SettingsSection);
							}
						}}
					>
						{fixedSections.map((section) => (
							<ToggleGroupItem
								key={section}
								value={section}
								className="w-full justify-start rounded-lg px-3 py-2 text-left text-[13px] font-medium capitalize data-[state=on]:bg-accent data-[state=on]:text-foreground"
							>
								{section}
							</ToggleGroupItem>
						))}
					</ToggleGroup>

					{repositories.length > 0 && (
						<>
							<div className="mx-3 mt-3 mb-1 border-t border-border/30" />
							<div className="px-3 py-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/70">
								Repositories
							</div>
							{repositories.map((repo) => {
								const key: SettingsSection = `repo:${repo.id}`;
								return (
									<button
										key={key}
										type="button"
										onClick={() => setActiveSection(key)}
										className={cn(
											"flex items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors",
											activeSection === key
												? "bg-accent text-foreground"
												: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
										)}
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
										<span className="truncate">{repo.name}</span>
									</button>
								);
							})}
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
												branchPrefixType: value as "github" | "custom" | "none",
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
							/>
						)}
					</div>
				</div>
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
		<Button
			variant="ghost"
			size="icon"
			onClick={onClick}
			title="Settings"
			className="text-muted-foreground hover:text-foreground"
		>
			<Settings className="size-[15px]" strokeWidth={1.8} />
		</Button>
	);
}
