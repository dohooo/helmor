import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { BrainIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
	createContext,
	memo,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ShimmerText } from "@/components/ui/shimmer-text";
import type { ReasoningLifecycle } from "@/lib/reasoning-lifecycle";
import { cn } from "@/lib/utils";

export type { ReasoningLifecycle };

interface ReasoningContextValue {
	lifecycle: ReasoningLifecycle;
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
	/**
	 * Current lifecycle phase. `"streaming"` defaults to open (active
	 * generation); auto-collapses when transitioning to `"just-finished"`
	 * or `"historical"`. Historical reloads also default to collapsed.
	 */
	lifecycle?: ReasoningLifecycle;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	duration?: number;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
	({
		className,
		lifecycle = "historical",
		open,
		defaultOpen,
		onOpenChange,
		duration: durationProp,
		children,
		...props
	}: ReasoningProps) => {
		// Only the actively-streaming block defaults open. `just-finished`
		// and `historical` both default closed so the row's DOM state is
		// the same regardless of whether the user was watching when the
		// stream ended — previously a transition-only `setIsOpen(false)`
		// effect collapsed live observers but left switched-away viewers
		// with an expanded block, which both surprises users (per their
		// "thinking 输出完之后自动收起" expectation) and inflates
		// `totalRowsHeight` against the layout estimator.
		const resolvedDefaultOpen = defaultOpen ?? lifecycle === "streaming";

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
		const isStreaming = lifecycle === "streaming";

		useEffect(() => {
			if (isStreaming) {
				if (startTime === null) setStartTime(Date.now());
			} else if (startTime !== null) {
				setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
				setStartTime(null);
			}
		}, [isStreaming, startTime, setDuration]);

		// Auto-collapse on the live `streaming → !streaming` transition so
		// the user watching it finish sees the block tuck away. Fresh
		// mounts as `just-finished` already start collapsed via the
		// defaultOpen above, so the two paths converge.
		const prevLifecycleRef = useRef(lifecycle);
		useEffect(() => {
			const prev = prevLifecycleRef.current;
			prevLifecycleRef.current = lifecycle;
			if (prev === "streaming" && lifecycle !== "streaming") {
				setIsOpen(false);
			}
		}, [lifecycle, setIsOpen]);

		return (
			<ReasoningContext.Provider
				value={{ lifecycle, isOpen: isOpen ?? false, setIsOpen, duration }}
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
		const { lifecycle, isOpen, duration } = useReasoning();
		const isStreaming = lifecycle === "streaming";

		return (
			<CollapsibleTrigger
				className={cn(
					"group/reasoning inline-flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden",
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
		return (
			<CollapsibleContent className={cn("pt-1.5", className)} {...props}>
				<pre
					className="whitespace-pre-wrap break-words rounded-lg bg-muted/40 px-3 py-2.5 font-sans leading-relaxed text-muted-foreground/80"
					style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
				>
					{children}
				</pre>
			</CollapsibleContent>
		);
	},
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
