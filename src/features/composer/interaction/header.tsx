import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useLocalizedNode } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Shared header for interaction panels (permission approval, deferred tool,
 * elicitation form / url / unsupported).
 *
 *   Row 1 — icon + title + optional trailing (badges, chevrons)
 *   Row 2 — optional description, flush-left under the icon
 *
 * The icon is rendered as an inline lucide glyph (size-4, muted) with no
 * background container, matching the shadcn CardHeader pattern.
 */
type InteractionHeaderProps = {
	icon: LucideIcon;
	title: ReactNode;
	description?: ReactNode;
	/** Right-aligned siblings: badges, chevron nav, etc. */
	trailing?: ReactNode;
	/**
	 * When true (single-word titles like a tool name), clip overflow with an
	 * ellipsis. When false (long sentences like a question), let the title
	 * wrap naturally.
	 */
	truncateTitle?: boolean;
	className?: string;
};

export function InteractionHeader({
	icon: Icon,
	title,
	description,
	trailing,
	truncateTitle = false,
	className,
}: InteractionHeaderProps) {
	const localizedTitle = useLocalizedNode(title);
	const localizedDescription = useLocalizedNode(description);
	return (
		<div className={cn("space-y-1 px-1 pb-3", className)}>
			<div className="flex items-center gap-2">
				<Icon
					className="size-4 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
					aria-hidden="true"
				/>
				<h3
					className={cn(
						"min-w-0 flex-1 text-body font-semibold leading-snug text-foreground",
						truncateTitle && "truncate",
					)}
				>
					{localizedTitle}
				</h3>
				{trailing}
			</div>
			{description ? (
				<p className="pl-6 text-small text-muted-foreground">
					{localizedDescription}
				</p>
			) : null}
		</div>
	);
}
