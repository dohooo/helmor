import {
	Check,
	Circle,
	CircleDot,
	ClipboardList,
	MessageSquareText,
} from "lucide-react";
import type { ImagePart, PlanReviewPart, TodoListPart } from "@/lib/api";
import { cn } from "@/lib/utils";

export function TodoList({ part }: { part: TodoListPart }) {
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

export function PlanReviewCard({ part }: { part: PlanReviewPart }) {
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

export function ImageBlock({ part }: { part: ImagePart }) {
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
