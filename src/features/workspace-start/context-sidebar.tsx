import { useEffect, useState, useTransition } from "react";
import Skeleton from "react-loading-skeleton";
import { InboxSidebar } from "@/features/inbox";
import type { RepositoryCreateOption } from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import type { ContextCard } from "@/lib/sources/types";

type WorkspaceStartContextSidebarProps = {
	repository: RepositoryCreateOption | null;
	inboxProviderTab: string;
	onInboxProviderTabChange: (tab: string) => void;
	inboxProviderSourceTab: string;
	onInboxProviderSourceTabChange: (tab: string) => void;
	inboxStateFilterBySource: Record<string, string>;
	onInboxStateFilterBySourceChange: (filters: Record<string, string>) => void;
	composerInsertTarget?: ComposerInsertTarget;
	selectedCardId?: string | null;
	onOpenCard?: (card: ContextCard) => void;
};

export function WorkspaceStartContextSidebar({
	repository,
	inboxProviderTab,
	onInboxProviderTabChange,
	inboxProviderSourceTab,
	onInboxProviderSourceTabChange,
	inboxStateFilterBySource,
	onInboxStateFilterBySourceChange,
	composerInsertTarget,
	selectedCardId,
	onOpenCard,
}: WorkspaceStartContextSidebarProps) {
	const [inboxMounted, setInboxMounted] = useState(false);
	const [, startTransition] = useTransition();

	useEffect(() => {
		setInboxMounted(false);
		const timer = window.setTimeout(() => {
			startTransition(() => {
				setInboxMounted(true);
			});
		}, 0);

		return () => window.clearTimeout(timer);
	}, [startTransition]);

	return (
		<div
			className="flex h-full min-h-0 flex-col bg-sidebar"
			style={{ contain: "layout paint style" }}
		>
			<div className="flex h-8 shrink-0 items-center border-border/60 border-b bg-muted/25 px-3">
				<h2 className="text-[13px] font-medium leading-8 tracking-[-0.01em] text-muted-foreground">
					Context
				</h2>
			</div>
			{inboxMounted ? (
				<InboxSidebar
					className="flex min-h-0 flex-1 bg-sidebar"
					onOpenCard={onOpenCard}
					selectedCardId={selectedCardId}
					repoFilter={parseGithubRepoFilter(repository)}
					providerTab={
						inboxProviderTab as Parameters<
							typeof InboxSidebar
						>[0]["providerTab"]
					}
					onProviderTabChange={onInboxProviderTabChange}
					providerSourceTab={
						inboxProviderSourceTab as Parameters<
							typeof InboxSidebar
						>[0]["providerSourceTab"]
					}
					onProviderSourceTabChange={onInboxProviderSourceTabChange}
					stateFilterBySource={inboxStateFilterBySource}
					onStateFilterBySourceChange={onInboxStateFilterBySourceChange}
					appendContextTarget={composerInsertTarget}
					showWindowSafeTop={false}
				/>
			) : (
				<ContextSidebarShell />
			)}
		</div>
	);
}

function ContextSidebarShell() {
	return (
		<div className="flex min-h-0 flex-1 flex-col bg-sidebar px-3 pt-2">
			<div className="grid w-full grid-cols-3 gap-1 rounded-lg border border-border/60 bg-background/40 p-1">
				<Skeleton
					containerClassName="block h-7"
					className="h-7 rounded-md"
					baseColor="var(--accent)"
					highlightColor="color-mix(in oklch, var(--accent) 72%, var(--background))"
				/>
				<Skeleton
					containerClassName="block h-7"
					className="h-7 rounded-md"
					baseColor="color-mix(in oklch, var(--muted) 58%, transparent)"
					highlightColor="color-mix(in oklch, var(--muted) 82%, var(--background))"
				/>
				<Skeleton
					containerClassName="block h-7"
					className="h-7 rounded-md"
					baseColor="color-mix(in oklch, var(--muted) 58%, transparent)"
					highlightColor="color-mix(in oklch, var(--muted) 82%, var(--background))"
				/>
			</div>
			<div className="mt-1.5 flex h-7 items-center gap-1.5">
				<Skeleton
					containerClassName="block min-w-0 flex-1 h-7"
					className="h-7 rounded-md"
					baseColor="color-mix(in oklch, var(--background) 55%, var(--muted))"
					highlightColor="color-mix(in oklch, var(--background) 80%, var(--muted))"
				/>
				<Skeleton
					containerClassName="block size-7 shrink-0"
					className="size-7 rounded-md"
					baseColor="color-mix(in oklch, var(--background) 55%, var(--muted))"
					highlightColor="color-mix(in oklch, var(--background) 80%, var(--muted))"
				/>
				<Skeleton
					containerClassName="block h-7 w-14 shrink-0"
					className="h-7 rounded-md"
					baseColor="color-mix(in oklch, var(--background) 55%, var(--muted))"
					highlightColor="color-mix(in oklch, var(--background) 80%, var(--muted))"
				/>
			</div>
			<div className="mt-2 flex w-[calc(100%+12px)] flex-col gap-2 pb-3">
				{Array.from({ length: 6 }).map((_, index) => (
					<ContextCardSkeleton key={index} />
				))}
			</div>
		</div>
	);
}

function ContextCardSkeleton() {
	return (
		<div className="rounded-lg border border-border/70 bg-[var(--sidebar)] px-3 pt-2.5 pb-2 shadow-xs">
			<Skeleton
				containerClassName="block"
				className="h-[14px] rounded"
				width="92%"
				baseColor="color-mix(in oklch, var(--muted) 62%, transparent)"
				highlightColor="color-mix(in oklch, var(--muted) 86%, var(--background))"
			/>
			<Skeleton
				containerClassName="mt-1 block"
				className="h-[14px] rounded"
				width="64%"
				baseColor="color-mix(in oklch, var(--muted) 56%, transparent)"
				highlightColor="color-mix(in oklch, var(--muted) 82%, var(--background))"
			/>
			<div className="mt-2 flex items-center justify-between gap-2">
				<Skeleton
					containerClassName="block h-3.5 min-w-0 flex-1"
					className="h-3.5 rounded"
					width="58%"
					baseColor="color-mix(in oklch, var(--muted) 46%, transparent)"
					highlightColor="color-mix(in oklch, var(--muted) 75%, var(--background))"
				/>
				<Skeleton
					containerClassName="block h-3.5 w-10 shrink-0"
					className="h-3.5 rounded"
					baseColor="color-mix(in oklch, var(--muted) 46%, transparent)"
					highlightColor="color-mix(in oklch, var(--muted) 75%, var(--background))"
				/>
			</div>
		</div>
	);
}

function parseGithubRepoFilter(
	repository: RepositoryCreateOption | null,
): string | null {
	if (!repository) return null;
	if (repository.forgeProvider && repository.forgeProvider !== "github") {
		return null;
	}
	const trimmed = (repository.remoteUrl ?? "").trim();
	if (!trimmed) return null;
	const sshMatch = trimmed.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (sshMatch) {
		return `${sshMatch[1]}/${sshMatch[2]}`;
	}
	const httpsMatch = trimmed.match(
		/^(?:https?|git|ssh:\/\/git@)?:?\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
	);
	if (httpsMatch) {
		return `${httpsMatch[1]}/${httpsMatch[2]}`;
	}
	return null;
}
