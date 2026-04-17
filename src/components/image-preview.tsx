import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, X } from "lucide-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { basename } from "@/lib/path-util";

/** Regex matching an absolute image path (may appear anywhere in a string). */
const IMAGE_PATH_RE =
	/(?:^|\s)(\/\S+\.(?:png|jpe?g|gif|webp|svg|bmp|ico))(?:\s|$)/gim;

/** Extract image file paths from text. Detects paths anywhere, not just at line start. */
export function extractImagePaths(text: string): string[] {
	const paths: string[] = [];
	IMAGE_PATH_RE.lastIndex = 0;
	for (
		let match = IMAGE_PATH_RE.exec(text);
		match !== null;
		match = IMAGE_PATH_RE.exec(text)
	) {
		paths.push(match[1]);
	}
	return [...new Set(paths)];
}

/** Test whether a single string looks like an absolute image path. */
export function isImagePath(text: string): boolean {
	return (
		text.startsWith("/") &&
		/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(text.trim())
	);
}

/** Styled badge for an image path. Click to preview. Optional remove button. */
export function ImagePreviewBadge({
	path,
	onRemove,
}: {
	path: string;
	onRemove?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const fileName = basename(path);

	const handleClick = useCallback(() => setOpen(true), []);
	const handleClose = useCallback(() => setOpen(false), []);

	let src: string;
	try {
		src = convertFileSrc(path);
	} catch {
		src = `asset://localhost${path}`;
	}

	return (
		<>
			<span className="inline-flex items-center gap-1 rounded border border-border/60 text-[12px] transition-colors hover:border-muted-foreground/40 hover:bg-accent/40">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					onClick={handleClick}
					className="h-auto gap-1.5 px-1.5 py-0.5"
				>
					<ImageIcon
						data-icon="inline-start"
						className="size-3 shrink-0 text-chart-3"
						strokeWidth={1.8}
					/>
					<span className="max-w-[200px] truncate text-muted-foreground">
						{fileName}
					</span>
				</Button>
				{onRemove ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						onClick={onRemove}
						className="text-muted-foreground/40 hover:text-muted-foreground"
					>
						<X className="size-3" strokeWidth={1.8} />
					</Button>
				) : null}
			</span>
			{open
				? createPortal(
						<div
							className="fixed inset-0 z-[200] flex items-center justify-center bg-black/35 backdrop-blur-sm"
							onClick={handleClose}
						>
							<div
								className="relative max-h-[85vh] max-w-[85vw] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
								onClick={(e) => e.stopPropagation()}
							>
								<div className="flex items-center justify-between border-b border-border/30 px-3 py-2">
									<span className="text-[12px] text-muted-foreground">
										{fileName}
									</span>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										onClick={handleClose}
										className="size-5 text-muted-foreground hover:text-foreground"
									>
										<X className="size-3.5" strokeWidth={1.8} />
									</Button>
								</div>
								<div className="overflow-auto p-2">
									<img
										src={src}
										alt={fileName}
										className="max-h-[75vh] max-w-full rounded object-contain"
									/>
								</div>
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
