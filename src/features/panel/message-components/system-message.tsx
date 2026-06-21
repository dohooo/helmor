import { formatDistanceToNow } from "date-fns";
import {
	AlertCircle,
	AlertTriangle,
	Goal,
	Info,
	MessageSquareText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	MessagePart,
	PromptSuggestionPart,
	SystemNoticePart,
} from "@/lib/api";
import { I18nText } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CopyMessageButton } from "./copy-message";
import type { RenderedMessage } from "./shared";
import {
	isPromptSuggestionPart,
	isSystemNoticePart,
	isTextPart,
} from "./shared";

// --- sub-components ---

export function SystemNotice({
	part,
	wrap = false,
}: {
	part: SystemNoticePart;
	wrap?: boolean;
}) {
	const Icon =
		part.severity === "error"
			? AlertCircle
			: part.severity === "warning"
				? AlertTriangle
				: Info;
	const iconClass =
		part.severity === "error"
			? "text-destructive"
			: part.severity === "warning"
				? "text-chart-5"
				: "text-chart-3";
	return (
		<span
			className={cn(
				"inline-flex min-h-4 gap-1",
				wrap
					? "min-w-0 items-start whitespace-normal break-words leading-snug"
					: "items-center whitespace-nowrap leading-none",
			)}
		>
			<Icon
				className={cn("size-3 shrink-0", iconClass, wrap ? "mt-0.5" : null)}
				strokeWidth={1.8}
			/>
			<span className={wrap ? "shrink-0 whitespace-nowrap" : undefined}>
				{part.label}
			</span>
			{part.body ? (
				<span
					className={cn(
						"ml-1 text-muted-foreground/70",
						wrap
							? "min-w-0 flex-1 whitespace-pre-wrap break-words"
							: "truncate",
					)}
				>
					- {part.body}
				</span>
			) : null}
		</span>
	);
}

function PromptSuggestion({ part }: { part: PromptSuggestionPart }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="xs"
					className="my-1 h-auto rounded-md border-border/60 bg-accent/35 px-2 py-1 text-mini text-muted-foreground hover:bg-accent/60"
					onClick={() => {
						const composer = document.querySelector<HTMLTextAreaElement>(
							"textarea[data-composer-input]",
						);
						if (composer) {
							composer.value = part.text;
							composer.dispatchEvent(new Event("input", { bubbles: true }));
							composer.focus();
						}
					}}
				>
					<MessageSquareText
						data-icon="inline-start"
						className="size-3"
						strokeWidth={1.8}
					/>
					<span className="max-w-[420px] truncate">{part.text}</span>
				</Button>
			</TooltipTrigger>
			<TooltipContent
				sideOffset={4}
				className="flex h-[22px] items-center rounded-md px-1.5 text-mini leading-none"
			>
				<span>
					<I18nText source="usePrompt" />
				</span>
			</TooltipContent>
		</Tooltip>
	);
}

function SystemText({ text }: { text: string }) {
	if (text.startsWith("Error:")) {
		return (
			<span className="inline-flex items-center gap-1 text-destructive">
				<AlertCircle className="size-3 shrink-0" strokeWidth={1.8} />
				{text.slice(7)}
			</span>
		);
	}
	// Codex `/goal` lifecycle markers — narrated by
	// `agents::streaming::codex_goal::goal_transition_label` on the
	// backend ("Goal set" / "Goal paused" / etc.). Prefix-detect them
	// here so they share an icon, same shape as the Error case above.
	if (text.startsWith("Goal ")) {
		return (
			<span className="inline-flex items-center gap-1">
				<Goal className="size-3 shrink-0" strokeWidth={1.8} />
				{text}
			</span>
		);
	}
	return <span>{text}</span>;
}

// --- ChatSystemMessage ---

function MessageTimestamp({ createdAt }: { createdAt?: string }) {
	if (!createdAt) return null;
	const date = new Date(createdAt);
	if (Number.isNaN(date.getTime())) return null;
	return (
		<>
			<span className="inline-flex h-4 items-center text-mini leading-none text-muted-foreground/60">
				•
			</span>
			<span className="inline-flex h-4 shrink-0 items-center text-mini leading-none tabular-nums text-muted-foreground">
				{formatDistanceToNow(date, { addSuffix: true })}
			</span>
		</>
	);
}

// Only the turn-end row (Claude `result` / Codex `turn.completed`) gets a
// timestamp — the adapter tags its text part id with `:turn-result`.
function shouldShowTimestamp(parts: MessagePart[]) {
	return parts.some(
		(part) => isTextPart(part) && part.id.endsWith(":turn-result"),
	);
}

export function ChatSystemMessage({
	message,
	previousAssistantMessage,
}: {
	message: RenderedMessage;
	previousAssistantMessage?: RenderedMessage | null;
}) {
	const parts = message.content as MessagePart[];
	const copyTarget =
		previousAssistantMessage?.role === "assistant"
			? previousAssistantMessage
			: message;

	return (
		<div
			data-message-id={message.id}
			data-message-role="system"
			className="group/sys flex min-w-0 items-center gap-1.5"
		>
			<div className="flex min-w-0 items-center gap-1.5 py-1 text-mini leading-none text-muted-foreground">
				{parts.map((part, index) => {
					if (isSystemNoticePart(part)) {
						return <SystemNotice key={index} part={part} />;
					}
					if (isPromptSuggestionPart(part)) {
						return <PromptSuggestion key={index} part={part} />;
					}
					if (isTextPart(part)) {
						return <SystemText key={index} text={part.text} />;
					}
					return null;
				})}
				{shouldShowTimestamp(parts) ? (
					<MessageTimestamp createdAt={message.createdAt} />
				) : null}
			</div>
			<CopyMessageButton
				message={copyTarget}
				className="size-5 shrink-0 text-muted-foreground/30 opacity-0 hover:text-muted-foreground group-hover/sys:opacity-100"
			/>
		</div>
	);
}
