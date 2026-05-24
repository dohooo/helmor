"use client";

import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const closeButtonClass = [
	// Position: top-right, sitting on the same baseline as the title row.
	// Toast padding-top is 12px and title line-height ≈ 19.5px (font 13 × 1.5);
	// `!top-3` (12px) keeps the close glyph centered with the title row.
	"!absolute !left-auto !right-2 !top-3",
	// Target size — roomy hit area, small visible glyph.
	"!size-6 !p-0 !cursor-interactive !rounded-md",
	// Base look: invisible chrome; reveal on hover.
	"!bg-transparent !border-none !shadow-none !transform-none",
	"!text-foreground/40 hover:!text-foreground",
	"hover:!bg-foreground/10",
	"transition-colors",
	// Inner glyph stays compact.
	"[&>svg]:!size-3.5",
].join(" ");

const toastClass = [
	"group",
	// Sonner ships `align-items: center`, which vertically centers the icon
	// column against the WHOLE content (title + description), pushing the
	// icon "below" the title visually. Override to `start` so the icon sits
	// on the same row as the title's first line — matches how the close
	// button is positioned and matches every other toast lib.
	"!items-start",
	// Tighter top inset (default is 16px), more breathing room between the
	// title row and the description below it (sonner default content gap is
	// 2px — bump to 8px for clearer hierarchy).
	"!pt-3",
	"[&_[data-content]]:!gap-2",
].join(" ");

const errorToastClass = [
	// Hide sonner's default left icon column — the alert icon is rendered
	// inline inside the title node (see pushWorkspaceToast in App.tsx),
	// so the whole card stays a single column with icon+title on one line.
	"[&_[data-icon]]:!hidden",
	// Red, emphasised title (inherits into the inline icon too).
	"[&_[data-title]]:!text-destructive",
	"[&_[data-title]]:!font-semibold",
	// Keep destructive action button visually linked to the toast theme.
	"[&_[data-button][data-action]]:!bg-destructive",
	"[&_[data-button][data-action]]:!text-destructive-foreground",
	"[&_[data-button][data-action]]:hover:!bg-destructive/90",
].join(" ");

function Toaster({ toastOptions, ...props }: ToasterProps) {
	return (
		<Sonner
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				// error toasts render an inline icon inside the title node
				// (see pushWorkspaceToast in App.tsx). The default icon column
				// is hidden for error variants via `errorToastClass`.
				loading: <Loader2Icon className="size-4 animate-spin" />,
			}}
			closeButton
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
					"--border-radius": "var(--radius)",
				} as CSSProperties
			}
			toastOptions={{
				...toastOptions,
				classNames: {
					toast: toastClass,
					closeButton: closeButtonClass,
					error: errorToastClass,
					...toastOptions?.classNames,
				},
			}}
			{...props}
		/>
	);
}

export { Toaster };
