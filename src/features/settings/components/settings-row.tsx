import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
	SettingsReleaseBadge,
	type SettingsReleaseMarker,
} from "./release-marker";

/// Shared layout primitives for settings panels:
///   - `SettingsGroup` stacks rows and draws a thin rule between them
///   - `SettingsRow`   the common title + description + right-control row
///   - `SettingsNotice` an inline status badge inside a row's description
///                     (success / warning / error / info)

export function SettingsGroup({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("divide-y divide-border/40", className)}>{children}</div>
	);
}

export function SettingsRow({
	title,
	releaseMarker,
	description,
	children,
	className,
	align = "center",
}: {
	title: ReactNode;
	releaseMarker?: SettingsReleaseMarker;
	description?: ReactNode;
	children?: ReactNode;
	className?: string;
	align?: "center" | "start";
}) {
	return (
		<div
			className={cn(
				"flex justify-between gap-4 py-5",
				align === "start" ? "items-start" : "items-center",
				className,
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px] font-medium leading-snug text-foreground">
					<span className="min-w-0">{title}</span>
					<SettingsReleaseBadge
						marker={releaseMarker}
						className="self-center"
					/>
				</div>
				{description ? (
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						{description}
					</div>
				) : null}
			</div>
			{children ? <div className="shrink-0">{children}</div> : null}
		</div>
	);
}

export type SettingsNoticeTone = "info" | "ok" | "warn" | "error";

const NOTICE_TONE_CLASSES: Record<SettingsNoticeTone, string> = {
	info: "text-muted-foreground/80",
	ok: "text-green-400/90",
	warn: "text-amber-400/90",
	error: "text-destructive",
};

export function SettingsNotice({
	tone = "info",
	children,
	className,
}: {
	tone?: SettingsNoticeTone;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mt-1.5 flex items-start gap-1 text-[12px] leading-snug",
				NOTICE_TONE_CLASSES[tone],
				className,
			)}
		>
			{tone === "ok" ? (
				<Check className="mt-[3px] size-3 shrink-0" strokeWidth={2} />
			) : null}
			<div className="min-w-0">{children}</div>
		</div>
	);
}
