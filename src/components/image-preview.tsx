import { convertFileSrc } from "@tauri-apps/api/core";
import { ImageIcon, X } from "lucide-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";

/** Extract image file paths from text. Handles paths with spaces. */
export function extractImagePaths(text: string): string[] {
	const paths: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (
			trimmed.startsWith("/") &&
			/\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(trimmed)
		) {
			paths.push(trimmed);
		}
	}
	return [...new Set(paths)];
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
	const fileName = path.split("/").pop() ?? path;

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
			<span className="inline-flex items-center gap-1 rounded border border-app-border/60 text-[12px] transition-colors hover:border-app-foreground-soft/40 hover:bg-app-foreground/[0.03]">
				<button
					type="button"
					onClick={handleClick}
					className="inline-flex items-center gap-1.5 px-1.5 py-0.5"
				>
					<ImageIcon
						className="size-3 shrink-0 text-app-project"
						strokeWidth={1.8}
					/>
					<span className="max-w-[200px] truncate text-app-foreground-soft">
						{fileName}
					</span>
				</button>
				{onRemove ? (
					<button
						type="button"
						onClick={onRemove}
						className="px-1 py-0.5 text-app-muted/40 hover:text-app-muted"
					>
						<X className="size-3" strokeWidth={1.8} />
					</button>
				) : null}
			</span>
			{open
				? createPortal(
						<div
							className="fixed inset-0 z-[200] flex items-center justify-center bg-app-overlay backdrop-blur-sm"
							onClick={handleClose}
						>
							<div
								className="relative max-h-[85vh] max-w-[85vw] overflow-hidden rounded-xl border border-app-border bg-app-tooltip shadow-2xl"
								onClick={(e) => e.stopPropagation()}
							>
								<div className="flex items-center justify-between border-b border-app-border/30 px-3 py-2">
									<span className="text-[12px] text-app-muted">{fileName}</span>
									<button
										type="button"
										onClick={handleClose}
										className="flex size-5 items-center justify-center rounded text-app-muted hover:text-app-foreground"
									>
										<X className="size-3.5" strokeWidth={1.8} />
									</button>
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
