import { useQuery } from "@tanstack/react-query";
import { toSvg } from "html-to-image";
import { Camera, Check, Copy, Loader2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { loadSessionThreadMessages, type ThreadMessageLike } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useWorkspaceToast } from "@/lib/workspace-toast-context";
import { MemoConversationMessage } from "./message-components";

const CAPTURE_WIDTH = 820;

type ExportSessionImageButtonProps = {
	sessionId: string | null;
};

export const ExportSessionImageButton = memo(function ExportSessionImageButton({
	sessionId,
}: ExportSessionImageButtonProps) {
	const [open, setOpen] = useState(false);
	const disabled = !sessionId;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<DialogTrigger asChild>
						<Button
							aria-label="Export session as image"
							variant="ghost"
							size="icon-xs"
							disabled={disabled}
							className="-translate-x-1 text-muted-foreground hover:text-foreground"
						>
							<Camera className="size-4" strokeWidth={1.8} />
						</Button>
					</DialogTrigger>
				</TooltipTrigger>
				<TooltipContent
					side="bottom"
					className="flex h-[24px] items-center gap-2 rounded-md px-2 text-[12px] leading-none"
				>
					<span>Export session as image</span>
				</TooltipContent>
			</Tooltip>
			{open && sessionId ? (
				<ExportSessionImageDialogContent sessionId={sessionId} />
			) : null}
		</Dialog>
	);
});

function ExportSessionImageDialogContent({ sessionId }: { sessionId: string }) {
	const pushToast = useWorkspaceToast();
	// The main thread query is paginated (tail-only) for big-session
	// switching speed, but the image export needs the entire history.
	// Fetch with `tailLimit: null` here — separate query key so the
	// trailing snapshot used by the live chat panel isn't blown away.
	const messagesQuery = useQuery({
		queryKey: [...helmorQueryKeys.sessionMessages(sessionId), "thread", "full"],
		queryFn: () => loadSessionThreadMessages(sessionId, { tailLimit: null }),
		enabled: Boolean(sessionId),
		staleTime: 60_000,
	});
	const messages = useMemo<ThreadMessageLike[]>(
		() => messagesQuery.data ?? [],
		[messagesQuery.data],
	);

	const captureRef = useRef<HTMLDivElement | null>(null);
	const startedRef = useRef(false);
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [imageBlob, setImageBlob] = useState<Blob | null>(null);
	const [status, setStatus] = useState<
		"idle" | "rendering" | "ready" | "error"
	>("idle");
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		// Single-shot: only kick off once per mount of this dialog
		// content. We deliberately do NOT use a "cancelled" flag here —
		// React StrictMode's simulated cleanup would set it to true and
		// deadlock the run before it reaches the snapshot. React 19
		// already silently ignores `setState` on unmounted components,
		// so leaking the async work after close is fine.
		if (startedRef.current) return;
		if (messagesQuery.isLoading) return;
		const target = captureRef.current;
		if (!target) return;

		startedRef.current = true;
		setStatus("rendering");

		const run = async () => {
			const t0 = performance.now();
			const trace = (label: string) =>
				console.debug(
					`[export-session-image] ${label} +${Math.round(performance.now() - t0)}ms`,
				);
			try {
				trace("fonts:wait");
				if (typeof document !== "undefined" && "fonts" in document) {
					try {
						await Promise.race([
							document.fonts.ready,
							new Promise<void>((resolve) => setTimeout(resolve, 1000)),
						]);
					} catch {
						// Ignore — font readiness is best-effort.
					}
				}
				trace("frames:wait");
				// We deliberately use `setTimeout` (not `requestAnimationFrame`)
				// here. WebKit pauses rAF whenever the document's
				// visibilityState is "hidden" — which Tauri's webview enters
				// on losing focus — and that would deadlock the export flow.
				await new Promise<void>((resolve) => setTimeout(resolve, 50));
				await new Promise<void>((resolve) => setTimeout(resolve, 250));
				trace("toPng:start");

				// We deliberately do NOT use `html-to-image`'s `toPng` /
				// `toCanvas`. Their internal `createImage` helper resolves
				// via `requestAnimationFrame`, which WebKit pauses whenever
				// `document.visibilityState === "hidden"` — a state Tauri's
				// webview can enter (e.g. window unfocused or overlay open).
				// In that case the export hangs forever. We use `toSvg` to
				// generate the SVG data URL (does not rely on rAF), then run
				// our own canvas pipeline.
				//
				// `skipFonts: true` + `cacheBust: false` avoid the secondary
				// hang where html-to-image tries to fetch every stylesheet /
				// font URL through the webview (some `asset://` URLs stall
				// indefinitely). Fonts already render correctly because the
				// SVG is rasterised by the same browser instance that has
				// the fonts loaded.
				const snapshot = renderNodeToPng(target, {
					skipFonts: true,
					cacheBust: false,
					pixelRatio: Math.min(2, window.devicePixelRatio || 1),
					backgroundColor: getBackgroundColor(target),
					filter: snapshotFilter,
				});
				const dataUrl = await Promise.race([
					snapshot,
					new Promise<string>((_, reject) =>
						setTimeout(
							() =>
								reject(
									new Error(
										"Snapshot timed out after 30s. Try a shorter session.",
									),
								),
							30_000,
						),
					),
				]);
				trace("toPng:done");
				const blob = await dataUrlToBlob(dataUrl);
				trace("blob:done");
				setImageUrl(dataUrl);
				setImageBlob(blob);
				setStatus("ready");
			} catch (error) {
				console.error("Failed to export session image", error);
				setStatus("error");
				pushToast(
					error instanceof Error ? error.message : String(error),
					"Export failed",
					"destructive",
				);
			}
		};
		void run();
	}, [messagesQuery.isLoading, pushToast]);

	const handleCopy = useCallback(async () => {
		if (!imageBlob) return;
		try {
			if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
				throw new Error("Clipboard image copy is not supported");
			}
			await navigator.clipboard.write([
				new ClipboardItem({ "image/png": imageBlob }),
			]);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch (error) {
			console.error("Failed to copy session image", error);
			pushToast(
				error instanceof Error ? error.message : String(error),
				"Copy failed",
				"destructive",
			);
		}
	}, [imageBlob, pushToast]);

	const isLoading = status === "rendering" || messagesQuery.isLoading;

	return (
		<>
			<DialogContent
				className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-[1100px]"
				showCloseButton
			>
				<DialogHeader>
					<DialogTitle>Session snapshot</DialogTitle>
					<DialogDescription className="sr-only">
						Preview and copy the current session as an image.
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 overflow-y-auto">
					{isLoading ? (
						<div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-[12px] text-muted-foreground">
							<Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
							<span>Rendering snapshot…</span>
						</div>
					) : status === "ready" && imageUrl ? (
						<img
							src={imageUrl}
							alt="Session snapshot"
							className="block h-auto w-full rounded-md"
						/>
					) : status === "error" ? (
						<div className="flex h-full min-h-[200px] items-center justify-center text-[12px] text-muted-foreground">
							Failed to render snapshot.
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="default"
						size="sm"
						onClick={handleCopy}
						disabled={!imageBlob || copied}
					>
						{copied ? (
							<>
								<Check data-icon="inline-start" strokeWidth={2} />
								Copied
							</>
						) : (
							<>
								<Copy data-icon="inline-start" strokeWidth={1.8} />
								Copy image
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>

			{typeof document !== "undefined"
				? createPortal(
						<div
							aria-hidden="true"
							style={{
								position: "fixed",
								top: 0,
								left: -100000,
								width: CAPTURE_WIDTH,
								pointerEvents: "none",
								zIndex: -1,
							}}
							className="bg-background text-foreground"
						>
							<div ref={captureRef} className="bg-background py-6">
								{messages.map((message, index) => {
									let previousAssistantMessage: ThreadMessageLike | null = null;
									for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
										const candidate = messages[cursor];
										if (candidate?.role === "assistant") {
											previousAssistantMessage = candidate;
											break;
										}
									}
									return (
										<div
											key={message.id ?? `${message.role}:${index}`}
											className="flow-root px-5 pb-1.5"
										>
											<MemoConversationMessage
												message={message}
												previousAssistantMessage={previousAssistantMessage}
												sessionId={sessionId}
												itemIndex={index}
											/>
										</div>
									);
								})}
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

function getBackgroundColor(element: HTMLElement): string {
	const styles = window.getComputedStyle(element);
	const bg = styles.backgroundColor;
	if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
		return bg;
	}
	const bodyBg = window.getComputedStyle(document.body).backgroundColor;
	return bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" ? bodyBg : "#ffffff";
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
	const response = await fetch(dataUrl);
	return response.blob();
}

// Skip nodes that html-to-image cannot rasterise reliably: <canvas>
// (Lottie / xterm), <video>, <iframe>, and any element flagged as hidden.
// Returning false from the filter prunes the node from the cloned tree.
function snapshotFilter(node: Node): boolean {
	if (!(node instanceof Element)) return true;
	const tag = node.tagName;
	if (tag === "CANVAS" || tag === "VIDEO" || tag === "IFRAME") {
		return false;
	}
	return true;
}

type RenderOptions = {
	skipFonts?: boolean;
	cacheBust?: boolean;
	pixelRatio?: number;
	backgroundColor?: string;
	filter?: (node: Node) => boolean;
};

/**
 * DOM-to-PNG that does NOT depend on `requestAnimationFrame`.
 *
 * `html-to-image`'s built-in `toPng` resolves via `requestAnimationFrame`
 * after the SVG-as-image decode completes. WebKit pauses rAF whenever
 * `document.visibilityState === "hidden"` (which Tauri webviews enter on
 * losing focus), so the bundled `toPng` hangs forever in that case. We
 * reuse `toSvg` (which doesn't rely on rAF) and then drive the canvas
 * conversion ourselves with only `Image.onload` + `decode()`.
 */
async function renderNodeToPng(
	node: HTMLElement,
	options: RenderOptions = {},
): Promise<string> {
	const svgDataUrl = await toSvg(node, options);

	const naturalWidth =
		node.clientWidth +
		px(node, "border-left-width") +
		px(node, "border-right-width");
	const naturalHeight =
		node.clientHeight +
		px(node, "border-top-width") +
		px(node, "border-bottom-width");

	const img = new Image();
	img.decoding = "async";
	// Note: do NOT set crossOrigin — for `data:image/svg+xml;...` URLs it's
	// unnecessary, and on some WebKit builds it causes spurious CORS
	// validation that can stall.

	await new Promise<void>((resolve, reject) => {
		img.onload = () => resolve();
		img.onerror = () =>
			reject(new Error("Failed to load SVG snapshot into Image"));
		img.src = svgDataUrl;
	});
	try {
		await img.decode();
	} catch {
		// `decode()` is best-effort — drawImage will still work if the
		// image loaded.
	}

	const ratio = options.pixelRatio ?? window.devicePixelRatio ?? 1;
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(naturalWidth * ratio));
	canvas.height = Math.max(1, Math.round(naturalHeight * ratio));
	canvas.style.width = `${naturalWidth}px`;
	canvas.style.height = `${naturalHeight}px`;

	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("2D canvas context is not available");
	}
	if (options.backgroundColor) {
		ctx.fillStyle = options.backgroundColor;
		ctx.fillRect(0, 0, canvas.width, canvas.height);
	}
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

	return canvas.toDataURL("image/png");
}

function px(node: HTMLElement, property: string): number {
	const value = window.getComputedStyle(node).getPropertyValue(property);
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}
