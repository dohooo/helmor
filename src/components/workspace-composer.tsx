import { ArrowUp, ChevronDown, ClipboardList, Square } from "lucide-react";
import {
	type ButtonHTMLAttributes,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useState,
} from "react";
import type { AgentModelSection } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ClaudeIcon, OpenAIIcon } from "./icons";
import { extractImagePaths, ImagePreviewBadge } from "./image-preview";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type WorkspaceComposerProps = {
	contextKey: string;
	onSubmit: (prompt: string, imagePaths: string[]) => void;
	onStop?: () => void;
	sending?: boolean;
	selectedModelId: string | null;
	modelSections: AgentModelSection[];
	onSelectModel: (modelId: string) => void;
	provider?: string;
	effortLevel: string;
	onSelectEffort: (level: string) => void;
	permissionMode: string;
	onTogglePlanMode: () => void;
	sendError?: string | null;
	restoreDraft?: string | null;
	restoreImages?: string[];
	restoreNonce?: number;
};

type ComposerButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	children: ReactNode;
	className?: string;
};

function ComposerButton({
	children,
	className,
	...props
}: ComposerButtonProps) {
	return (
		<button
			{...props}
			type="button"
			className={cn(
				"flex items-center gap-1.5 rounded-lg text-app-foreground-soft transition-colors hover:text-app-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong disabled:cursor-not-allowed disabled:opacity-45",
				className,
			)}
		>
			{children}
		</button>
	);
}

export const WorkspaceComposer = memo(function WorkspaceComposer({
	contextKey: _contextKey,
	onSubmit,
	onStop,
	sending = false,
	selectedModelId,
	modelSections,
	onSelectModel,
	provider = "claude",
	effortLevel,
	onSelectEffort,
	permissionMode,
	onTogglePlanMode,
	sendError,
	restoreDraft,
	restoreImages = [],
	restoreNonce = 0,
}: WorkspaceComposerProps) {
	const [draftValue, setDraftValue] = useState(restoreDraft ?? "");
	const isOpus = selectedModelId === "opus-1m" || selectedModelId === "opus";
	const effectiveEffort = (() => {
		let level = effortLevel;
		if (provider === "codex") {
			// Claude → Codex mapping
			if (level === "max") level = "xhigh";
		} else {
			// Codex → Claude mapping
			if (level === "xhigh") level = isOpus ? "max" : "high";
			if (level === "minimal") level = "low";
			// Non-Opus can't use max
			if (level === "max" && !isOpus) level = "high";
		}
		return level;
	})();
	const selectedModel =
		modelSections
			.flatMap((section) => section.options)
			.find((option) => option.id === selectedModelId) ?? null;
	const [attachedImages, setAttachedImages] = useState<string[]>(restoreImages);
	const hasContent = draftValue.trim().length > 0 || attachedImages.length > 0;
	const sendDisabled = sending || !selectedModel || !hasContent;

	useEffect(() => {
		if (!restoreDraft && restoreImages.length === 0) return;
		setDraftValue(restoreDraft ?? "");
		setAttachedImages(restoreImages);
	}, [restoreNonce]);

	// Intercept value changes to extract image paths
	const handleValueChange = useCallback((newValue: string) => {
		const found = extractImagePaths(newValue);
		if (found.length > 0) {
			let cleaned = newValue;
			for (const p of found) cleaned = cleaned.replace(p, "");
			cleaned = cleaned.replace(/\n{2,}/g, "\n").trim();
			setAttachedImages((prev) => [...new Set([...prev, ...found])]);
			setDraftValue(cleaned);
		} else {
			setDraftValue(newValue);
		}
	}, []);

	const handleRemoveImage = useCallback((path: string) => {
		setAttachedImages((prev) => prev.filter((p) => p !== path));
	}, []);

	const handleSubmit = useCallback(() => {
		const imageRefs = attachedImages.map((p) => `@${p}`);
		const prompt = [draftValue.trim(), ...imageRefs].filter(Boolean).join("\n");
		onSubmit(prompt, attachedImages);
		setDraftValue("");
		setAttachedImages([]);
	}, [draftValue, attachedImages, onSubmit]);

	return (
		<div
			aria-label="Workspace composer"
			className="flex min-h-[132px] flex-col rounded-2xl border border-app-border/40 bg-app-sidebar px-4 pb-3 pt-3 shadow-[0_-4px_24px_rgba(0,0,0,0.12),0_0_0_1px_rgba(255,255,255,0.03)]"
		>
			<label htmlFor="workspace-input" className="sr-only">
				Workspace input
			</label>

			{attachedImages.length > 0 ? (
				<div className="mb-2 flex flex-wrap gap-1.5">
					{attachedImages.map((p) => (
						<ImagePreviewBadge
							key={p}
							path={p}
							onRemove={() => handleRemoveImage(p)}
						/>
					))}
				</div>
			) : null}

			<textarea
				id="workspace-input"
				aria-label="Workspace input"
				value={draftValue}
				onChange={(event) => {
					handleValueChange(event.currentTarget.value);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						if (!sendDisabled) {
							handleSubmit();
						}
					}
				}}
				placeholder="Ask to make changes, @mention files, run /commands"
				className="min-h-[64px] flex-1 resize-none bg-transparent text-[14px] leading-5 tracking-[-0.01em] text-app-foreground outline-none placeholder:text-app-muted"
			/>

			{sendError ? (
				<div className="mt-2 rounded-lg border border-app-canceled/30 bg-app-canceled/10 px-3 py-2 text-[12px] text-app-foreground-soft">
					{sendError}
				</div>
			) : null}

			<div className="mt-2.5 flex items-end justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger className="flex items-center gap-1.5 rounded-lg px-1 py-0.5 text-[13px] font-medium text-app-foreground-soft transition-colors hover:text-app-foreground focus-visible:outline-none">
							{selectedModel?.provider === "codex" ? (
								<OpenAIIcon className="size-[14px]" />
							) : (
								<ClaudeIcon className="size-[14px]" />
							)}
							<span>{selectedModel?.label ?? "Select model"}</span>
							<ChevronDown className="size-3 opacity-40" strokeWidth={2} />
						</DropdownMenuTrigger>

						<DropdownMenuContent
							side="top"
							align="start"
							sideOffset={8}
							className="min-w-[17rem]"
						>
							{modelSections.map((section, index) => (
								<DropdownMenuGroup key={section.id}>
									{index > 0 ? <DropdownMenuSeparator /> : null}
									<DropdownMenuLabel>{section.label}</DropdownMenuLabel>
									{section.options.map((option) => (
										<DropdownMenuItem
											key={option.id}
											onClick={() => {
												onSelectModel(option.id);
											}}
											className="flex items-center justify-between gap-3"
										>
											<div className="flex items-center gap-3">
												<span className="text-app-foreground-soft">
													{option.provider === "codex" ? (
														<OpenAIIcon className="size-4" />
													) : (
														<ClaudeIcon className="size-4" />
													)}
												</span>
												<span className="font-medium">{option.label}</span>
											</div>

											{option.badge ? (
												<span className="rounded-md border border-app-border-strong/70 bg-app-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-app-foreground-soft">
													{option.badge}
												</span>
											) : null}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							))}
						</DropdownMenuContent>
					</DropdownMenu>

					{/* Effort level dropdown — text-only trigger */}
					<DropdownMenu>
						<DropdownMenuTrigger className="flex items-center gap-0.5 px-1 py-0.5 text-[13px] font-medium focus-visible:outline-none">
							<span
								className={cn(
									"capitalize",
									effectiveEffort === "max" || effectiveEffort === "xhigh"
										? "effort-max-text"
										: "text-violet-400",
								)}
							>
								{effectiveEffort === "xhigh" ? "Extra High" : effectiveEffort}
							</span>
							<ChevronDown
								className="size-3 text-app-foreground-soft/40"
								strokeWidth={2}
							/>
						</DropdownMenuTrigger>
						<DropdownMenuContent
							side="top"
							align="start"
							sideOffset={8}
							className="min-w-[11rem]"
						>
							<DropdownMenuGroup>
								<DropdownMenuLabel>Effort</DropdownMenuLabel>
								{(provider === "codex"
									? (["minimal", "low", "medium", "high", "xhigh"] as const)
									: isOpus
										? (["low", "medium", "high", "max"] as const)
										: (["low", "medium", "high"] as const)
								).map((level) => (
									<DropdownMenuItem
										key={level}
										onClick={() => onSelectEffort(level)}
										className="flex items-center justify-between gap-3"
									>
										<div className="flex items-center gap-2.5">
											<EffortBrainIcon level={level} />
											<span className="font-medium capitalize">
												{level === "xhigh" ? "Extra High" : level}
											</span>
										</div>
										{level === effectiveEffort ? (
											<span className="text-[11px] text-violet-400">✓</span>
										) : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					{/* Plan mode toggle */}
					<ComposerButton
						aria-label="Plan mode"
						className={cn(
							"gap-1.5 rounded-md px-2 py-0.5 text-[13px] font-medium transition-colors",
							permissionMode === "plan"
								? "text-[#48968c] ring-1 ring-[#48968c]/40 hover:text-[#48968c]"
								: "text-app-muted/50 hover:text-app-muted",
						)}
						onClick={onTogglePlanMode}
					>
						<ClipboardList className="size-[14px]" strokeWidth={1.8} />
						<span>Plan</span>
					</ComposerButton>
				</div>

				<div className="flex items-center gap-2">
					{sending ? (
						<button
							type="button"
							aria-label="Stop"
							onClick={onStop}
							className="flex size-8 items-center justify-center rounded-[9px] border border-red-500/40 bg-red-500/10 text-red-400 transition-transform hover:-translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40"
						>
							<Square className="size-3 fill-current" strokeWidth={0} />
						</button>
					) : (
						<button
							type="button"
							aria-label="Send"
							onClick={handleSubmit}
							disabled={sendDisabled}
							className={cn(
								"flex size-8 items-center justify-center rounded-[9px] border border-app-border-strong bg-app-sidebar-strong text-app-foreground transition-transform focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-app-border-strong",
								sendDisabled
									? "cursor-not-allowed opacity-50"
									: "hover:-translate-y-px",
							)}
						>
							<ArrowUp className="size-[15px]" strokeWidth={2.2} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
});

/**
 * Brain icon with varying cortex complexity to represent effort levels.
 * From smooth (minimal/low) to deeply folded (max/xhigh).
 */
function EffortBrainIcon({ level }: { level: string }) {
	const cls = "size-4 shrink-0";

	// minimal — smooth brain, no folds
	if (level === "minimal") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path
					d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z"
					opacity="0.7"
				/>
			</svg>
		);
	}

	// low — one gentle fold
	if (level === "low") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path
					d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z"
					opacity="0.8"
				/>
				<path d="M8.5 8c2-1.5 5-1.5 7 0" opacity="0.5" />
			</svg>
		);
	}

	// medium — two folds
	if (level === "medium") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path
					d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z"
					opacity="0.85"
				/>
				<path d="M8 7c2-1.5 4-1 6 0" opacity="0.5" />
				<path d="M8.5 11c1.5 1 3.5 1 5 0" opacity="0.5" />
			</svg>
		);
	}

	// high — three folds
	if (level === "high") {
		return (
			<svg
				className={cls}
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z" />
				<path d="M7.5 7c1.5-1.5 4-2 6.5-0.5" opacity="0.6" />
				<path d="M8 10c1.5 1 3 1.2 5 0" opacity="0.6" />
				<path d="M9 13c1 0.8 2.5 0.8 4 0" opacity="0.6" />
			</svg>
		);
	}

	// max / xhigh — dense folds, full complexity
	return (
		<svg
			className={cls}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M12 2C8.5 2 5 5 5 9c0 3 1.5 5 3 6.5V20a2 2 0 002 2h4a2 2 0 002-2v-4.5c1.5-1.5 3-3.5 3-6.5 0-4-3.5-7-7-7z" />
			<path d="M7 6.5c2-2 5-2 7.5-0.5" opacity="0.7" />
			<path d="M7.5 9c1.5 1.5 4 1.5 6 0" opacity="0.7" />
			<path d="M8 11.5c1.5 1 3.5 1.2 5 0" opacity="0.7" />
			<path d="M9 14c1 0.7 2.5 0.7 3.5 0" opacity="0.7" />
			<path d="M12 4v2" opacity="0.4" />
		</svg>
	);
}
