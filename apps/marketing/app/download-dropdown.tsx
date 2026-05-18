"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoData } from "@/lib/github";

/** Grace period before a hover-out closes the menu — long enough for the
 * pointer to cross the 8px gap from trigger to panel without dismissing. */
const CLOSE_DELAY_MS = 140;

type Props = {
	data: Pick<
		RepoData,
		| "version"
		| "releasesUrl"
		| "armDmgUrl"
		| "armDmgSize"
		| "intelDmgUrl"
		| "intelDmgSize"
		| "signedAndNotarized"
	>;
};

/**
 * Primary CTA with an expandable architecture picker.
 *
 * Behavior (ported from Marketing Site.html):
 *  - hover opens, hover-out schedules a delayed close (cancelable on re-enter)
 *  - click toggles, focus on trigger opens
 *  - outside click or Escape closes
 *
 * The menu uses `data-open` for CSS transitions and `aria-expanded` for a11y.
 */
export function DownloadDropdown({ data }: Props) {
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearCloseTimer = useCallback(() => {
		if (closeTimerRef.current != null) {
			clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
	}, []);

	const openNow = useCallback(() => {
		clearCloseTimer();
		setOpen(true);
	}, [clearCloseTimer]);

	const closeNow = useCallback(() => {
		clearCloseTimer();
		setOpen(false);
	}, [clearCloseTimer]);

	const scheduleClose = useCallback(() => {
		clearCloseTimer();
		closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
	}, [clearCloseTimer]);

	// Outside click + Escape. Only mounted while open to avoid idle listeners.
	useEffect(() => {
		if (!open) return;
		const onDocPointerDown = (e: MouseEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDocPointerDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDocPointerDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	// Cancel any pending close timer on unmount to prevent setState-after-unmount.
	useEffect(() => clearCloseTimer, [clearCloseTimer]);

	return (
		<div
			className="dl-menu"
			data-open={open}
			ref={menuRef}
			onMouseEnter={openNow}
			onMouseLeave={scheduleClose}
		>
			<button
				type="button"
				className="btn primary dl-trigger"
				aria-haspopup="menu"
				aria-expanded={open}
				onFocus={openNow}
				onClick={() => (open ? closeNow() : openNow())}
			>
				<DownloadIcon />
				Download for macOS
				<CaretIcon />
			</button>
			<div className="dl-panel" role="menu">
				<a
					className="dl-item"
					href={data.armDmgUrl}
					role="menuitem"
					onClick={closeNow}
				>
					<span className="dl-chip">ARM</span>
					<span className="dl-text">
						<span className="dl-title">Apple Silicon</span>
						<span className="dl-sub">M series</span>
					</span>
					<span className="dl-size">
						·dmg {formatMegabytes(data.armDmgSize)}
					</span>
				</a>
				<a
					className="dl-item"
					href={data.intelDmgUrl}
					role="menuitem"
					onClick={closeNow}
				>
					<span className="dl-chip">x64</span>
					<span className="dl-text">
						<span className="dl-title">Intel</span>
						<span className="dl-sub">macOS 12+</span>
					</span>
					<span className="dl-size">
						·dmg {formatMegabytes(data.intelDmgSize)}
					</span>
				</a>
				<div className="dl-foot">
					<span>
						{data.version}
						{data.signedAndNotarized ? (
							<>
								{" · "}
								<span className="ok">signed &amp; notarized</span>
							</>
						) : null}
					</span>
					<a href={data.releasesUrl} onClick={closeNow}>
						All →
					</a>
				</div>
			</div>
		</div>
	);
}

/** "67319398" → "64.2 MB". Matches the mono-type spec strings in the design. */
function formatMegabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadIcon() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);
}

function CaretIcon() {
	return (
		<svg
			className="caret"
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}
