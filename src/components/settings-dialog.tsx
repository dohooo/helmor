import { Minus, Plus, Settings } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { loadGithubIdentitySession } from "@/lib/api";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

type SettingsSection = "appearance" | "workspace";

export const SettingsDialog = memo(function SettingsDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const [activeSection, setActiveSection] =
		useState<SettingsSection>("appearance");
	const [githubLogin, setGithubLogin] = useState<string | null>(null);

	useEffect(() => {
		if (open) {
			void loadGithubIdentitySession().then((snapshot) => {
				if (snapshot.status === "connected") {
					setGithubLogin(snapshot.session.login);
				}
			});
		}
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="flex h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] sm:max-w-[860px] gap-0 overflow-hidden rounded-2xl border border-app-border/60 bg-app-sidebar p-0 shadow-2xl">
				{/* Nav sidebar */}
				<nav className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-app-border/40 bg-app-base/40 px-3 pt-14 pb-6">
					{(["appearance", "workspace"] as const).map((section) => (
						<button
							key={section}
							type="button"
							onClick={() => setActiveSection(section)}
							className={cn(
								"rounded-lg px-3 py-2 text-left text-[13px] font-medium capitalize transition-colors",
								activeSection === section
									? "bg-app-foreground/[0.07] text-app-foreground"
									: "text-app-muted hover:bg-app-foreground/[0.04] hover:text-app-foreground",
							)}
						>
							{section}
						</button>
					))}
				</nav>

				{/* Main content */}
				<div className="flex flex-1 flex-col">
					{/* Header */}
					<div className="flex items-center border-b border-app-border/40 px-8 py-4">
						<DialogTitle className="text-[15px] font-semibold capitalize text-app-foreground">
							{activeSection}
						</DialogTitle>
					</div>

					{/* Content area */}
					<div className="flex-1 overflow-y-auto px-8 py-6">
						{activeSection === "appearance" && (
							<div className="space-y-3">
								{/* Font Size */}
								<div className="flex items-center justify-between rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
									<div className="mr-8">
										<div className="text-[13px] font-medium leading-snug text-app-foreground">
											Font Size
										</div>
										<div className="mt-1 text-[12px] leading-snug text-app-muted">
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

										<span className="w-12 text-center text-[14px] font-semibold tabular-nums text-app-foreground">
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
							<div className="space-y-3">
								<div className="rounded-xl border border-app-border/30 bg-app-base/20 px-5 py-4">
									<div className="text-[13px] font-medium leading-snug text-app-foreground">
										Branch Prefix
									</div>
									<div className="mt-1 text-[12px] leading-snug text-app-muted">
										Prefix added to branch names when creating new workspaces
									</div>
									<div className="mt-4 flex flex-col gap-1">
										<RadioOption
											checked={settings.branchPrefixType === "github"}
											onChange={() =>
												updateSettings({ branchPrefixType: "github" })
											}
											label={`GitHub username${githubLogin ? ` (${githubLogin})` : ""}`}
										/>

										<RadioOption
											checked={settings.branchPrefixType === "custom"}
											onChange={() =>
												updateSettings({ branchPrefixType: "custom" })
											}
											label="Custom"
										/>
										{settings.branchPrefixType === "custom" && (
											<div className="ml-7">
												<input
													type="text"
													value={settings.branchPrefixCustom}
													onChange={(e) =>
														updateSettings({
															branchPrefixCustom: e.target.value,
														})
													}
													placeholder="e.g. feat/"
													className="w-full rounded-lg border border-app-border/40 bg-app-base/30 px-3 py-2 text-[13px] text-app-foreground placeholder:text-app-muted/50 focus:border-app-border-strong focus:outline-none"
												/>
												{settings.branchPrefixCustom && (
													<div className="mt-1.5 text-[12px] text-app-muted">
														Preview: {settings.branchPrefixCustom}tokyo
													</div>
												)}
											</div>
										)}

										<RadioOption
											checked={settings.branchPrefixType === "none"}
											onChange={() =>
												updateSettings({ branchPrefixType: "none" })
											}
											label="None"
										/>
									</div>
								</div>
							</div>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
});

function RadioOption({
	checked,
	onChange,
	label,
}: {
	checked: boolean;
	onChange: () => void;
	label: string;
}) {
	return (
		<label className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-1.5">
			<input
				type="radio"
				checked={checked}
				onChange={onChange}
				className="accent-app-project"
			/>
			<span className="text-[13px] text-app-foreground">{label}</span>
		</label>
	);
}

export function SettingsButton({ onClick }: { onClick: () => void }) {
	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={onClick}
			title="Settings"
			className="text-app-muted hover:text-app-foreground"
		>
			<Settings className="size-[15px]" strokeWidth={1.8} />
		</Button>
	);
}
