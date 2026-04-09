import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { cn } from "@/lib/utils";

interface ReasoningContextValue {
	isStreaming: boolean;
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
	duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

function useReasoning() {
	const context = useContext(ReasoningContext);
	if (!context)
		throw new Error("Reasoning components must be used within Reasoning");
	return context;
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
	isStreaming?: boolean;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	duration?: number;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
	({
		className,
		isStreaming = false,
		open,
		defaultOpen,
		onOpenChange,
		duration: durationProp,
		children,
		...props
	}: ReasoningProps) => {
		// Historical (non-streaming) blocks start collapsed to avoid re-opening on remount.
		const resolvedDefaultOpen = defaultOpen ?? isStreaming;

		const [isOpen, setIsOpen] = useControllableState({
			prop: open,
			defaultProp: resolvedDefaultOpen,
			onChange: onOpenChange,
		});
		const [duration, setDuration] = useControllableState({
			prop: durationProp,
			defaultProp: undefined,
		});

		const [startTime, setStartTime] = useState<number | null>(null);

		useEffect(() => {
			if (isStreaming) {
				if (startTime === null) setStartTime(Date.now());
			} else if (startTime !== null) {
				setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
				setStartTime(null);
			}
		}, [isStreaming, startTime, setDuration]);

		return (
			<ReasoningContext.Provider
				value={{ isStreaming, isOpen: isOpen ?? false, setIsOpen, duration }}
			>
				<Collapsible
					className={cn("flex flex-col", className)}
					onOpenChange={setIsOpen}
					open={isOpen}
					{...props}
				>
					{children}
				</Collapsible>
			</ReasoningContext.Provider>
		);
	},
);

export type ReasoningTriggerProps = ComponentProps<
	typeof CollapsibleTrigger
> & {
	getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

function defaultGetThinkingMessage(isStreaming: boolean, duration?: number) {
	if (isStreaming) {
		return <ShimmerText>Thinking...</ShimmerText>;
	}
	if (duration === undefined) {
		return <span>Thinking</span>;
	}
	return <span>Thought for {duration}s</span>;
}

export const ReasoningTrigger = memo(
	({
		className,
		children,
		getThinkingMessage = defaultGetThinkingMessage,
		...props
	}: ReasoningTriggerProps) => {
		const { isStreaming, isOpen, duration } = useReasoning();

		return (
			<CollapsibleTrigger
				className={cn(
					"group/reasoning inline-flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-app-muted transition-colors hover:text-app-foreground-soft [&::-webkit-details-marker]:hidden",
					className,
				)}
				{...props}
			>
				<BrainIcon className="size-3 shrink-0" strokeWidth={1.8} />
				{children ?? getThinkingMessage(isStreaming, duration)}
				<ChevronRightIcon
					className={cn(
						"size-3 shrink-0 text-[#444241] transition-[transform,color] group-hover/reasoning:text-[rgb(134,133,132)]",
						isOpen ? "rotate-90" : "rotate-0",
					)}
					strokeWidth={1.8}
				/>
			</CollapsibleTrigger>
		);
	},
);

export type ReasoningContentProps = ComponentProps<
	typeof CollapsibleContent
> & {
	children: string;
	fontSize?: number;
};

export const ReasoningContent = memo(
	({ className, children, fontSize, ...props }: ReasoningContentProps) => {
		const { scrollRef, contentRef } = useStickToBottom({ initial: "instant" });

		return (
			<CollapsibleContent className={cn("pt-1.5", className)} {...props}>
				<div
					ref={scrollRef}
					className="max-h-[20rem] overflow-auto rounded-lg bg-app-foreground/[0.03]"
				>
					<pre
						ref={contentRef}
						className="whitespace-pre-wrap break-words px-3 py-2.5 font-sans leading-relaxed text-app-muted/70"
						style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
					>
						{children}
					</pre>
				</div>
			</CollapsibleContent>
		);
	},
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
