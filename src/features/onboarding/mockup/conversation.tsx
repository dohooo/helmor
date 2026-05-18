import {
	Brain,
	ChevronDown,
	ChevronRight,
	ClipboardList,
	Wrench,
	Zap,
} from "lucide-react";
import { ClaudeIcon, OpenAIIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { type MockMessage, type MockSession, mockConversation } from "./data";
import { AssistantTextUI } from "./ui/assistant-text.ui";
import {
	ComposerInputPlaceholderUI,
	ComposerShellUI,
	ComposerSubmitButtonUI,
} from "./ui/composer-shell.ui";
import {
	AgentPickerButtonUI,
	ConversationHeaderUI,
} from "./ui/conversation-header.ui";
import { SessionTabsRowUI, SessionTabUI } from "./ui/session-tab.ui";
import { ToolCallRowUI } from "./ui/tool-call-row.ui";
import { UserMessageBubbleUI } from "./ui/user-message-bubble.ui";
import { WorkingIndicatorUI } from "./ui/working-indicator.ui";

function ProviderIcon({ provider }: { provider: MockSession["provider"] }) {
	const Icon = provider === "codex" ? OpenAIIcon : ClaudeIcon;
	return <Icon className="size-3.5 shrink-0" />;
}

/**
 * Static reasoning trigger for the mockup. Mirrors the visible row that
 * `<ReasoningTrigger>` paints when the block is collapsed (Brain icon +
 * label + chevron). Renders without the Collapsible/Context machinery so the
 * mockup is fully static.
 */
function MockReasoningRow({ label }: { label: string }) {
	return (
		<div className="group/reasoning inline-flex max-w-full items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground">
			<Brain className="size-3 shrink-0" strokeWidth={1.8} />
			<span>{label}</span>
			<ChevronRight
				className="size-3 shrink-0 text-[#444241]"
				strokeWidth={1.8}
			/>
		</div>
	);
}

/**
 * Static todo block for the mockup. Mirrors the visible shape of the real
 * `<TodoList>` (in `panel/message-components/content-parts.tsx`) — same outer
 * card, same icon styling — but driven by static items rather than a
 * `TodoListPart`.
 */
function MockTodoList({
	items,
}: {
	items: Array<{ label: string; done?: boolean }>;
}) {
	const completed = items.filter((item) => item.done).length;
	return (
		<div className="my-1 flex flex-col gap-0.5 rounded-md border border-border/40 bg-accent/35 px-3 py-2 text-[13px] leading-6 text-muted-foreground">
			<div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
				<ClipboardList className="size-3" strokeWidth={1.8} />
				<span>
					Plan - {completed}/{items.length} done
				</span>
			</div>
			{items.map((todo, index) => (
				<div key={index} className="flex items-center gap-1.5">
					<span
						className={cn(
							"flex size-3 shrink-0 items-center justify-center rounded-full border",
							todo.done
								? "border-chart-2 bg-chart-2/20 text-chart-2"
								: "border-muted-foreground/40",
						)}
					>
						{todo.done ? (
							<span className="size-1.5 rounded-full bg-chart-2" />
						) : null}
					</span>
					<span
						className={
							todo.done
								? "text-muted-foreground line-through"
								: "text-muted-foreground"
						}
					>
						{todo.label}
					</span>
				</div>
			))}
		</div>
	);
}

function Message({
	message,
	cliSplitSpotlight = false,
}: {
	message: MockMessage;
	cliSplitSpotlight?: boolean;
}) {
	if (message.role === "user") {
		return (
			<div className="flow-root px-5 pb-1.5">
				<UserMessageBubbleUI>{message.text}</UserMessageBubbleUI>
			</div>
		);
	}
	return (
		<div className="flow-root px-5 pb-1.5">
			<div className="flex min-w-0 max-w-full flex-col gap-1">
				{message.parts.map((part, index) => {
					if (part.type === "reasoning") {
						return <MockReasoningRow key={index} label={part.label} />;
					}
					if (part.type === "todo") {
						return <MockTodoList key={index} items={part.items} />;
					}
					if (part.type === "tool") {
						return (
							<ToolCallRowUI
								key={index}
								icon={<Wrench className="size-3.5" />}
								name={part.name}
								detail={part.detail}
								className={
									cliSplitSpotlight && part.cliSplitTarget
										? "relative z-40 isolate bg-sidebar"
										: undefined
								}
							/>
						);
					}
					return (
						<AssistantTextUI key={index}>
							<p>{part.text}</p>
						</AssistantTextUI>
					);
				})}
			</div>
		</div>
	);
}

export function MockConversation({
	providerSpotlight = false,
	cliSplitSpotlight = false,
}: {
	providerSpotlight?: boolean;
	cliSplitSpotlight?: boolean;
} = {}) {
	return (
		<section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
			<header className="relative z-20">
				<ConversationHeaderUI
					branch={mockConversation.branch}
					branchTone={mockConversation.branchTone}
					targetBranch={mockConversation.targetBranch}
					rightSlot={
						<AgentPickerButtonUI
							icon={<OpenAIIcon className="size-3.5" />}
							label="Cursor"
						/>
					}
				/>
				<SessionTabsRowUI
					tabs={mockConversation.sessions.map((session) => (
						<SessionTabUI
							key={session.id}
							icon={<ProviderIcon provider={session.provider} />}
							title={session.title}
							selected={session.active}
							hasStatusDot={Boolean(session.unread)}
						/>
					))}
				/>
			</header>
			<div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="conversation-scroll-area relative min-h-0 flex-1 overflow-hidden">
					<div className="conversation-scroll-viewport h-full w-full overflow-hidden">
						<div className="flex min-h-full flex-col">
							<div className="h-6 shrink-0" />
							{mockConversation.messages.map((message) => (
								<Message
									key={message.id}
									message={message}
									cliSplitSpotlight={cliSplitSpotlight}
								/>
							))}
							<WorkingIndicatorUI />
						</div>
					</div>
				</div>
				<div className="mt-auto px-4 pb-4 pt-0">
					<ComposerShellUI
						input={<ComposerInputPlaceholderUI />}
						toolbar={
							<>
								<span
									className={cn(
										"flex items-center gap-1.5 rounded-[9px] px-1 py-0.5 text-[13px] font-medium",
										providerSpotlight
											? "relative z-40 isolate bg-sidebar text-foreground"
											: "text-muted-foreground",
									)}
								>
									<ClaudeIcon className="size-[13px]" />
									Opus 4.7M
									<ChevronDown className="size-3 opacity-40" />
								</span>
								<span className="flex items-center gap-1 rounded-[9px] px-1 py-0.5 text-[13px] font-medium text-muted-foreground">
									<Zap className="size-[13px] opacity-55" />
								</span>
								<span className="rounded-[9px] px-1 py-0.5 text-[13px] font-medium effort-max-text">
									High
								</span>
								<span className="flex items-center gap-1 rounded-[9px] px-1.5 py-0.5 text-[11px] font-medium text-plan">
									<ClipboardList className="size-[13px]" />
									Plan
								</span>
							</>
						}
						submit={<ComposerSubmitButtonUI />}
					/>
				</div>
			</div>
		</section>
	);
}
