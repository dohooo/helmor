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
	// Position: top-right, flush with the padding.
	"!absolute !left-auto !right-2 !top-2",
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
					toast: "group",
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
