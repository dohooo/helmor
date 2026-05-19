import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { HelmorThinkingIndicator } from "@/components/helmor-thinking-indicator";
import { WorkspaceAvatar } from "@/features/navigation/avatar";
import { deriveWorkspaceDisplay } from "@/features/navigation/workspace-display";
import { extractLiveActivity } from "@/features/navigation/workspace-hover-card";
import { deriveWorkspaceStatusDot } from "@/features/navigation/workspace-status-display";
import type { WorkspaceRow } from "@/lib/api";
import { useBusySessionIds } from "@/lib/session-run-state-context";
import {
	readSessionThread,
	sessionThreadCacheKey,
} from "@/lib/session-thread-cache";
import { cn } from "@/lib/utils";
import type { QuickSwitchState } from "./use-quick-switch";

type QuickSwitchOverlayProps = {
	state: QuickSwitchState;
	getRow: (id: string) => WorkspaceRow | null;
	onSelectIndex: (index: number) => void;
	onCommitIndex: (index: number) => void;
};

export function QuickSwitchOverlay({
	state,
	getRow,
	onSelectIndex,
	onCommitIndex,
}: QuickSwitchOverlayProps) {
	// Keep the highlighted card in view when cycling. Use a DOM query rather
	// than a per-card ref so we don't have to thread refs through the loop.
	useEffect(() => {
		if (state.phase !== "open") return;
		const active = document.querySelector<HTMLElement>(
			'[data-testid="quick-switch-overlay"] [data-active="true"]',
		);
		active?.scrollIntoView({
			behavior: "smooth",
			block: "nearest",
			inline: "center",
		});
	}, [state]);

	if (state.phase !== "open") return null;
	if (typeof document === "undefined") return null;

	const items = state.ids
		.map((id) => getRow(id))
		.filter((row): row is WorkspaceRow => Boolean(row));
	if (items.length === 0) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-[80] grid place-items-center bg-black/15 supports-backdrop-filter:backdrop-blur-sm"
			data-testid="quick-switch-overlay"
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Quick switch workspace"
				className="rounded-2xl bg-popover/95 p-3 text-popover-foreground shadow-2xl ring-1 ring-foreground/10"
			>
				<div className="flex max-w-[80vw] gap-2 overflow-x-auto scroll-smooth py-1">
					{items.map((row, idx) => (
						<QuickSwitchCard
							key={row.id}
							row={row}
							isActive={idx === state.index}
							onSelect={() => onSelectIndex(idx)}
							onCommit={() => onCommitIndex(idx)}
						/>
					))}
				</div>
			</div>
		</div>,
		document.body,
	);
}

function QuickSwitchCard({
	row,
	isActive,
	onSelect,
	onCommit,
}: {
	row: WorkspaceRow;
	isActive: boolean;
	onSelect: () => void;
	onCommit: () => void;
}) {
	const queryClient = useQueryClient();
	const busySessionIds = useBusySessionIds();
	const sessionId = row.activeSessionId ?? row.primarySessionId ?? null;
	const isStreaming = sessionId ? busySessionIds.has(sessionId) : false;

	// In-memory thread cache only — no IPC on render.
	const { data: thread } = useQuery({
		queryKey: sessionThreadCacheKey(sessionId ?? "__none__"),
		queryFn: () =>
			sessionId ? (readSessionThread(queryClient, sessionId) ?? []) : [],
		enabled: Boolean(sessionId),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: 30_000,
	});

	const blocks = useMemo(() => extractLiveActivity(thread), [thread]);
	const reversedBlocks = useMemo(() => [...blocks].reverse(), [blocks]);

	const { title, subtitle, branch } = deriveWorkspaceDisplay(row);
	const statusDot = deriveWorkspaceStatusDot(row);

	const hasBlocks = reversedBlocks.length > 0;

	return (
		<button
			type="button"
			data-active={isActive ? "true" : "false"}
			aria-selected={isActive}
			onMouseEnter={onSelect}
			onClick={onCommit}
			className={cn(
				"flex h-44 w-60 shrink-0 cursor-pointer flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors",
				isActive
					? "border-foreground/20 bg-accent/80"
					: "border-transparent hover:bg-accent/40",
			)}
		>
			<div className="flex min-w-0 shrink-0 items-center gap-1.5">
				<WorkspaceAvatar
					title={title}
					repoIconSrc={row.repoIconSrc}
					repoInitials={row.repoInitials}
					repoName={row.repoName}
					className="size-4 rounded-[5px]"
					fallbackClassName="text-[7px]"
				/>
				<span
					className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-tight text-foreground"
					title={title}
				>
					{title}
				</span>
				{isStreaming ? (
					<HelmorThinkingIndicator size={12} className="shrink-0" />
				) : null}
				<span
					aria-label={statusDot.label}
					title={statusDot.label}
					className={cn("size-2 shrink-0 rounded-full", statusDot.dotClass)}
				/>
			</div>

			{subtitle ? (
				<div className="flex min-w-0 shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground/90">
					{branch ? (
						<GitBranch className="size-2.5 shrink-0" strokeWidth={2.2} />
					) : null}
					<span className="truncate" title={subtitle}>
						{subtitle}
					</span>
				</div>
			) : null}

			{/* Always mount: fixes card height regardless of preview content. */}
			<div
				data-testid="quick-switch-preview"
				className="flex min-h-0 flex-1 flex-col-reverse gap-1 overflow-hidden text-[10.5px] leading-[1.4]"
				style={
					hasBlocks
						? {
								maskImage:
									"linear-gradient(to top, black 78%, transparent 100%)",
								WebkitMaskImage:
									"linear-gradient(to top, black 78%, transparent 100%)",
							}
						: undefined
				}
			>
				{hasBlocks
					? reversedBlocks.map((block) => {
							if (block.kind === "tool") {
								return (
									<div
										key={block.key}
										className="flex items-baseline gap-1 truncate font-mono text-[10px] text-muted-foreground/85"
									>
										<span className="text-muted-foreground/50">›</span>
										<span className="truncate">{block.label}</span>
									</div>
								);
							}
							return (
								<div
									key={block.key}
									className={cn(
										"break-words whitespace-pre-wrap text-muted-foreground",
										block.reasoning && "italic text-muted-foreground/70",
									)}
								>
									{block.text}
								</div>
							);
						})
					: isStreaming
						? [
								<div key="thinking" className="italic text-muted-foreground/70">
									Thinking…
								</div>,
							]
						: null}
			</div>
		</button>
	);
}
