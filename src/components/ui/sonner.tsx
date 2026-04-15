"use client";

import {
	CircleCheckIcon,
	InfoIcon,
	Loader2Icon,
	OctagonXIcon,
	TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const closeButtonClass = [
	"!absolute !left-auto !right-1.5 !top-1.5",
	"!size-4 !p-0 !cursor-pointer",
	"!bg-transparent !border-none !rounded-none !shadow-none !transform-none",
	"!text-foreground/50 hover:!text-foreground",
	"[&>svg]:!size-3",
].join(" ");

function Toaster({ toastOptions, ...props }: ToasterProps) {
	return (
		<Sonner
			className="toaster group"
			icons={{
				success: <CircleCheckIcon className="size-4" />,
				info: <InfoIcon className="size-4" />,
				warning: <TriangleAlertIcon className="size-4" />,
				error: <OctagonXIcon className="size-4" />,
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
					...toastOptions?.classNames,
				},
			}}
			{...props}
		/>
	);
}

export { Toaster };
