import { type ReactNode, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

const TRIGGER_GAP = 4;
const VIEWPORT_PADDING = 16;
// If the space below the trigger is smaller than this and there's more room
// above, flip the popover upward. Anything larger stays anchored below and
// lets the body scroll within the available height.
const FLIP_THRESHOLD = 240;
const MIN_POPOVER_HEIGHT = 120;

type PopoverPos = {
	left: number;
	top: number | null;
	bottom: number | null;
	maxHeight: number;
};

export function EditDiffTrigger({
	file,
	diffAdd,
	diffDel,
	oldStr,
	newStr,
	unifiedDiff,
	icon,
	variant = "pill",
}: {
	file: string;
	diffAdd?: number;
	diffDel?: number;
	oldStr: string | null;
	newStr: string | null;
	unifiedDiff?: string | null;
	icon?: ReactNode;
	variant?: "pill" | "row";
}) {
	const triggerRef = useRef<HTMLSpanElement>(null);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pos, setPos] = useState<PopoverPos | null>(null);

	const show = useCallback(() => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		if (!triggerRef.current) return;
		const rect = triggerRef.current.getBoundingClientRect();
		const viewportHeight = window.innerHeight;
		const spaceBelow =
			viewportHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_PADDING;
		const spaceAbove = rect.top - TRIGGER_GAP - VIEWPORT_PADDING;
		const placeAbove = spaceBelow < FLIP_THRESHOLD && spaceAbove > spaceBelow;
		setPos({
			left: rect.left,
			top: placeAbove ? null : rect.bottom + TRIGGER_GAP,
			bottom: placeAbove ? viewportHeight - rect.top + TRIGGER_GAP : null,
			maxHeight: Math.max(
				MIN_POPOVER_HEIGHT,
				placeAbove ? spaceAbove : spaceBelow,
			),
		});
	}, []);
	const hideDelayed = useCallback(() => {
		hideTimer.current = setTimeout(() => setPos(null), 120);
	}, []);

	return (
		<>
			<span
				data-variant={variant}
				ref={triggerRef}
				onMouseEnter={show}
				onMouseLeave={hideDelayed}
				className={cn(
					"items-center gap-1.5 text-[12px] leading-4 text-muted-foreground transition-colors",
					variant === "row"
						? "flex w-full cursor-interactive rounded-md px-2 py-1 hover:bg-accent/60"
						: "inline-flex self-start rounded-md border border-border/60 px-1.5 py-0.5 hover:border-muted-foreground/40 hover:bg-accent/40",
				)}
			>
				{icon}
				<span className="min-w-0 truncate">{file}</span>
				{diffAdd != null || diffDel != null ? (
					<span
						className={cn(
							"flex shrink-0 items-center gap-1 text-[11px]",
							variant === "row" ? "" : "ml-auto",
						)}
					>
						{diffAdd != null ? (
							<span className="text-chart-2">+{diffAdd}</span>
						) : null}
						{diffDel != null ? (
							<span className="text-destructive">-{diffDel}</span>
						) : null}
					</span>
				) : null}
			</span>
			{pos
				? createPortal(
						<div
							onMouseEnter={show}
							onMouseLeave={hideDelayed}
							className="fixed z-[100] flex w-[min(40rem,90vw)] flex-col rounded-lg border border-border bg-popover shadow-xl"
							style={{
								left: pos.left,
								top: pos.top ?? undefined,
								bottom: pos.bottom ?? undefined,
								maxHeight: pos.maxHeight,
							}}
						>
							<div className="shrink-0 border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
								{file}
							</div>
							<div className="min-h-0 max-h-[24rem] flex-1 overflow-auto font-mono text-[11px] leading-5">
								{oldStr
									? oldStr.split("\n").map((line, index) => (
											<div
												key={`d${index}`}
												className="flex whitespace-pre-wrap bg-destructive/10"
											>
												<span className="w-8 shrink-0 select-none border-r border-border/20 pr-1 text-right text-destructive/40">
													{index + 1}
												</span>
												<span className="w-4 shrink-0 select-none text-center text-destructive/60">
													-
												</span>
												<span className="min-w-0 text-destructive/80">
													{line}
												</span>
											</div>
										))
									: null}
								{oldStr && newStr ? (
									<Separator className="my-0.5 bg-border/30" />
								) : null}
								{newStr
									? newStr.split("\n").map((line, index) => (
											<div
												key={`a${index}`}
												className="flex whitespace-pre-wrap bg-chart-2/10"
											>
												<span className="w-8 shrink-0 select-none border-r border-border/20 pr-1 text-right text-chart-2/50">
													{index + 1}
												</span>
												<span className="w-4 shrink-0 select-none text-center text-chart-2/70">
													+
												</span>
												<span className="min-w-0 text-chart-2">{line}</span>
											</div>
										))
									: null}
								{!oldStr && !newStr && unifiedDiff
									? unifiedDiff.split("\n").map((line, index) => {
											const isAdd =
												line.startsWith("+") && !line.startsWith("+++");
											const isDel =
												line.startsWith("-") && !line.startsWith("---");
											const isHeader =
												line.startsWith("@@") ||
												line.startsWith("diff --git") ||
												line.startsWith("index ") ||
												line.startsWith("--- ") ||
												line.startsWith("+++ ");
											return (
												<div
													key={`u${index}`}
													className={
														isAdd
															? "flex whitespace-pre-wrap bg-chart-2/10"
															: isDel
																? "flex whitespace-pre-wrap bg-destructive/10"
																: isHeader
																	? "flex whitespace-pre-wrap bg-accent/35"
																	: "flex whitespace-pre-wrap"
													}
												>
													<span className="w-8 shrink-0 select-none border-r border-border/20 pr-1 text-right text-muted-foreground/35">
														{index + 1}
													</span>
													<span
														className={
															isAdd
																? "w-4 shrink-0 select-none text-center text-chart-2/70"
																: isDel
																	? "w-4 shrink-0 select-none text-center text-destructive/60"
																	: "w-4 shrink-0 select-none text-center text-muted-foreground/35"
														}
													>
														{isAdd ? "+" : isDel ? "-" : ""}
													</span>
													<span
														className={
															isAdd
																? "min-w-0 text-chart-2"
																: isDel
																	? "min-w-0 text-destructive/80"
																	: isHeader
																		? "min-w-0 text-muted-foreground"
																		: "min-w-0 text-foreground/80"
														}
													>
														{line}
													</span>
												</div>
											);
										})
									: null}
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
