/**
 * Mockup-private shared types, tokens, helpers and leaf icons.
 *
 * This file is intentionally a frozen copy of the bits the onboarding mockup
 * needs from `features/navigation/shared.tsx` and `features/inspector/layout.tsx`.
 * The mockup must NOT import from those production modules — that's the
 * whole point of the `mockup/ui/` boundary. If a real component changes,
 * the mockup keeps rendering the snapshot it was last hand-synced to.
 */

import {
	IssueClosedIcon,
	IssueDraftIcon,
	XCircleFillIcon,
} from "@primer/octicons-react";
import { Pin } from "lucide-react";
import helmorLogo from "@/assets/helmor-logo-light.png";
import {
	Avatar,
	AvatarBadge,
	AvatarFallback,
	AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

// ─── Types (mockup-private, decoupled from @/lib/api) ─────────────────────

export type GroupTone =
	| "pinned"
	| "done"
	| "review"
	| "progress"
	| "backlog"
	| "canceled";

export type WorkspaceBranchTone =
	| "working"
	| "open"
	| "merged"
	| "closed"
	| "inactive";

export type ActionStatusKind = "success" | "running" | "failure" | "pending";

export type InspectorFileStatus = "M" | "A" | "D";

// ─── Design tokens ────────────────────────────────────────────────────────

export const groupToneClasses: Record<GroupTone, string> = {
	pinned: "text-[var(--workspace-sidebar-status-neutral)]",
	done: "text-[var(--workspace-sidebar-status-done)]",
	review: "text-[var(--workspace-sidebar-status-review)]",
	progress: "text-[var(--workspace-sidebar-status-progress)]",
	backlog: "text-[var(--workspace-sidebar-status-backlog)]",
	canceled: "text-[var(--workspace-sidebar-status-canceled)]",
};

export const branchToneClasses: Record<WorkspaceBranchTone, string> = {
	working: "text-[var(--workspace-branch-status-working)]",
	open: "text-[var(--workspace-branch-status-open)]",
	merged: "text-[var(--workspace-branch-status-merged)]",
	closed: "text-[var(--workspace-branch-status-closed)]",
	inactive: "text-[var(--workspace-branch-status-inactive)]",
};

export const INSPECTOR_SECTION_HEADER_CLASS =
	"flex h-8 min-w-0 shrink-0 items-center justify-between border-b border-border/60 bg-muted/25 px-3";
export const INSPECTOR_SECTION_TITLE_CLASS =
	"text-[13px] leading-8 font-medium tracking-[-0.01em] text-muted-foreground";

// ─── Helpers ──────────────────────────────────────────────────────────────

export function humanizeBranch(branch: string): string {
	const slug = branch.includes("/")
		? branch.slice(branch.indexOf("/") + 1)
		: branch;
	return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Group / status icons (copied from navigation/shared.tsx) ─────────────

function PartialCircleIcon({
	tone,
	inset,
	variant,
}: {
	tone: Extract<GroupTone, "review" | "progress">;
	inset: number;
	variant: "half-right" | "three-quarters";
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative block size-[14px] shrink-0 rounded-full border border-current",
				groupToneClasses[tone],
			)}
		>
			{variant === "half-right" ? (
				<span
					className="absolute rounded-r-full bg-current"
					style={{
						top: `${inset}px`,
						right: `${inset}px`,
						bottom: `${inset}px`,
						width: "4px",
					}}
				/>
			) : (
				<span
					className="absolute rounded-full bg-current"
					style={{
						inset: `${inset}px`,
						clipPath:
							"polygon(50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%, 50% 50%)",
					}}
				/>
			)}
		</span>
	);
}

export function GroupIcon({ tone }: { tone: GroupTone }) {
	const className = cn("shrink-0", groupToneClasses[tone]);
	const iconSize = 14;

	switch (tone) {
		case "pinned":
			return (
				<Pin
					className={cn(className, "-rotate-45")}
					size={iconSize}
					strokeWidth={2}
				/>
			);
		case "done":
			return <IssueClosedIcon className={className} size={iconSize} />;
		case "review":
			return (
				<PartialCircleIcon
					tone="review"
					inset={2.25}
					variant="three-quarters"
				/>
			);
		case "progress":
			return (
				<PartialCircleIcon tone="progress" inset={2.5} variant="half-right" />
			);
		case "backlog":
			return <IssueDraftIcon className={className} size={iconSize} />;
		case "canceled":
			return <XCircleFillIcon className={className} size={iconSize} />;
	}
}

// ─── Avatar (Helmor logo, mockup-private) ─────────────────────────────────
// All mockup rows show the Helmor logo — this is a marketing/onboarding
// preview, not a real multi-repo workspace. The `repoInitials` / `repoName`
// props are kept on the signature for shape parity with the production
// `WorkspaceAvatarUI`, but only feed the fallback shown if the image fails
// to load.

export function WorkspaceAvatarUI({
	repoInitials,
	repoName,
	title,
	className,
	fallbackClassName,
	badgeClassName,
	badgeAriaLabel,
}: {
	repoInitials?: string | null;
	repoName?: string | null;
	title: string;
	className?: string;
	fallbackClassName?: string;
	badgeClassName?: string | null;
	badgeAriaLabel?: string;
}) {
	const fallback = (
		repoInitials?.trim() || initialsFromLabel(repoName || title)
	)
		.slice(0, 2)
		.toUpperCase();
	return (
		<Avatar
			aria-hidden="true"
			data-slot="workspace-avatar"
			data-fallback={fallback}
			className={cn(
				"size-[16px] shrink-0 rounded-[5px] border-0 bg-transparent outline-none",
				className,
			)}
		>
			<AvatarImage src={helmorLogo} alt="" className="object-contain" />
			<AvatarFallback
				delayMs={0}
				className={cn(
					"bg-muted text-[7px] font-semibold uppercase tracking-[0.02em] text-muted-foreground",
					fallbackClassName,
				)}
			>
				{fallback}
			</AvatarFallback>
			{badgeClassName ? (
				<AvatarBadge
					aria-label={badgeAriaLabel}
					className={cn(
						"bottom-auto -top-0.5 z-10 size-1.5 border-0 ring-2 ring-sidebar",
						badgeClassName,
					)}
				/>
			) : null}
		</Avatar>
	);
}

function initialsFromLabel(label?: string | null) {
	if (!label) return "WS";
	const parts = label
		.split(/[^A-Za-z0-9]+/)
		.map((p) => p.trim())
		.filter(Boolean);
	if (parts.length >= 2) {
		return parts
			.slice(0, 2)
			.map((p) => p[0]?.toUpperCase() ?? "")
			.join("");
	}
	const alphanumeric = Array.from(label).filter((c) => /[A-Za-z0-9]/.test(c));
	return alphanumeric.slice(0, 2).join("").toUpperCase() || "WS";
}
