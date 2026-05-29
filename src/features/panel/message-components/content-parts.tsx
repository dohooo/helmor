import { convertFileSrc } from "@tauri-apps/api/core";
import {
	Check,
	Circle,
	CircleDot,
	ClipboardList,
	Copy,
	FolderOpen,
	MessageSquareText,
	Workflow,
} from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { ShimmerText } from "@/components/ui/shimmer-text";
import { formatTokens } from "@/features/composer/context-usage-ring/parse";
import {
	copyImageToClipboard,
	type ImagePart,
	type PlanReviewPart,
	showImageInFinder,
	type TodoListPart,
	type WorkflowPart,
} from "@/lib/api";
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
		<div className="my-1 flex flex-col gap-0.5 rounded-md border border-border/40 bg-accent/35 px-3 py-2 text-ui leading-6 text-muted-foreground">
			<div className="mb-0.5 flex items-center gap-1.5 text-mini text-muted-foreground">
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

const WORKFLOW_STATUS_LABEL: Record<WorkflowPart["status"], string> = {
	running: "running",
	completed: "done",
	failed: "failed",
	stopped: "stopped",
};

export function formatWorkflowDuration(ms: number): string {
	if (ms < 1_000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
	const min = Math.floor(ms / 60_000);
	const sec = Math.round((ms % 60_000) / 1_000);
	return `${min}m ${sec}s`;
}

/**
 * Claude Code "Dynamic Workflow" run — the same card shell as `TodoList`,
 * with a phase/agent list and a token/duration footer. The header gets a
 * subtle shimmer ONLY while the run is in flight (phase-synced + reduced-
 * motion-safe via `ShimmerText`); it freezes the moment the run settles, so
 * there's no looping animation or layout jitter on a finished card.
 */
export function WorkflowCard({ part }: { part: WorkflowPart }) {
	const running = part.status === "running";
	const agents = part.agents ?? [];
	const headerLabel = `Workflow · ${part.name}`;
	const statusTone =
		part.status === "failed"
			? "text-destructive"
			: part.status === "completed"
				? "text-chart-2"
				: "text-muted-foreground";
	const footer = [
		agents.length > 0
			? `${agents.length} agent${agents.length === 1 ? "" : "s"}`
			: null,
		typeof part.totalTokens === "number"
			? `${formatTokens(part.totalTokens)} tokens`
			: null,
		typeof part.durationMs === "number"
			? formatWorkflowDuration(part.durationMs)
			: null,
	].filter((x): x is string => x !== null);
	return (
		<div className="my-1 flex flex-col gap-0.5 rounded-md border border-border/40 bg-accent/35 px-3 py-2 text-ui leading-6 text-muted-foreground">
			<div className="mb-0.5 flex items-center gap-1.5 text-mini text-muted-foreground">
				<Workflow className="size-3 shrink-0" strokeWidth={1.8} />
				{running ? (
					<ShimmerText className="text-mini" durationMs={2400}>
						{headerLabel}
					</ShimmerText>
				) : (
					<span className={statusTone}>{headerLabel}</span>
				)}
				<span className="ml-auto text-mini text-muted-foreground/60">
					{WORKFLOW_STATUS_LABEL[part.status]}
				</span>
			</div>
			{agents.map((agent, index) => {
				const done = agent.status === "done";
				const Icon = done ? Check : CircleDot;
				return (
					<div
						key={index}
						className="flex items-center gap-1.5 overflow-hidden"
					>
						<Icon
							className={cn(
								"size-3 shrink-0",
								done ? "text-chart-2" : "text-muted-foreground/60",
							)}
							strokeWidth={1.8}
						/>
						<span className="shrink-0 text-muted-foreground">
							{agent.label}
						</span>
						{agent.resultPreview ? (
							<span className="truncate text-muted-foreground/60">
								— {agent.resultPreview}
							</span>
						) : null}
					</div>
				);
			})}
			{footer.length > 0 ? (
				<div className="mt-0.5 text-mini text-muted-foreground/60">
					{footer.join(" · ")}
				</div>
			) : null}
		</div>
	);
}

export function PlanReviewCard({ part }: { part: PlanReviewPart }) {
	return (
		<div className="rounded-xl border-[1.5px] border-border/70 bg-background/60 px-3.5 py-3">
			<div className="flex items-center gap-1.5 text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground">
				<ClipboardList className="size-3.5" strokeWidth={1.8} />
				Plan
			</div>
			{part.planFilePath ? (
				<p className="mt-2 break-words text-small leading-5 text-muted-foreground">
					{part.planFilePath}
				</p>
			) : null}
			<div className="conversation-markdown mt-2 max-w-none break-words text-ui leading-6 text-foreground">
				<Suspense
					fallback={
						<pre className="whitespace-pre-wrap break-words">
							{part.plan?.trim() || "No plan content."}
						</pre>
					}
				>
					<LazyStreamdown className="conversation-streamdown" mode="static">
						{part.plan?.trim() || "No plan content."}
					</LazyStreamdown>
				</Suspense>
			</div>
			{(part.allowedPrompts ?? []).length > 0 ? (
				<div className="mt-3 grid gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5">
					<p className="text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground">
						Approved Prompts
					</p>
					{part.allowedPrompts?.map((entry) => (
						<div
							key={`${entry.tool}:${entry.prompt}`}
							className="rounded-md border border-border/50 bg-background/70 px-2 py-1.5"
						>
							<p className="text-mini font-medium uppercase tracking-[0.06em] text-muted-foreground">
								{entry.tool}
							</p>
							<p className="mt-1 whitespace-pre-wrap break-words text-small leading-5 text-foreground">
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
	const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
	const src = imageSrc(part);
	const filePath = part.source.kind === "file" ? part.source.path : null;

	useEffect(() => {
		if (!menuPosition) return;
		const close = () => setMenuPosition(null);
		window.addEventListener("pointerdown", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [menuPosition]);

	return (
		<span className="inline-block max-w-full">
			<img
				src={src}
				alt=""
				onContextMenu={(event) => {
					event.preventDefault();
					setMenuPosition(positionMenu(event));
				}}
				className="my-2 max-h-[420px] max-w-full rounded-md border border-border/40"
			/>
			{menuPosition
				? createPortal(
						<div
							role="menu"
							style={{ left: menuPosition.x, top: menuPosition.y }}
							onContextMenu={(event) => event.preventDefault()}
							onPointerDown={(event) => event.stopPropagation()}
							className="fixed z-50 min-w-44 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
						>
							<button
								type="button"
								role="menuitem"
								onClick={() => {
									setMenuPosition(null);
									void copyImage(part);
								}}
								className={imageMenuItemClassName}
							>
								<Copy className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Copy Image</span>
							</button>
							<button
								type="button"
								role="menuitem"
								disabled={!filePath}
								onClick={() => {
									if (!filePath) return;
									setMenuPosition(null);
									void showInFinder(filePath);
								}}
								className={cn(
									imageMenuItemClassName,
									!filePath && "cursor-not-allowed opacity-50",
								)}
							>
								<FolderOpen className="size-4 shrink-0" strokeWidth={1.6} />
								<span>Show in Finder</span>
							</button>
						</div>,
						document.body,
					)
				: null}
		</span>
	);
}

type MenuPosition = {
	x: number;
	y: number;
};

const imageMenuItemClassName =
	"relative flex w-full cursor-interactive items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-body outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none";

function positionMenu(event: React.MouseEvent): MenuPosition {
	const width = 176;
	const height = 76;
	const margin = 8;
	return {
		x: Math.max(
			margin,
			Math.min(event.clientX, window.innerWidth - width - margin),
		),
		y: Math.max(
			margin,
			Math.min(event.clientY, window.innerHeight - height - margin),
		),
	};
}

function imageSrc(part: ImagePart) {
	if (part.source.kind === "url") return part.source.url;
	if (part.source.kind === "file") return convertFileSrc(part.source.path);
	return `data:${part.mediaType ?? "image/png"};base64,${part.source.data}`;
}

async function copyImage(part: ImagePart) {
	try {
		if (part.source.kind === "file") {
			await copyImageToClipboard(part.source.path);
			toast.success("Image copied");
			return;
		}

		await copyImageBlobToClipboard(await imageBlob(part));
		toast.success("Image copied");
	} catch (error) {
		toast.error("Copy failed", { description: String(error) });
	}
}

async function showInFinder(path: string) {
	try {
		await showImageInFinder(path);
	} catch (error) {
		toast.error("Unable to show image in Finder", {
			description: String(error),
		});
	}
}

async function imageBlob(part: ImagePart) {
	if (part.source.kind === "base64") {
		const response = await fetch(imageSrc(part));
		return response.blob();
	}
	if (part.source.kind !== "url") {
		throw new Error("Image file clipboard is not available.");
	}

	const response = await fetch(part.source.url);
	if (!response.ok) {
		throw new Error(`Unable to load image (${response.status})`);
	}
	return response.blob();
}

async function copyImageBlobToClipboard(blob: Blob) {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
		throw new Error("Image clipboard is not available.");
	}
	const type = blob.type || "image/png";
	await navigator.clipboard.write([new ClipboardItem({ [type]: blob })]);
}
