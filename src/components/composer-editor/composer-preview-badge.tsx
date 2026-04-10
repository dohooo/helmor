import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
	type ComposerPreviewPayload,
	renderComposerPreview,
} from "./composer-preview-registry";

const HOVER_PREVIEW_CLOSE_DELAY_MS = 100;

export type ComposerPreviewBadgeProps = {
	icon: React.ReactNode;
	label: string;
	onRemove?: () => void;
	preview?: ComposerPreviewPayload | null;
	className?: string;
	labelClassName?: string;
	removeLabel?: string;
};

export function ComposerPreviewBadge({
	icon,
	label,
	onRemove,
	preview = null,
	className,
	labelClassName,
	removeLabel = "Remove item",
}: ComposerPreviewBadgeProps) {
	const [open, setOpen] = useState(false);
	const closeTimerRef = useRef<number | null>(null);
	const previewContent = useMemo(
		() => renderComposerPreview(preview),
		[preview],
	);
	const canPreview = previewContent !== null;

	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current !== null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const openPreview = useCallback(() => {
		if (!canPreview) return;
		clearCloseTimer();
		setOpen(true);
	}, [canPreview, clearCloseTimer]);

	const scheduleClose = useCallback(() => {
		if (!canPreview) return;
		clearCloseTimer();
		closeTimerRef.current = window.setTimeout(() => {
			setOpen(false);
			closeTimerRef.current = null;
		}, HOVER_PREVIEW_CLOSE_DELAY_MS);
	}, [canPreview, clearCloseTimer]);

	useEffect(() => clearCloseTimer, [clearCloseTimer]);

	const badge = (
		<span
			className={cn(
				"mx-0.5 inline-flex cursor-default select-none items-center gap-1 rounded border border-border/60 align-middle text-[12px] transition-colors hover:border-muted-foreground/40 hover:bg-accent/40",
				canPreview && "cursor-pointer",
				className,
			)}
			onPointerEnter={openPreview}
			onPointerLeave={scheduleClose}
		>
			<span className="inline-flex min-w-0 items-center gap-1.5 px-1.5 py-0.5">
				{icon}
				<span
					className={cn(
						"max-w-[200px] truncate text-muted-foreground",
						labelClassName,
					)}
				>
					{label}
				</span>
			</span>
			{onRemove ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={removeLabel}
					className="text-muted-foreground/40 hover:text-muted-foreground"
					onMouseDown={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onRemove();
					}}
				>
					<X className="size-3" strokeWidth={1.8} />
				</Button>
			) : null}
		</span>
	);

	if (!canPreview) {
		return badge;
	}

	return (
		<Popover open={open}>
			<PopoverAnchor asChild>{badge}</PopoverAnchor>
			<PopoverContent
				side="top"
				align="start"
				sideOffset={10}
				onOpenAutoFocus={(event) => event.preventDefault()}
				onCloseAutoFocus={(event) => event.preventDefault()}
				onPointerEnter={openPreview}
				onPointerLeave={scheduleClose}
				className="w-[520px] max-w-[80vw] gap-0 overflow-hidden p-0"
			>
				{previewContent}
			</PopoverContent>
		</Popover>
	);
}
