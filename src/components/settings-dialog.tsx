import { Minus, Plus, Settings } from "lucide-react";
import { memo, useState } from "react";
import { useSettings } from "@/lib/settings";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

export const SettingsDialog = memo(function SettingsDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const { settings, updateSettings } = useSettings();
	const [activeSection] = useState("general");

	return (
		<Dialog open={open} onOpenChange={onClose}>
			<DialogContent className="flex h-[min(80vh,640px)] w-[min(80vw,860px)] max-w-[860px] sm:max-w-[860px] gap-0 overflow-hidden rounded-2xl border border-app-border/60 bg-app-sidebar p-0 shadow-2xl">
				{/* Nav sidebar */}
				<nav className="flex w-[200px] shrink-0 flex-col gap-1 border-r border-app-border/40 bg-app-base/40 px-3 pt-14 pb-6">
					<button
						type="button"
						className={`rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors ${
							activeSection === "general"
								? "bg-app-foreground/[0.07] text-app-foreground"
								: "text-app-muted hover:bg-app-foreground/[0.04] hover:text-app-foreground"
						}`}
					>
						General
					</button>
				</nav>

				{/* Main content */}
				<div className="flex flex-1 flex-col">
					{/* Header */}
					<div className="flex items-center border-b border-app-border/40 px-8 py-4">
						<DialogTitle className="text-[15px] font-semibold text-app-foreground">
							Settings
						</DialogTitle>
					</div>

					{/* Content area */}
					<div className="flex-1 overflow-y-auto px-8 py-6">
						{/* Appearance section */}
						<section>
							<h3 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-app-muted">
								Appearance
							</h3>

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
						</section>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
});

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
