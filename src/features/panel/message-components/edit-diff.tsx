import { type ReactNode, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Separator } from "@/components/ui/separator";

export function EditDiffTrigger({
	file,
	diffAdd,
	diffDel,
	oldStr,
	newStr,
	icon,
}: {
	file: string;
	diffAdd?: number;
	diffDel?: number;
	oldStr: string | null;
	newStr: string | null;
	icon?: ReactNode;
}) {
	const triggerRef = useRef<HTMLSpanElement>(null);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	const show = useCallback(() => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		if (triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setPos({ x: rect.left, y: rect.bottom + 4 });
		}
	}, []);
	const hideDelayed = useCallback(() => {
		hideTimer.current = setTimeout(() => setPos(null), 120);
	}, []);

	return (
		<>
			<span
				ref={triggerRef}
				onMouseEnter={show}
				onMouseLeave={hideDelayed}
				className="inline-flex cursor-default items-center gap-1.5 rounded border border-border/60 px-1.5 py-0.5 transition-colors hover:border-muted-foreground/40 hover:bg-accent/40"
			>
				{icon}
				<span className="truncate text-muted-foreground">{file}</span>
				{diffAdd != null || diffDel != null ? (
					<span className="flex items-center gap-1 text-[11px]">
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
							className="fixed z-[100] w-[min(40rem,90vw)] rounded-lg border border-border bg-popover shadow-xl"
							style={{ left: pos.x, top: pos.y }}
						>
							<div className="border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
								{file}
							</div>
							<div className="max-h-[24rem] overflow-auto font-mono text-[11px] leading-5">
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
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
