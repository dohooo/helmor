import { ChevronDown, Tag } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { FileMentionBadge } from "@/components/file-mention-badge";
import { InlineBadge } from "@/components/inline-badge";
import type { MessagePart } from "@/lib/api";
import {
	buildComposerPreviewLabel,
	type ComposerPreviewPayload,
	inferComposerPreviewLanguage,
} from "@/lib/composer-insert";
import { useI18n } from "@/lib/i18n";
import { USER_MESSAGE_CLAMP_LINES } from "@/lib/message-layout-estimator";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { markAnchoredToggle } from "./anchored-toggle";
import { CopyMessageButton } from "./copy-message";
import type { RenderedMessage } from "./shared";
import { isFileMentionPart, isPastedTextPart, isTextPart } from "./shared";
import { useUserMessageExpansion } from "./user-message-expansion";

// Attachments arrive as structured `file-mention` parts and pasted tags as
// `pasted-text` parts (see `splitTextWithFiles`); the file badge picks file
// vs image by extension. Do not regex-scan text parts for `@<path>` — it
// would truncate paths containing whitespace.

/**
 * A pasted-text tag span, rendered with the SAME chip the composer shows
 * before sending: label from the first content line, hover opens the
 * preview popover with the full (highlighted) content.
 */
function PastedTextBadge({ text }: { text: string }) {
	const language = inferComposerPreviewLanguage(text);
	const label = buildComposerPreviewLabel(text, language ? "code" : "text");
	const preview: ComposerPreviewPayload = language
		? { kind: "code", title: label, code: text, language }
		: { kind: "text", title: label, text };
	return (
		<InlineBadge
			icon={
				<Tag
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
			}
			label={label}
			preview={preview}
			nonSelectable={false}
		/>
	);
}

export function ChatUserMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];
	const { t } = useI18n();
	const { settings } = useSettings();

	// Long messages clamp to the first N VISUAL lines with a "Show more"
	// control. The body always carries the line-clamp while collapsed and the
	// browser itself reports whether anything was actually cut off
	// (scrollHeight > clientHeight) — no line counting, no prediction, so a
	// single unbroken paragraph that wraps to dozens of lines clamps exactly
	// like one with hard newlines. Width and font changes re-report through
	// the ResizeObserver. Expansion state lives in the session-scoped
	// provider so it survives a row unmount and resets on session switch.
	const { expanded, toggle } = useUserMessageExpansion(message.id);
	const clamped = !expanded;
	const bodyRef = useRef<HTMLParagraphElement | null>(null);
	const [truncated, setTruncated] = useState(false);
	const measureTruncation = useCallback(() => {
		const el = bodyRef.current;
		if (!el) return;
		// +1 absorbs fractional line-height rounding in the integer metrics.
		setTruncated(el.scrollHeight > el.clientHeight + 1);
	}, []);
	// Re-probe synchronously (pre-paint) whenever the clamp toggles, so
	// collapsing doesn't hide the control for a frame until the
	// ResizeObserver below catches up.
	useLayoutEffect(() => {
		measureTruncation();
	}, [measureTruncation, clamped]);
	useLayoutEffect(() => {
		const el = bodyRef.current;
		if (!el || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => {
			measureTruncation();
		});
		observer.observe(el);
		return () => {
			observer.disconnect();
		};
	}, [measureTruncation]);
	// While expanded nothing is cut off, so `truncated` is false — the
	// control stays visible as "Show less" via `expanded`.
	const showClampControl = truncated || expanded;

	// "Expand upward": DOM content always grows downward, so pin the clicked
	// control to its viewport position instead — record its top before the
	// toggle and offset the scroller by the delta pre-paint. The control (and
	// everything below it) stays pixel-still while the content unfolds above;
	// collapse is symmetric. Same anchoring pattern as the load-earlier flow.
	// At the document edges the browser clamps the offset — there's simply
	// nothing left to scroll, which is the right degradation.
	const controlRef = useRef<HTMLButtonElement | null>(null);
	const pendingToggleAnchorRef = useRef<{
		scroller: HTMLElement;
		controlTop: number;
	} | null>(null);
	const handleToggleAnchored = useCallback(() => {
		const control = controlRef.current;
		const scroller = control?.closest(".conversation-scroll-viewport");
		if (control && scroller instanceof HTMLElement) {
			pendingToggleAnchorRef.current = {
				scroller,
				controlTop: control.getBoundingClientRect().top,
			};
			// Tell the viewport this row's next height change is pre-compensated.
			if (message.id) {
				markAnchoredToggle(message.id);
			}
		}
		if (expanded) {
			// Collapsing re-truncates (it was truncated before expanding —
			// that's why the control exists). Set it optimistically in the
			// same commit so the control never leaves the tree and the anchor
			// effect below can measure it. The truncation probe re-runs after
			// the commit anyway and corrects the rare case where it no longer
			// truncates (e.g. the pane got wider while expanded).
			setTruncated(true);
		}
		toggle();
	}, [toggle, expanded, message.id]);
	useLayoutEffect(() => {
		const anchor = pendingToggleAnchorRef.current;
		if (!anchor) {
			return;
		}
		pendingToggleAnchorRef.current = null;
		const control = controlRef.current;
		if (!control) {
			return;
		}
		const delta = control.getBoundingClientRect().top - anchor.controlTop;
		if (delta !== 0) {
			anchor.scroller.scrollTop += delta;
		}
	}, [expanded]);

	return (
		<div
			data-message-id={message.id}
			data-message-role="user"
			className="group/user flex min-w-0 justify-end"
		>
			<div className="relative flex max-w-[75%] min-w-0 flex-col items-end pb-5">
				<div
					className="conversation-body-text w-full overflow-hidden rounded-md bg-accent/55 px-3 py-2 leading-7"
					style={{ fontSize: `${settings.chatFontSize}px` }}
				>
					<p
						ref={bodyRef}
						className="whitespace-pre-wrap break-words"
						style={
							clamped
								? {
										display: "-webkit-box",
										WebkitBoxOrient: "vertical",
										WebkitLineClamp: USER_MESSAGE_CLAMP_LINES,
										overflow: "hidden",
									}
								: undefined
						}
					>
						{parts.map((part, index) => {
							if (isTextPart(part)) {
								return <span key={index}>{part.text}</span>;
							}
							if (isFileMentionPart(part)) {
								return <FileMentionBadge key={index} path={part.path} />;
							}
							if (isPastedTextPart(part)) {
								return <PastedTextBadge key={index} text={part.text} />;
							}
							return null;
						})}
					</p>
					{showClampControl && (
						<button
							ref={controlRef}
							type="button"
							onClick={handleToggleAnchored}
							aria-expanded={expanded}
							className="mt-1 flex cursor-pointer items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
						>
							{expanded ? t("panelShowLess") : t("panelShowMore")}
							<ChevronDown
								className={cn("size-3.5 shrink-0", expanded && "rotate-180")}
								strokeWidth={1.8}
							/>
						</button>
					)}
				</div>
				<div className="pointer-events-none absolute right-1 bottom-0 flex items-center justify-end opacity-0 group-hover/user:pointer-events-auto group-hover/user:opacity-100 group-focus-within/user:pointer-events-auto group-focus-within/user:opacity-100">
					<CopyMessageButton
						message={message}
						className="size-5 shrink-0 text-muted-foreground/28 hover:text-muted-foreground"
					/>
				</div>
			</div>
		</div>
	);
}
