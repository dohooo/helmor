import { Minus, Plus, Settings, X } from "lucide-react";
import { memo, useState } from "react";
import { useSettings } from "@/lib/settings";

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

	if (!open) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-black/40"
				onClick={onClose}
				onKeyDown={(e) => e.key === "Escape" && onClose()}
			/>

			{/* Dialog */}
			<div className="relative flex h-[420px] w-[560px] overflow-hidden rounded-[14px] border border-app-border bg-app-sidebar shadow-2xl">
				{/* Sidebar */}
				<div className="flex w-[160px] shrink-0 flex-col border-r border-app-border bg-app-base/50 p-2 pt-10">
					<button
						type="button"
						className={`rounded-lg px-3 py-1.5 text-left text-[13px] font-medium ${
							activeSection === "general"
								? "bg-app-foreground/[0.08] text-app-foreground"
								: "text-app-muted hover:text-app-foreground"
						}`}
					>
						General
					</button>
				</div>

				{/* Content */}
				<div className="flex flex-1 flex-col">
					{/* Header */}
					<div className="flex items-center justify-between border-b border-app-border px-5 py-3">
						<h2 className="text-[14px] font-semibold text-app-foreground">
							Settings
						</h2>
						<button
							type="button"
							onClick={onClose}
							className="rounded-md p-1 text-app-muted transition-colors hover:bg-app-foreground/[0.06] hover:text-app-foreground"
						>
							<X className="size-4" strokeWidth={2} />
						</button>
					</div>

					{/* General section */}
					<div className="flex-1 overflow-y-auto px-5 py-4">
						<div className="space-y-5">
							<div>
								<h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wider text-app-muted">
									Appearance
								</h3>

								<div className="flex items-center justify-between rounded-lg border border-app-border/50 bg-app-base/30 px-4 py-3">
									<div>
										<div className="text-[13px] font-medium text-app-foreground">
											Font Size
										</div>
										<div className="mt-0.5 text-[11px] text-app-muted">
											Chat message text size
										</div>
									</div>

									<div className="flex items-center gap-2">
										<button
											type="button"
											onClick={() =>
												updateSettings({
													fontSize: Math.max(
														MIN_FONT_SIZE,
														settings.fontSize - 1,
													),
												})
											}
											disabled={settings.fontSize <= MIN_FONT_SIZE}
											className="flex size-7 items-center justify-center rounded-md border border-app-border bg-app-sidebar text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.06] disabled:opacity-30"
										>
											<Minus className="size-3.5" strokeWidth={2} />
										</button>

										<span className="w-10 text-center text-[13px] font-medium tabular-nums text-app-foreground">
											{settings.fontSize}px
										</span>

										<button
											type="button"
											onClick={() =>
												updateSettings({
													fontSize: Math.min(
														MAX_FONT_SIZE,
														settings.fontSize + 1,
													),
												})
											}
											disabled={settings.fontSize >= MAX_FONT_SIZE}
											className="flex size-7 items-center justify-center rounded-md border border-app-border bg-app-sidebar text-app-foreground-soft transition-colors hover:bg-app-foreground/[0.06] disabled:opacity-30"
										>
											<Plus className="size-3.5" strokeWidth={2} />
										</button>
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
});

export function SettingsButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex size-8 items-center justify-center rounded-lg text-app-muted transition-colors hover:bg-app-toolbar-hover/70 hover:text-app-foreground"
			title="Settings"
		>
			<Settings className="size-[15px]" strokeWidth={1.8} />
		</button>
	);
}
