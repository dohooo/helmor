import { memo, useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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

export const WorkspaceAvatar = memo(function WorkspaceAvatar({
	repoIconSrc,
	repoInitials,
	repoName,
	title,
	className,
	fallbackClassName,
}: {
	repoIconSrc?: string | null;
	repoInitials?: string | null;
	repoName?: string | null;
	title: string;
	className?: string;
	fallbackClassName?: string;
}) {
	const fallback = (
		repoInitials?.trim() || initialsFromLabel(repoName || title)
	)
		.slice(0, 2)
		.toUpperCase();
	const src = getWorkspaceAvatarSrc(repoIconSrc);
	const [hasImage, setHasImage] = useState(Boolean(src));

	useEffect(() => {
		setHasImage(Boolean(src));
	}, [src]);

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
			{src ? (
				<AvatarImage
					src={src}
					alt={`${repoName ?? title} icon`}
					onError={() => {
						setHasImage(false);
					}}
					onLoad={() => {
						setHasImage(true);
					}}
				/>
			) : null}
			{!hasImage ? (
				<AvatarFallback
					delayMs={0}
					className={cn(
						"bg-muted text-[7px] font-semibold uppercase tracking-[0.02em] text-muted-foreground",
						fallbackClassName,
					)}
				>
					{fallback}
				</AvatarFallback>
			) : null}
		</Avatar>
	);
});
