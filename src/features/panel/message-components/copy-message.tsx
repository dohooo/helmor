import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	FileMentionPart,
	MessagePart,
	PlanReviewPart,
	PromptSuggestionPart,
	SystemNoticePart,
	TextPart,
	ThreadMessageLike,
	TodoListPart,
} from "@/lib/api";

function serializeTextPart(part: TextPart): string | null {
	const text = part.text.trim();
	return text.length > 0 ? text : null;
}

function serializeTodoListPart(part: TodoListPart): string | null {
	if (part.items.length === 0) {
		return null;
	}
	return part.items
		.map((item) => {
			const marker =
				item.status === "completed"
					? "[x]"
					: item.status === "in_progress"
						? "[~]"
						: "[ ]";
			return `- ${marker} ${item.text}`;
		})
		.join("\n");
}

function serializePlanReviewPart(part: PlanReviewPart): string | null {
	const sections: string[] = [];
	const planPath = part.planFilePath?.trim();
	const plan = part.plan?.trim();
	if (planPath) {
		sections.push(planPath);
	}
	if (plan) {
		sections.push(plan);
	}
	if ((part.allowedPrompts?.length ?? 0) > 0) {
		sections.push(
			part
				.allowedPrompts!.map((entry) => `${entry.tool}\n${entry.prompt}`)
				.join("\n\n"),
		);
	}
	return sections.length > 0 ? sections.join("\n\n") : null;
}

function serializeSystemNoticePart(part: SystemNoticePart): string | null {
	const label = part.label.trim();
	const body = part.body?.trim();
	if (!label) {
		return body || null;
	}
	return body ? `${label}: ${body}` : label;
}

function serializePromptSuggestionPart(
	part: PromptSuggestionPart,
): string | null {
	const text = part.text.trim();
	return text.length > 0 ? text : null;
}

function serializeFileMentionPart(part: FileMentionPart): string | null {
	const path = part.path.trim();
	return path.length > 0 ? `@${path}` : null;
}

function serializeMessagePart(
	part: MessagePart | CollapsedGroupPart,
): string | null {
	switch (part.type) {
		case "text":
			return serializeTextPart(part);
		case "todo-list":
			return serializeTodoListPart(part);
		case "plan-review":
			return serializePlanReviewPart(part);
		case "system-notice":
			return serializeSystemNoticePart(part);
		case "prompt-suggestion":
			return serializePromptSuggestionPart(part);
		case "file-mention":
			return serializeFileMentionPart(part);
		case "reasoning":
		case "tool-call":
		case "collapsed-group":
		case "image":
			return null;
		default:
			return null;
	}
}

export function serializeMessageForClipboard(
	message: Pick<ThreadMessageLike, "content">,
): string {
	return (message.content as ExtendedMessagePart[])
		.map((part) => serializeMessagePart(part))
		.filter((segment): segment is string => Boolean(segment))
		.join("\n\n");
}

export function CopyMessageButton({
	message,
	className,
	ariaLabel = "Copy message",
}: {
	message: Pick<ThreadMessageLike, "content">;
	className?: string;
	ariaLabel?: string;
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = useCallback(() => {
		const text = serializeMessageForClipboard(message);
		if (!text || !navigator.clipboard?.writeText) {
			return;
		}
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, [message]);

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			aria-label={ariaLabel}
			onClick={handleCopy}
			className={`transition-none ${className ?? ""}`}
		>
			{copied ? (
				<Check className="size-3" strokeWidth={2} />
			) : (
				<Copy className="size-3" strokeWidth={1.8} />
			)}
		</Button>
	);
}
