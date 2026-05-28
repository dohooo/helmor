/** Queue overlay that sits above the composer without reserving layout space. */

import { Clock, CornerDownLeft, Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { ActionRow } from "@/components/action-row";
import { FileMentionBadge } from "@/components/file-mention-badge";
import { Button } from "@/components/ui/button";
import {
	isFileMentionPart,
	isTextPart,
} from "@/features/panel/message-components/shared";
import type { QueuedSubmit } from "@/lib/use-submit-queue";
import { cn } from "@/lib/utils";
import { splitTextWithFiles } from "@/lib/workspace-helpers";

export type SubmitQueueListProps = {
	items: readonly QueuedSubmit[];
	onSteer: (id: string) => void;
	onRemove: (id: string) => void;
	onEdit?: (id: string) => void;
	disabled?: boolean;
};

export function SubmitQueueList({
	items,
	onSteer,
	onRemove,
	onEdit,
	disabled,
}: SubmitQueueListProps) {
	if (items.length === 0) return null;
	return (
		<div
			data-testid="submit-queue-list"
			className="pointer-events-auto relative z-0 mx-auto w-[90%] overflow-hidden rounded-t-2xl border border-b-0 border-secondary/80 bg-background"
		>
			{items.map((item, idx) => (
				<QueueRow
					key={item.id}
					item={item}
					isLast={idx === items.length - 1}
					onSteer={() => onSteer(item.id)}
					onRemove={() => onRemove(item.id)}
					onEdit={onEdit ? () => onEdit(item.id) : undefined}
					disabled={disabled}
				/>
			))}
		</div>
	);
}

function QueueRow({
	item,
	isLast,
	onSteer,
	onRemove,
	onEdit,
	disabled,
}: {
	item: QueuedSubmit;
	isLast: boolean;
	onSteer: () => void;
	onRemove: () => void;
	onEdit?: () => void;
	disabled?: boolean;
}) {
	const { prompt, imagePaths, filePaths } = item.payload;
	// Reuse the chat-bubble splitter so attachment chips render the
	// same way here as in the sent message.
	const parts = useMemo(
		() => splitTextWithFiles(prompt.trim(), filePaths, item.id, imagePaths),
		[prompt, filePaths, imagePaths, item.id],
	);

	return (
		<ActionRow
			className={cn(
				"border-0 bg-transparent px-3 py-1 pb-0.5 pt-0.5",
				!isLast && "border-b border-b-border/30",
			)}
			leading={
				<>
					<Clock
						className="size-3.5 shrink-0 text-muted-foreground/70"
						strokeWidth={1.8}
						aria-hidden
					/>
					<div className="flex min-w-0 items-center gap-0 overflow-hidden whitespace-nowrap text-small font-medium tracking-[0.01em] text-foreground">
						{parts.map((part, idx) => {
							if (isTextPart(part)) {
								return (
									<span key={part.id ?? idx} className="shrink-0">
										{part.text}
									</span>
								);
							}
							if (isFileMentionPart(part)) {
								return (
									<FileMentionBadge
										key={part.id ?? idx}
										path={part.path}
										compact
										className="shrink-0"
									/>
								);
							}
							return null;
						})}
					</div>
				</>
			}
			trailing={
				<>
					<div className="flex items-center gap-0.5">
						{onEdit ? (
							<Button
								type="button"
								aria-label="Edit in composer"
								variant="ghost"
								size="sm"
								disabled={disabled}
								onClick={onEdit}
								className="h-7 gap-1 rounded-md px-2 text-small font-medium text-muted-foreground hover:text-foreground"
							>
								<Pencil className="size-[13px] shrink-0" strokeWidth={1.8} />
								<span>Edit</span>
							</Button>
						) : null}
						<Button
							type="button"
							aria-label="Steer now"
							variant="ghost"
							size="sm"
							disabled={disabled}
							onClick={onSteer}
							className="h-7 gap-1 rounded-md px-2 text-small font-medium text-muted-foreground hover:text-foreground"
						>
							<CornerDownLeft
								className="size-[13px] shrink-0"
								strokeWidth={1.8}
							/>
							<span>Steer</span>
						</Button>
					</div>
					<Button
						type="button"
						aria-label="Remove from queue"
						variant="ghost"
						size="icon-xs"
						disabled={disabled}
						onClick={onRemove}
						className="size-7 rounded-md text-muted-foreground hover:text-destructive"
					>
						<Trash2 className="size-3.5" strokeWidth={1.8} />
					</Button>
				</>
			}
		/>
	);
}
