import {
	getMaterialFileIcon,
	getMaterialFolderIcon,
} from "file-extension-icon-js";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { AnimatedShinyText } from "@/components/ui/animated-shiny-text";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { cn } from "@/lib/utils";
import type { ChangeRow } from "./types";

export const STATUS_COLORS: Record<ChangeRow["status"], string> = {
	M: "text-yellow-500",
	A: "text-green-500",
	D: "text-red-500",
};

const fileIconCache = new Map<string, string>();
const folderIconCache = new Map<string, string>();
const PLAYED_FLASH_KEY_TTL_MS = 30_000;
const FLASH_ANIMATION_FALLBACK_MS = 3500;
const PLAYED_LINE_STATS_MOUNT_KEY_TTL_MS = 30_000;
const playedFlashKeys = new Map<string, number>();
const playedLineStatsMountKeys = new Map<string, number>();

export function RowIconButton({
	onClick,
	disabled = false,
	children,
	className,
	"aria-label": ariaLabel,
}: {
	onClick: () => void;
	disabled?: boolean;
	children: React.ReactNode;
	className?: string;
	"aria-label": string;
}) {
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={ariaLabel}
			disabled={disabled}
			onClick={(event) => {
				event.stopPropagation();
				onClick();
			}}
			onKeyDown={(event) => event.stopPropagation()}
			className={cn(
				"size-4 rounded-sm transition-colors disabled:pointer-events-none disabled:opacity-60",
				className,
			)}
		>
			{children}
		</Button>
	);
}

export function ShinyFlash({
	active,
	flashKey,
	children,
}: {
	active: boolean;
	flashKey?: string;
	children: React.ReactNode;
}) {
	const [shimmer, setShimmer] = useState(false);
	const counterRef = useRef(0);

	useEffect(() => {
		if (!active) {
			setShimmer(false);
			return;
		}
		if (flashKey && !claimFlashKey(flashKey)) {
			return;
		}
		counterRef.current += 1;
		setShimmer(true);
		const timeoutId = window.setTimeout(
			() => setShimmer(false),
			FLASH_ANIMATION_FALLBACK_MS,
		);
		return () => window.clearTimeout(timeoutId);
	}, [active, flashKey]);

	if (!shimmer) {
		return <span className="min-w-0 truncate text-left">{children}</span>;
	}

	return (
		<AnimatedShinyText
			key={counterRef.current}
			shimmerWidth={60}
			className="!mx-0 min-w-0 !max-w-none truncate text-left !text-neutral-500/80 ![animation-duration:1s] ![animation-iteration-count:3] ![animation-name:shiny-text-continuous] ![animation-timing-function:ease-in-out] dark:!text-neutral-500/80 dark:via-white via-black"
			onAnimationEnd={() => setShimmer(false)}
			onAnimationEndCapture={() => setShimmer(false)}
		>
			{children}
		</AnimatedShinyText>
	);
}

function claimFlashKey(flashKey: string) {
	const now = Date.now();
	for (const [key, playedAt] of playedFlashKeys) {
		if (now - playedAt > PLAYED_FLASH_KEY_TTL_MS) {
			playedFlashKeys.delete(key);
		}
	}
	if (playedFlashKeys.has(flashKey)) {
		return false;
	}
	playedFlashKeys.set(flashKey, now);
	return true;
}

export function LineStats({
	insertions,
	deletions,
	animationKey,
	animationsEnabled = true,
}: {
	insertions: number;
	deletions: number;
	animationKey?: string;
	animationsEnabled?: boolean;
}) {
	const insertionsAnimateOnMount = useLineStatMountAnimation(
		animationKey && insertions > 0 ? `${animationKey}:insertions` : undefined,
		animationsEnabled,
	);
	const deletionsAnimateOnMount = useLineStatMountAnimation(
		animationKey && deletions > 0 ? `${animationKey}:deletions` : undefined,
		animationsEnabled,
	);

	if (insertions === 0 && deletions === 0) {
		return null;
	}

	return (
		<span className="flex shrink-0 items-center gap-1 text-micro tabular-nums">
			{insertions > 0 && (
				<span className="text-chart-2">
					+
					{animationsEnabled ? (
						<NumberTicker
							value={insertions}
							animateOnMount={insertionsAnimateOnMount}
							className="text-chart-2"
						/>
					) : (
						<span className="inline-block tabular-nums">{insertions}</span>
					)}
				</span>
			)}
			{deletions > 0 && (
				<span className="text-destructive">
					-
					{animationsEnabled ? (
						<NumberTicker
							value={deletions}
							animateOnMount={deletionsAnimateOnMount}
							className="text-destructive"
						/>
					) : (
						<span className="inline-block tabular-nums">{deletions}</span>
					)}
				</span>
			)}
		</span>
	);
}

function useLineStatMountAnimation(
	animationKey: string | undefined,
	enabled: boolean,
) {
	const animateOnMount =
		enabled &&
		(!animationKey || !hasPlayedLineStatMountAnimation(animationKey));

	useEffect(() => {
		if (!enabled || !animationKey) {
			return;
		}
		markLineStatMountAnimationPlayed(animationKey);
	}, [enabled, animationKey]);

	return animateOnMount;
}

function hasPlayedLineStatMountAnimation(animationKey: string) {
	const now = Date.now();
	for (const [key, playedAt] of playedLineStatsMountKeys) {
		if (now - playedAt > PLAYED_LINE_STATS_MOUNT_KEY_TTL_MS) {
			playedLineStatsMountKeys.delete(key);
		}
	}
	return playedLineStatsMountKeys.has(animationKey);
}

function markLineStatMountAnimationPlayed(animationKey: string) {
	playedLineStatsMountKeys.set(animationKey, Date.now());
}

export function getCachedFileIcon(name: string) {
	const key = name.slice(name.lastIndexOf(".") + 1).toLowerCase() || name;
	const existing = fileIconCache.get(key);
	if (existing) return existing;
	const icon = getMaterialFileIcon(name);
	fileIconCache.set(key, icon);
	return icon;
}

export function getCachedFolderIcon(name: string, open: boolean) {
	const key = `${name}:${open ? "open" : "closed"}`;
	const existing = folderIconCache.get(key);
	if (existing) return existing;
	const icon = getMaterialFolderIcon(name, open || undefined);
	folderIconCache.set(key, icon);
	return icon;
}
