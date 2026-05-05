/**
 * Reusable inline chip for an `@<path>` mention. Picks image vs file
 * preview by extension. Used by chat bubbles and the submit queue so
 * both surfaces render attachments the same way the composer does.
 */

import { FileText, ImageIcon } from "lucide-react";
import { useMemo } from "react";
import {
	createFilePreviewLoader,
	InlineBadge,
} from "@/components/inline-badge";
import { basename, isImageExtensionPath } from "@/lib/path-util";
import { cn } from "@/lib/utils";

export type FileMentionBadgeProps = {
	path: string;
	/** Compact: 12px label / tighter padding. Defaults to false (14px). */
	compact?: boolean;
	className?: string;
};

export function FileMentionBadge({
	path,
	compact = false,
	className,
}: FileMentionBadgeProps) {
	const fileName = basename(path);
	const isImage = isImageExtensionPath(path);
	const filePreviewLoader = useMemo(
		() => (isImage ? undefined : createFilePreviewLoader(path)),
		[isImage, path],
	);

	const wrapperClass = cn(compact && "text-[12px]", className);
	const labelClass = compact ? "text-[12px]" : undefined;

	if (isImage) {
		return (
			<InlineBadge
				nonSelectable={false}
				className={wrapperClass}
				labelClassName={labelClass}
				icon={
					<ImageIcon
						className="size-3.5 shrink-0 text-chart-3"
						strokeWidth={1.8}
					/>
				}
				label={fileName}
				preview={{ kind: "image", title: fileName, path }}
			/>
		);
	}

	return (
		<InlineBadge
			nonSelectable={false}
			className={wrapperClass}
			labelClassName={labelClass}
			icon={
				<FileText
					className="size-3.5 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
			}
			label={fileName}
			previewLoader={filePreviewLoader}
		/>
	);
}
