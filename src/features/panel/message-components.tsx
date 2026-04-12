import {
	AlertCircle,
	AlertTriangle,
	Bot,
	Check,
	ChevronDown,
	Circle,
	CircleDot,
	ClipboardList,
	Clock3,
	Copy,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	Info,
	LoaderCircle,
	MessageSquareMore,
	MessageSquareText,
	Pencil,
	Plug,
	Search,
	SquareTerminal,
} from "lucide-react";
import {
	lazy,
	memo,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai/reasoning";
import { ImagePreviewBadge } from "@/components/image-preview";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
	CollapsedGroupPart,
	ExtendedMessagePart,
	FileMentionPart,
	ImagePart,
	MessagePart,
	PlanReviewPart,
	PromptSuggestionPart,
	SystemNoticePart,
	ThreadMessageLike,
	TodoListPart,
	ToolCallPart,
} from "@/lib/api";
import { recordMessageRender } from "@/lib/dev-render-debug";
import { useSettings } from "@/lib/settings";
import { childrenStructurallyEqual } from "@/lib/structural-equality";
import { cn } from "@/lib/utils";

type RenderedMessage = ThreadMessageLike;
type StreamdownMode = "static" | "streaming";

const LazyStreamdown = lazy(async () => {
	const [{ Streamdown }, { streamdownComponents }] = await Promise.all([
		import("streamdown"),
		import("@/components/streamdown-components"),
	]);

	function StreamdownWithOverrides(
		props: React.ComponentProps<typeof Streamdown>,
	) {
		return (
			<Streamdown
				{...props}
				components={{ ...streamdownComponents, ...props.components }}
			/>
		);
	}

	return { default: StreamdownWithOverrides };
});

let hasPreloadedStreamdown = false;

export function preloadStreamdown() {
	if (hasPreloadedStreamdown) {
		return;
	}
	hasPreloadedStreamdown = true;
	void import("streamdown");
	void import("@/components/streamdown-components");
}

function isLiveStreamingStatus(status: string | undefined): boolean {
	return (
		status === "pending" || status === "streaming_input" || status === "running"
	);
}

function ConversationMessage({
	message,
	sessionId,
	itemIndex,
}: {
	message: RenderedMessage;
	sessionId: string;
	itemIndex: number;
}) {
	const messageKey = message.id ?? `${message.role}:${itemIndex}`;
	useEffect(() => {
		recordMessageRender(sessionId, messageKey);
	});

	const streaming = message.role === "assistant" && message.streaming === true;

	if (message.role === "user") {
		return <ChatUserMessage message={message} />;
	}

	if (message.role === "assistant") {
		return <ChatAssistantMessage message={message} streaming={streaming} />;
	}

	return <ChatSystemMessage message={message} />;
}

export const MemoConversationMessage = memo(
	ConversationMessage,
	(prev, next) => {
		return (
			prev.message === next.message &&
			prev.sessionId === next.sessionId &&
			prev.itemIndex === next.itemIndex
		);
	},
);

function ChatUserMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];
	const { settings } = useSettings();

	return (
		<div
			data-message-id={message.id}
			data-message-role="user"
			className="flex min-w-0 justify-end"
		>
			<div
				className="max-w-[75%] overflow-hidden rounded-md bg-accent/35 px-3 py-2 leading-7 text-foreground"
				style={{ fontSize: `${Math.max(settings.fontSize - 1, 12)}px` }}
			>
				<p className="whitespace-pre-wrap break-words">
					{parts.map((part, index) => {
						if (isTextPart(part)) {
							return <UserTextInline key={index} text={part.text} />;
						}
						if (isFileMentionPart(part)) {
							return <FileBadgeInline key={index} path={part.path} />;
						}
						return null;
					})}
				</p>
			</div>
		</div>
	);
}

function ChatAssistantMessage({
	message,
	streaming,
}: {
	message: RenderedMessage;
	streaming: boolean;
}) {
	const parts = message.content as ExtendedMessagePart[];
	const { settings } = useSettings();

	return (
		<div
			data-message-id={message.id}
			data-message-role="assistant"
			className="flex min-w-0 max-w-full flex-col gap-1"
		>
			{parts.map((part, index) => {
				if (isTextPart(part)) {
					return (
						<AssistantText
							key={`text:${index}`}
							text={part.text}
							streaming={streaming}
						/>
					);
				}
				if (isReasoningPart(part)) {
					return (
						<Reasoning
							key={`reasoning:${index}`}
							isStreaming={part.streaming === true}
						>
							<ReasoningTrigger />
							<ReasoningContent fontSize={settings.fontSize}>
								{part.text}
							</ReasoningContent>
						</Reasoning>
					);
				}
				if (isCollapsedGroupPart(part)) {
					return (
						<CollapsedToolGroup
							key={`group-${part.tools[0]?.toolCallId ?? index}`}
							group={part}
						/>
					);
				}
				if (isToolCallPart(part)) {
					return (
						<AssistantToolCall
							key={`tc:${part.toolCallId ?? `${part.toolName}:${index}`}`}
							toolName={part.toolName}
							args={part.args}
							result={part.result}
							isError={
								part.toolName === "ExitPlanMode"
									? false
									: (part as ToolCallPart).isError
							}
							streamingStatus={(part as ToolCallPart).streamingStatus}
							childParts={(part as ToolCallPart).children}
						/>
					);
				}
				if (isTodoListPart(part)) {
					return <TodoList key={`todo:${index}`} part={part} />;
				}
				if (isImagePart(part)) {
					return <ImageBlock key={`img:${index}`} part={part} />;
				}
				if (isPlanReviewPart(part)) {
					return (
						<PlanReviewCard
							key={`plan-review:${part.toolUseId}:${index}`}
							part={part}
						/>
					);
				}
				return null;
			})}
			{!streaming && message.status?.type === "incomplete" ? (
				<MessageStatusBadge reason={message.status.reason} />
			) : null}
		</div>
	);
}

function MessageStatusBadge({ reason }: { reason?: string }) {
	if (!reason) {
		return null;
	}
	const meta = statusBadgeMeta(reason);
	if (!meta) {
		return null;
	}
	return (
		<div
			className={cn(
				"mt-1 inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
				meta.tone,
			)}
		>
			{meta.icon}
			<span>{meta.label}</span>
		</div>
	);
}

function statusBadgeMeta(
	reason: string,
): { label: string; tone: string; icon: React.ReactNode } | null {
	const negativeTone = "bg-destructive/10 text-destructive";
	const warmTone = "bg-chart-5/10 text-chart-5";
	switch (reason) {
		case "max_tokens":
			return {
				label: "Output truncated",
				tone: warmTone,
				icon: <AlertTriangle className="size-3" strokeWidth={1.8} />,
			};
		case "context_window_exceeded":
			return {
				label: "Context window exceeded",
				tone: negativeTone,
				icon: <AlertCircle className="size-3" strokeWidth={1.8} />,
			};
		case "refusal":
			return {
				label: "Model declined",
				tone: warmTone,
				icon: <Info className="size-3" strokeWidth={1.8} />,
			};
		case "pause_turn":
			return {
				label: "Paused",
				tone: warmTone,
				icon: <Clock3 className="size-3" strokeWidth={1.8} />,
			};
		default:
			return {
				label: reason,
				tone: negativeTone,
				icon: <AlertCircle className="size-3" strokeWidth={1.8} />,
			};
	}
}

function ChatSystemMessage({ message }: { message: RenderedMessage }) {
	const parts = message.content as MessagePart[];

	return (
		<div
			data-message-id={message.id}
			data-message-role="system"
			className="group/sys flex min-w-0 items-center gap-1.5"
		>
			<div className="py-1 text-[11px] text-muted-foreground">
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
			</div>
			<CopyMessageButton />
		</div>
	);
}

function SystemNotice({ part }: { part: SystemNoticePart }) {
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
		<span className="inline-flex items-center gap-1">
			<Icon className={cn("size-3 shrink-0", iconClass)} strokeWidth={1.8} />
			<span>{part.label}</span>
			{part.body ? (
				<span className="ml-1 text-muted-foreground/70">- {part.body}</span>
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
					className="my-1 h-auto rounded-md border-border/60 bg-accent/35 px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/60"
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
				sideOffset={8}
				className="flex h-[22px] items-center rounded-md px-1.5 text-[11px] leading-none"
			>
				<span>Use this prompt</span>
			</TooltipContent>
		</Tooltip>
	);
}

function ImageBlock({ part }: { part: ImagePart }) {
	const src =
		part.source.kind === "url"
			? part.source.url
			: `data:${part.mediaType ?? "image/png"};base64,${part.source.data}`;
	return (
		<img
			src={src}
			alt=""
			className="my-2 max-h-[420px] max-w-full rounded-md border border-border/40"
		/>
	);
}

function TodoList({ part }: { part: TodoListPart }) {
	if (part.items.length === 0) {
		return null;
	}
	const completed = part.items.filter(
		(item) => item.status === "completed",
	).length;
	const total = part.items.length;
	return (
		<div className="my-1 flex flex-col gap-0.5 rounded-md border border-border/40 bg-accent/35 px-3 py-2 text-[13px] leading-6 text-muted-foreground">
			<div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<MessageSquareText className="size-3" strokeWidth={1.8} />
				<span>
					Plan - {completed}/{total} done
				</span>
			</div>
			{part.items.map((todo, index) => {
				const Icon =
					todo.status === "completed"
						? Check
						: todo.status === "in_progress"
							? CircleDot
							: Circle;
				const iconClass =
					todo.status === "completed"
						? "text-chart-2"
						: todo.status === "in_progress"
							? "text-chart-2"
							: "text-muted-foreground/60";
				const textClass =
					todo.status === "completed"
						? "text-muted-foreground line-through"
						: "text-muted-foreground";
				return (
					<div key={index} className="flex items-center gap-1.5">
						<Icon
							className={cn("size-3 shrink-0", iconClass)}
							strokeWidth={1.8}
						/>
						<span className={textClass}>{todo.text}</span>
					</div>
				);
			})}
		</div>
	);
}

function PlanReviewCard({ part }: { part: PlanReviewPart }) {
	return (
		<div className="rounded-xl border-[1.5px] border-border/70 bg-background/60 px-3.5 py-3">
			<div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
				<ClipboardList className="size-3.5" strokeWidth={1.8} />
				Plan
			</div>
			{part.planFilePath ? (
				<p className="mt-2 break-words text-[12px] leading-5 text-muted-foreground">
					{part.planFilePath}
				</p>
			) : null}
			<pre className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground">
				{part.plan?.trim() || "No plan content."}
			</pre>
			{(part.allowedPrompts ?? []).length > 0 ? (
				<div className="mt-3 grid gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
					<p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
						Approved Prompts
					</p>
					{part.allowedPrompts?.map((entry) => (
						<div
							key={`${entry.tool}:${entry.prompt}`}
							className="rounded-md border border-border/50 bg-background/70 px-2 py-1.5"
						>
							<p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
								{entry.tool}
							</p>
							<p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground">
								{entry.prompt}
							</p>
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

const USER_FILE_RE = /@(\/\S+)(?=\s|$)/gi;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|ico)$/i;

type UserContentSegment =
	| { type: "text"; value: string }
	| { type: "image"; value: string }
	| { type: "file"; value: string };

function splitUserContent(text: string): UserContentSegment[] {
	const segments: UserContentSegment[] = [];
	let lastIndex = 0;
	for (const match of text.matchAll(USER_FILE_RE)) {
		const matchIndex = match.index ?? 0;
		const before = text.slice(lastIndex, matchIndex);
		if (before) {
			segments.push({ type: "text", value: before });
		}
		const filePath = match[1];
		segments.push({
			type: IMAGE_EXT_RE.test(filePath) ? "image" : "file",
			value: filePath,
		});
		lastIndex = matchIndex + match[0].length;
	}
	const after = text.slice(lastIndex);
	if (after) {
		segments.push({ type: "text", value: after });
	}
	return segments;
}

const UserTextInline = memo(function UserTextInline({
	text,
}: {
	text: string;
}) {
	const segments = useMemo(() => splitUserContent(text), [text]);
	if (
		!segments.some(
			(segment) => segment.type === "image" || segment.type === "file",
		)
	) {
		return <>{text}</>;
	}
	return (
		<>
			{segments.map((segment, index) => {
				if (segment.type === "image") {
					return (
						<ImagePreviewBadge
							key={`${segment.value}-${index}`}
							path={segment.value}
						/>
					);
				}
				if (segment.type === "file") {
					return (
						<FileBadgeInline
							key={`${segment.value}-${index}`}
							path={segment.value}
						/>
					);
				}
				return <span key={index}>{segment.value}</span>;
			})}
		</>
	);
});

function FileBadgeInline({ path }: { path: string }) {
	const fileName = path.split("/").pop() ?? path;
	return (
		<span className="mx-0.5 inline-flex items-center gap-1 rounded border border-border/60 align-middle text-[12px]">
			<span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
				<FileText
					className="size-3 shrink-0 text-muted-foreground"
					strokeWidth={1.8}
				/>
				<span className="max-w-[200px] truncate text-muted-foreground">
					{fileName}
				</span>
			</span>
		</span>
	);
}

const STREAMING_ANIMATED = {
	animation: "blurIn" as const,
	duration: 150,
	easing: "linear" as const,
	sep: "word" as const,
	stagger: 30,
};

const AssistantText = memo(function AssistantText({
	text,
	streaming,
}: {
	text: string;
	streaming: boolean;
}) {
	const mode: StreamdownMode = streaming ? "streaming" : "static";
	const { settings } = useSettings();

	return (
		<div
			className="conversation-markdown assistant-markdown-scale max-w-none break-words text-foreground"
			style={{ fontSize: `${Math.max(settings.fontSize - 1, 12)}px` }}
		>
			<Suspense
				fallback={<AssistantTextFallback text={text} streaming={streaming} />}
			>
				<LazyStreamdown
					animated={streaming ? STREAMING_ANIMATED : false}
					caret={undefined}
					className="conversation-streamdown"
					isAnimating={streaming}
					mode={mode}
				>
					{text}
				</LazyStreamdown>
			</Suspense>
		</div>
	);
});

function AssistantTextFallback({
	text,
}: {
	text: string;
	streaming?: boolean;
}) {
	return (
		<div className="conversation-streamdown whitespace-pre-wrap break-words">
			{text}
		</div>
	);
}

type AssistantToolCallProps = {
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	isError?: boolean;
	streamingStatus?: string;
	compact?: boolean;
	childParts?: ExtendedMessagePart[];
};

export function assistantToolCallPropsEqual(
	prev: AssistantToolCallProps,
	next: AssistantToolCallProps,
): boolean {
	return (
		prev.toolName === next.toolName &&
		prev.streamingStatus === next.streamingStatus &&
		prev.result === next.result &&
		prev.isError === next.isError &&
		prev.compact === next.compact &&
		childrenStructurallyEqual(prev.childParts, next.childParts) &&
		shallowArgsEqual(prev.args, next.args)
	);
}

export const AssistantToolCall = memo(function AssistantToolCall({
	toolName,
	args,
	result,
	isError,
	streamingStatus,
	compact = false,
	childParts,
}: AssistantToolCallProps) {
	const info = getToolInfo(toolName, args);
	const isEdit = toolName === "Edit";
	const oldStr =
		isEdit && typeof args.old_string === "string" ? args.old_string : null;
	const newStr =
		isEdit && typeof args.new_string === "string" ? args.new_string : null;
	const hasDiff = oldStr != null || newStr != null;

	const resultStr = useMemo(
		() =>
			result != null
				? typeof result === "string"
					? result
					: JSON.stringify(result, null, 2)
				: null,
		[result],
	);
	const hasChildren = (childParts?.length ?? 0) > 0;
	const resultText = hasChildren ? null : (info.body ?? resultStr);
	const hasOutput = resultText != null && resultText.length > 5;
	const isLiveTool = isLiveStreamingStatus(streamingStatus);
	const [isOpen, setIsOpen] = useState(isLiveTool);
	useEffect(() => {
		if (!isLiveTool) setIsOpen(false);
	}, [isLiveTool]);

	const statusIndicator = isLiveTool ? (
		<LoaderCircle
			className="size-3 animate-spin text-muted-foreground/50"
			strokeWidth={2}
		/>
	) : streamingStatus === "error" ? (
		<AlertCircle className="size-3 text-destructive" strokeWidth={2} />
	) : null;

	const toolLine = (
		<>
			<span className="shrink-0">{info.icon}</span>
			<span className="shrink-0 whitespace-nowrap font-medium">
				{info.action}
			</span>
			{info.file ? (
				hasDiff ? (
					<EditDiffTrigger
						file={info.file}
						diffAdd={info.diffAdd}
						diffDel={info.diffDel}
						oldStr={oldStr}
						newStr={newStr}
					/>
				) : (
					<span className="truncate text-muted-foreground">{info.file}</span>
				)
			) : null}
			{!hasDiff && (info.diffAdd != null || info.diffDel != null) ? (
				<span className="flex items-center gap-1 text-[11px]">
					{info.diffAdd != null ? (
						<span className="text-chart-2">+{info.diffAdd}</span>
					) : null}
					{info.diffDel != null ? (
						<span className="text-destructive">-{info.diffDel}</span>
					) : null}
				</span>
			) : null}
			{info.command ? (
				<code className="inline-block min-w-0 truncate rounded bg-accent/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
					{info.command}
				</code>
			) : info.detail ? (
				<span className="min-w-0 truncate text-muted-foreground/60">
					{info.detail}
				</span>
			) : null}
			{statusIndicator}
		</>
	);

	if (hasChildren && childParts) {
		return (
			<AgentChildrenBlock
				toolName={toolName}
				toolArgs={args}
				streamingStatus={streamingStatus}
				isRunning={result == null}
				parts={childParts}
			/>
		);
	}

	if (compact) {
		const detail = info.file ?? info.command ?? info.detail ?? null;
		return (
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground">
				<span className="shrink-0">{info.icon}</span>
				<span className="shrink-0 font-medium">{info.action}</span>
				{detail ? (
					<span className="truncate text-muted-foreground">{detail}</span>
				) : null}
			</div>
		);
	}

	return (
		<>
			<details
				className="group/out flex flex-col"
				onToggle={(event) => {
					setIsOpen(event.currentTarget.open);
				}}
				open={isLiveTool || isOpen}
			>
				<summary
					className={cn(
						"flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground [&::-webkit-details-marker]:hidden",
						hasOutput ? "cursor-pointer" : "cursor-default",
					)}
				>
					{toolLine}
					{hasOutput ? (
						<span className="shrink-0 cursor-pointer text-muted-foreground/40 hover:text-muted-foreground">
							<svg
								className="size-2.5 group-open/out:rotate-90"
								viewBox="0 0 12 12"
								fill="none"
							>
								<path
									d="M4.5 2.5L8.5 6L4.5 9.5"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</span>
					) : null}
				</summary>
				{hasOutput && (isLiveTool || isOpen) ? (
					<div className="max-h-[16rem] overflow-auto rounded-md bg-accent/35 text-[11px] leading-5">
						{info.fullCommand ? (
							<div className="border-b border-border/20 px-2 py-1.5">
								<span className="mr-1.5 text-chart-3/70">$</span>
								<code className="font-mono text-muted-foreground">
									{info.fullCommand}
								</code>
							</div>
						) : null}
						<pre className="whitespace-pre-wrap break-words p-1.5 text-muted-foreground/80">
							{resultText!.slice(0, 2000)}
							{resultText!.length > 2000 ? "…" : ""}
						</pre>
					</div>
				) : null}
			</details>
			{isError === true ? <ToolCallErrorRow result={result} /> : null}
		</>
	);
}, assistantToolCallPropsEqual);

const ToolCallErrorRow = memo(function ToolCallErrorRow({
	result,
}: {
	result: unknown;
}) {
	const error = useMemo(() => extractToolError(result), [result]);
	const [open, setOpen] = useState(false);
	if (!error) {
		return null;
	}
	const { exitCode, preview, full } = error;
	const expandable = full != null;
	return (
		<details
			className="group/err flex flex-col"
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
			}}
			open={open}
		>
			<summary
				className={cn(
					"flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-destructive [&::-webkit-details-marker]:hidden",
					expandable ? "cursor-pointer" : "cursor-default",
				)}
			>
				<AlertCircle className="size-3.5 shrink-0" strokeWidth={1.8} />
				<span className="shrink-0 font-medium">Error</span>
				{exitCode != null ? (
					<code className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[11px]">
						Exit code {exitCode}
					</code>
				) : null}
				{preview ? (
					<span className="min-w-0 truncate font-mono text-[11px] text-destructive/80">
						{preview}
					</span>
				) : null}
				{expandable ? (
					<span className="shrink-0 cursor-pointer text-destructive/40 hover:text-destructive">
						<svg
							className="size-2.5 group-open/err:rotate-90"
							viewBox="0 0 12 12"
							fill="none"
						>
							<path
								d="M4.5 2.5L8.5 6L4.5 9.5"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
				) : null}
			</summary>
			{expandable && open ? (
				<div className="mt-0.5 max-h-[16rem] overflow-auto rounded-md border border-destructive/15 bg-destructive/[0.05] text-[11px] leading-5">
					<pre className="whitespace-pre-wrap break-words p-1.5 text-destructive/80">
						{full!.slice(0, 4000)}
						{full!.length > 4000 ? "…" : ""}
					</pre>
				</div>
			) : null}
		</details>
	);
});

type ToolError = {
	exitCode: number | null;
	preview: string | null;
	full: string | null;
};

const EXIT_CODE_RE = /^Exit code:?\s+(\d+)\s*\n?/;
const TOOL_USE_ERROR_RE = /^<tool_use_error>([\s\S]*)<\/tool_use_error>$/;

function extractToolError(result: unknown): ToolError | null {
	if (typeof result !== "string") {
		return null;
	}
	let body = result.trim();
	if (!body) {
		return null;
	}

	let exitCode: number | null = null;
	const exitMatch = body.match(EXIT_CODE_RE);
	if (exitMatch) {
		const parsed = Number.parseInt(exitMatch[1], 10);
		if (Number.isFinite(parsed) && parsed !== 0) {
			exitCode = parsed;
		}
		body = body.slice(exitMatch[0].length).trim();
	}

	const wrapMatch = body.match(TOOL_USE_ERROR_RE);
	if (wrapMatch) {
		body = wrapMatch[1].trim();
	}

	body = body.replace(/^Error:\s*/i, "").trim();

	if (exitCode == null && !body) {
		return null;
	}
	const preview = body ? previewLine(body) : null;
	return {
		exitCode,
		preview,
		full: body.length > 0 ? body : null,
	};
}

function previewLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) {
			return truncate(trimmed, 120);
		}
	}
	return truncate(text, 120);
}

function shallowArgsEqual(
	a: Record<string, unknown>,
	b: Record<string, unknown>,
): boolean {
	if (a === b) {
		return true;
	}
	const keysA = Object.keys(a);
	const keysB = Object.keys(b);
	if (keysA.length !== keysB.length) {
		return false;
	}
	for (const key of keysA) {
		if (a[key] !== b[key]) {
			return false;
		}
	}
	return true;
}

const AGENT_PREVIEW_STEPS = 3;

type AgentChildrenBlockProps = {
	toolName: string;
	toolArgs: Record<string, unknown>;
	streamingStatus?: string;
	isRunning?: boolean;
	parts: ExtendedMessagePart[];
};

export function agentChildrenBlockPropsEqual(
	prev: AgentChildrenBlockProps,
	next: AgentChildrenBlockProps,
): boolean {
	return (
		prev.toolName === next.toolName &&
		prev.streamingStatus === next.streamingStatus &&
		prev.isRunning === next.isRunning &&
		childrenStructurallyEqual(prev.parts, next.parts) &&
		shallowArgsEqual(prev.toolArgs, next.toolArgs)
	);
}

const AgentChildrenBlock = memo(function AgentChildrenBlock({
	toolName,
	toolArgs,
	streamingStatus,
	isRunning,
	parts,
}: AgentChildrenBlockProps) {
	const [expanded, setExpanded] = useState(false);
	const isLive = isLiveStreamingStatus(streamingStatus);
	const streaming = isLive || (!streamingStatus && !!isRunning);
	const info = getToolInfo(toolName, toolArgs);
	const toolCallParts = useMemo(
		() =>
			parts.filter((part): part is ToolCallPart => part.type === "tool-call"),
		[parts],
	);
	const toolUseCount = toolCallParts.length;
	const visibleParts: ExtendedMessagePart[] = expanded
		? parts
		: toolCallParts.slice(-AGENT_PREVIEW_STEPS);
	const collapsedVisibleCount = Math.min(
		toolCallParts.length,
		AGENT_PREVIEW_STEPS,
	);
	const hiddenCount = parts.length - collapsedVisibleCount;
	const hasMore =
		toolCallParts.length >= AGENT_PREVIEW_STEPS && hiddenCount > 0;
	const canToggle = hasMore && (expanded || !streaming);

	return (
		<div className="flex flex-col">
			<div className="flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground">
				<span className="shrink-0">{info.icon}</span>
				<span className="font-medium">{info.action}</span>
				{info.detail ? (
					<span className="truncate text-muted-foreground/60">
						{info.detail}
					</span>
				) : null}
				{streaming ? (
					<LoaderCircle
						className="size-3 animate-spin text-muted-foreground/50"
						strokeWidth={2}
					/>
				) : null}
				<span className="shrink-0 text-[11px] text-muted-foreground/40">
					{toolUseCount > 0
						? `${toolUseCount} tool ${toolUseCount === 1 ? "use" : "uses"}`
						: `${parts.length} steps`}
				</span>
			</div>

			<div className="ml-5 flex flex-col gap-0.5 border-l border-border/30 pl-3 pt-1">
				{canToggle ? (
					<Button
						type="button"
						variant="ghost"
						size="xs"
						onClick={() => setExpanded((value) => !value)}
						className="mb-0.5 h-auto items-center justify-start gap-1 px-0 text-[11px] text-muted-foreground/50 hover:bg-transparent hover:text-muted-foreground"
					>
						<ChevronDown
							className={cn(
								"size-3 transition-transform",
								expanded && "rotate-180",
							)}
							strokeWidth={1.5}
						/>
						{expanded
							? "Collapse"
							: `Show ${hiddenCount} more step${hiddenCount > 1 ? "s" : ""}`}
					</Button>
				) : null}

				<div className="flex flex-col gap-0.5">
					{visibleParts.map((part, index) => {
						if (isToolCallPart(part)) {
							return (
								<AssistantToolCall
									key={part.toolCallId ?? `tool-${index}`}
									toolName={part.toolName ?? "unknown"}
									args={part.args ?? {}}
									result={part.result}
									isError={part.isError}
									compact={!expanded}
									childParts={part.children}
								/>
							);
						}
						if (part.type === "text" && part.text) {
							return (
								<div
									key={`text-${index}`}
									className="text-[13px] leading-6 text-muted-foreground"
								>
									{part.text.slice(0, 300)}
									{part.text.length > 300 ? "…" : ""}
								</div>
							);
						}
						if (part.type === "reasoning" && part.text) {
							return (
								<Reasoning key={`reason-${index}`}>
									<ReasoningTrigger />
									<ReasoningContent>{part.text}</ReasoningContent>
								</Reasoning>
							);
						}
						if (isTodoListPart(part)) {
							return <TodoList key={`todo-${index}`} part={part} />;
						}
						return null;
					})}
				</div>
			</div>
		</div>
	);
}, agentChildrenBlockPropsEqual);

function CollapsedToolGroup({ group }: { group: CollapsedGroupPart }) {
	const [open, setOpen] = useState(group.active);
	useEffect(() => {
		setOpen(group.active);
	}, [group.active]);
	const collapsedGroupIconClassName = "size-3.5 text-muted-foreground";

	const icon =
		group.category === "search" ? (
			<Search className={collapsedGroupIconClassName} strokeWidth={1.8} />
		) : (
			<FileText className={collapsedGroupIconClassName} strokeWidth={1.8} />
		);

	return (
		<details
			className="group/collapse flex flex-col"
			onToggle={(event) => {
				setOpen(event.currentTarget.open);
			}}
			open={open}
		>
			<summary className="flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground [&::-webkit-details-marker]:hidden">
				<span className="shrink-0">{icon}</span>
				<span className="font-medium">{group.summary}</span>
				{group.active ? (
					<LoaderCircle
						className="size-3 animate-spin text-chart-2"
						strokeWidth={2}
					/>
				) : (
					<Check className="size-3 text-chart-2" strokeWidth={2} />
				)}
				<span className="shrink-0 cursor-pointer text-muted-foreground/40 hover:text-muted-foreground">
					<svg
						className="size-2.5 group-open/collapse:rotate-90"
						viewBox="0 0 12 12"
						fill="none"
					>
						<path
							d="M4.5 2.5L8.5 6L4.5 9.5"
							stroke="currentColor"
							strokeWidth="1.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</span>
				<span className="shrink-0 text-[11px] text-muted-foreground/40">
					{group.tools.length} tools
				</span>
			</summary>
			{open ? (
				<div className="ml-5 flex flex-col gap-0.5 border-l border-border/30 pl-3 pt-1">
					{group.tools.map((tool, index) => (
						<AssistantToolCall
							key={tool.toolCallId ?? `${tool.toolName}:${index}`}
							toolName={tool.toolName}
							args={tool.args}
							result={tool.result}
							isError={tool.isError}
						/>
					))}
				</div>
			) : null}
		</details>
	);
}

function CopyMessageButton() {
	const [copied, setCopied] = useState(false);
	const ref = useRef<HTMLButtonElement>(null);

	const handleCopy = useCallback(() => {
		const root =
			ref.current?.closest("[data-message-role]") ?? ref.current?.parentElement;
		if (!root) {
			return;
		}
		const text = root.textContent ?? "";
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}, []);

	return (
		<Button
			ref={ref}
			type="button"
			variant="ghost"
			size="icon-xs"
			onClick={handleCopy}
			className="size-5 shrink-0 text-muted-foreground/30 opacity-0 transition-all hover:text-muted-foreground group-hover/sys:opacity-100"
		>
			{copied ? (
				<Check className="size-3" strokeWidth={2} />
			) : (
				<Copy className="size-3" strokeWidth={1.8} />
			)}
		</Button>
	);
}

function EditDiffTrigger({
	file,
	diffAdd,
	diffDel,
	oldStr,
	newStr,
}: {
	file: string;
	diffAdd?: number;
	diffDel?: number;
	oldStr: string | null;
	newStr: string | null;
}) {
	const triggerRef = useRef<HTMLSpanElement>(null);
	const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

	const show = useCallback(() => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		if (triggerRef.current) {
			const rect = triggerRef.current.getBoundingClientRect();
			setPos({ x: rect.left, y: rect.bottom + 4 });
		}
	}, []);
	const hideDelayed = useCallback(() => {
		hideTimer.current = setTimeout(() => setPos(null), 120);
	}, []);

	return (
		<>
			<span
				ref={triggerRef}
				onMouseEnter={show}
				onMouseLeave={hideDelayed}
				className="inline-flex cursor-default items-center gap-1.5 rounded border border-border/60 px-1.5 py-0.5 transition-colors hover:border-muted-foreground/40 hover:bg-accent/40"
			>
				<span className="truncate text-muted-foreground">{file}</span>
				{diffAdd != null || diffDel != null ? (
					<span className="flex items-center gap-1 text-[11px]">
						{diffAdd != null ? (
							<span className="text-chart-2">+{diffAdd}</span>
						) : null}
						{diffDel != null ? (
							<span className="text-destructive">-{diffDel}</span>
						) : null}
					</span>
				) : null}
			</span>
			{pos
				? createPortal(
						<div
							onMouseEnter={show}
							onMouseLeave={hideDelayed}
							className="fixed z-[100] w-[min(40rem,90vw)] rounded-lg border border-border bg-popover shadow-xl"
							style={{ left: pos.x, top: pos.y }}
						>
							<div className="border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
								{file}
							</div>
							<div className="max-h-[24rem] overflow-auto font-mono text-[11px] leading-5">
								{oldStr
									? oldStr.split("\n").map((line, index) => (
											<div
												key={`d${index}`}
												className="flex whitespace-pre-wrap bg-destructive/10"
											>
												<span className="w-8 shrink-0 select-none border-r border-border/20 pr-1 text-right text-destructive/40">
													{index + 1}
												</span>
												<span className="w-4 shrink-0 select-none text-center text-destructive/60">
													-
												</span>
												<span className="min-w-0 text-destructive/80">
													{line}
												</span>
											</div>
										))
									: null}
								{oldStr && newStr ? (
									<Separator className="my-0.5 bg-border/30" />
								) : null}
								{newStr
									? newStr.split("\n").map((line, index) => (
											<div
												key={`a${index}`}
												className="flex whitespace-pre-wrap bg-chart-2/10"
											>
												<span className="w-8 shrink-0 select-none border-r border-border/20 pr-1 text-right text-chart-2/50">
													{index + 1}
												</span>
												<span className="w-4 shrink-0 select-none text-center text-chart-2/70">
													+
												</span>
												<span className="min-w-0 text-chart-2">{line}</span>
											</div>
										))
									: null}
							</div>
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

function isTextPart(
	part: unknown,
): part is Extract<MessagePart, { type: "text" }> {
	return isObj(part) && part.type === "text" && typeof part.text === "string";
}

function isReasoningPart(
	part: unknown,
): part is Extract<MessagePart, { type: "reasoning" }> {
	return (
		isObj(part) && part.type === "reasoning" && typeof part.text === "string"
	);
}

function isToolCallPart(
	part: unknown,
): part is Extract<MessagePart, { type: "tool-call" }> {
	return (
		isObj(part) &&
		part.type === "tool-call" &&
		typeof part.toolName === "string" &&
		isObj(part.args)
	);
}

function isCollapsedGroupPart(part: unknown): part is CollapsedGroupPart {
	return (
		isObj(part) && part.type === "collapsed-group" && Array.isArray(part.tools)
	);
}

function isSystemNoticePart(part: unknown): part is SystemNoticePart {
	return (
		isObj(part) &&
		part.type === "system-notice" &&
		typeof part.label === "string" &&
		(part.severity === "info" ||
			part.severity === "warning" ||
			part.severity === "error")
	);
}

function isTodoListPart(part: unknown): part is TodoListPart {
	return isObj(part) && part.type === "todo-list" && Array.isArray(part.items);
}

function isImagePart(part: unknown): part is ImagePart {
	return isObj(part) && part.type === "image" && isObj(part.source);
}

function isPromptSuggestionPart(part: unknown): part is PromptSuggestionPart {
	return (
		isObj(part) &&
		part.type === "prompt-suggestion" &&
		typeof part.text === "string"
	);
}

function isFileMentionPart(part: unknown): part is FileMentionPart {
	return (
		isObj(part) && part.type === "file-mention" && typeof part.path === "string"
	);
}

function isPlanReviewPart(part: unknown): part is PlanReviewPart {
	return (
		isObj(part) &&
		part.type === "plan-review" &&
		typeof part.toolUseId === "string" &&
		typeof part.toolName === "string"
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
	return <span>{text}</span>;
}

type ToolInfo = {
	action: string;
	file?: string;
	detail?: string;
	command?: string;
	fullCommand?: string;
	icon: React.ReactNode;
	diffAdd?: number;
	diffDel?: number;
	body?: string;
};

function getToolInfo(
	name: string,
	input: Record<string, unknown> | null,
): ToolInfo {
	const fallbackIcon = (
		<span className="size-3.5 rounded-full bg-foreground/15" />
	);
	const neutralToolIconClassName = "size-3.5 text-muted-foreground";

	if (name.startsWith("mcp__")) {
		const segments = name.split("__");
		const server = segments[1] ?? "mcp";
		const tool = segments.slice(2).join("__") || name;
		return {
			action: tool,
			icon: <Plug className="size-3.5 text-chart-2" strokeWidth={1.8} />,
			detail: `via ${server}`,
		};
	}

	if (!input) {
		return { action: name, icon: fallbackIcon };
	}

	if (name === "Edit") {
		const filePath = str(input.file_path);
		const oldStr = typeof input.old_string === "string" ? input.old_string : "";
		const newStr = typeof input.new_string === "string" ? input.new_string : "";
		const diffDelete = oldStr ? oldStr.split("\n").length : 0;
		const diffAdd = newStr ? newStr.split("\n").length : 0;
		return {
			action: "Edit",
			file: filePath ? basename(filePath) : undefined,
			icon: <Pencil className={neutralToolIconClassName} strokeWidth={1.8} />,
			diffAdd,
			diffDel: diffDelete,
		};
	}

	if (name === "Read") {
		const filePath = str(input.file_path);
		const limit = typeof input.limit === "number" ? input.limit : null;
		return {
			action: limit ? `Read ${limit} lines` : "Read",
			file: filePath ? basename(filePath) : undefined,
			icon: <FileText className={neutralToolIconClassName} strokeWidth={1.8} />,
		};
	}

	if (name === "Write") {
		const filePath = str(input.file_path);
		return {
			action: "Write",
			file: filePath ? basename(filePath) : undefined,
			icon: <FilePlus className="size-3.5 text-chart-2" strokeWidth={1.8} />,
		};
	}

	if (name === "Bash") {
		const command = str(input.command);
		const description = str(input.description);
		return {
			action: description ?? "Run",
			icon: (
				<SquareTerminal
					className="size-3.5 text-muted-foreground"
					strokeWidth={1.8}
				/>
			),
			command: command ? truncate(command, 80) : undefined,
			fullCommand: command ?? undefined,
		};
	}

	if (name === "Grep") {
		const pattern = str(input.pattern);
		return {
			action: "Grep",
			icon: <Search className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: pattern ?? undefined,
		};
	}

	if (name === "Glob") {
		const pattern = str(input.pattern);
		return {
			action: "Glob",
			icon: (
				<FolderSearch className={neutralToolIconClassName} strokeWidth={1.8} />
			),
			detail: pattern ?? undefined,
		};
	}

	if (name === "WebFetch") {
		const url = str(input.url);
		return {
			action: "WebFetch",
			icon: <Globe className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: url ? truncate(url, 60) : undefined,
		};
	}

	if (name === "WebSearch") {
		const query = str(input.query);
		return {
			action: "WebSearch",
			icon: <Globe className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: query ? truncate(query, 50) : undefined,
		};
	}

	if (name === "ToolSearch") {
		const query = str(input.query);
		return {
			action: "ToolSearch",
			icon: <Search className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: query ? truncate(query, 50) : undefined,
		};
	}

	if (name === "Agent" || name === "Task") {
		const subagentType = str(input.subagent_type);
		const detail = str(input.description) ?? str(input.prompt);
		return {
			action: subagentType ?? name,
			icon: <Bot className={neutralToolIconClassName} strokeWidth={1.8} />,
			detail: detail ? truncate(detail, 60) : undefined,
		};
	}

	if (name === "Prompt") {
		const text = str(input.text);
		return {
			action: "Prompt",
			icon: (
				<MessageSquareText
					className={neutralToolIconClassName}
					strokeWidth={1.8}
				/>
			),
			body: text ?? undefined,
		};
	}

	if (
		name === "AskUserQuestion" ||
		name === "askUserQuestions" ||
		name === "vscode_askQuestions"
	) {
		const questions = Array.isArray(input.questions) ? input.questions : [];
		const firstQuestion = questions[0];
		const detail =
			str(input.question) ??
			str(input.prompt) ??
			(isObj(firstQuestion)
				? (str(firstQuestion.question) ?? str(firstQuestion.header))
				: null);
		return {
			action: "Ask user",
			icon: (
				<MessageSquareMore
					className={neutralToolIconClassName}
					strokeWidth={1.8}
				/>
			),
			detail: detail ? truncate(detail, 60) : undefined,
		};
	}

	return { action: name, icon: fallbackIcon };
}

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function truncate(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function basename(path: string): string {
	return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

function isObj(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function EmptyState({ hasSession }: { hasSession: boolean }) {
	return (
		<Empty className="max-w-sm">
			<EmptyHeader>
				<EmptyMedia className="mb-1 text-app-foreground-soft/72 [&_svg:not([class*='size-'])]:size-7">
					<MessageSquareText strokeWidth={1.7} />
				</EmptyMedia>
				<EmptyTitle>
					{hasSession ? "Nothing here yet" : "No session selected"}
				</EmptyTitle>
				<EmptyDescription>
					{hasSession
						? "This session does not have any messages yet."
						: "Choose a session from the header to inspect its timeline."}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
