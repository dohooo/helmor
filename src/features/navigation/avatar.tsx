import { memo, type ReactNode, useEffect, useState } from "react";
import { Avatar, AvatarBadge, AvatarImage } from "@/components/ui/avatar";
import { ShineBorder } from "@/components/ui/shine-border";
import { cn } from "@/lib/utils";

function initialsFromLabel(label?: string | null) {
	if (!label) {
		return "WS";
	}

	const parts = label
		.split(/[^A-Za-z0-9]+/)
		.map((part) => part.trim())
		.filter(Boolean);

	if (parts.length >= 2) {
		return parts
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("");
	}

	const alphanumeric = Array.from(label).filter((character) =>
		/[A-Za-z0-9]/.test(character),
	);

	return alphanumeric.slice(0, 2).join("").toUpperCase() || "WS";
}

function getWorkspaceAvatarSrc(repoIconSrc?: string | null) {
	return repoIconSrc?.trim() ? repoIconSrc : null;
}

/** Mirrors Radix's `ImageLoadingStatus` union (not exported by the package). */
type AvatarLoadingStatus = "idle" | "loading" | "loaded" | "error";

export const WorkspaceAvatar = memo(function WorkspaceAvatar({
	repoIconSrc,
	repoInitials,
	repoName,
	title,
	className,
	fallbackClassName,
	fallbackIcon,
	badgeClassName,
	badgeAriaLabel,
	isRunning,
}: {
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	repoName?: string | null;
	title: string;
	className?: string;
	fallbackClassName?: string;
	/** Optional node rendered in place of the initials fallback. Used by
	 *  workspace flavors that have no real repo (e.g. chat-mode) where
	 *  a lucide icon reads better than a synthetic 2-letter monogram. */
	fallbackIcon?: ReactNode;
	badgeClassName?: string | null;
	badgeAriaLabel?: string;
	isRunning?: boolean;
}) {
	const fallback = (
		repoInitials?.trim() || initialsFromLabel(repoName || title)
	)
		.slice(0, 2)
		.toUpperCase();
	const src = getWorkspaceAvatarSrc(repoIconSrc);
	// Radix's <Avatar.Image> never mounts the underlying <img> unless its own
	// probe reports "loaded" — on failure it just renders `null`. A native
	// <img onError> therefore never fires, so we drive the fallback from
	// Radix's `onLoadingStatusChange` instead. Without this, a broken or
	// undecodable icon (an empty `favicon.ico`, an `.ico` WebKit can't render,
	// a corrupt file) leaves the avatar permanently blank instead of showing
	// the initials.
	const [status, setStatus] = useState<AvatarLoadingStatus>("idle");

	// Reset when the icon source changes so a new icon gets a fresh chance to
	// load before we decide to fall back.
	useEffect(() => {
		setStatus("idle");
	}, [src]);

	// Stay optimistic while idle/loading (no initials flash for good icons);
	// only fall back once the load actually errors or there's no src at all.
	const showFallback = !src || status === "error";

	return (
		<Avatar
			key={src ?? "fallback"}
			aria-hidden="true"
			data-slot="workspace-avatar"
			data-fallback={fallback}
			className={cn(
				"size-[16px] shrink-0 rounded-[5px] border-0 bg-transparent outline-none",
				className,
				showFallback && "rounded-full",
			)}
		>
			{src ? (
				<AvatarImage
					src={src}
					alt={`${repoName ?? title} icon`}
					onLoadingStatusChange={(nextStatus) => setStatus(nextStatus)}
				/>
			) : null}
			{showFallback ? (
				<span
					data-slot="avatar-fallback"
					className={cn(
						"grid size-full place-items-center bg-muted text-center text-nano font-semibold leading-none uppercase tracking-[0.02em] text-muted-foreground",
						fallbackClassName,
						"rounded-full",
					)}
				>
					{fallbackIcon ?? <span className="translate-y-px">{fallback}</span>}
				</span>
			) : null}
			{isRunning ? (
				<ShineBorder
					borderWidth={1}
					duration={6}
					shineColor={["#A07CFE", "#FE8FB5", "#FFBE7B"]}
					style={{
						inset: "-2px",
						width: "calc(100% + 4px)",
						height: "calc(100% + 4px)",
						borderRadius: "6px",
					}}
				/>
			) : null}
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
});
