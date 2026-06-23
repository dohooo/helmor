import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Check, Clock3, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { Suspense, useCallback, useState } from "react";
import { AppendContextButton } from "@/components/append-context-button";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { buildCardContextPayload } from "@/features/inbox/source-card";
import { SourceIcon } from "@/features/inbox/source-icon";
import { STATE_TONE_CLASS } from "@/features/inbox/state-tone";
import { getInboxItemDetail } from "@/lib/api";
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import { formatSource, I18nText, useI18n } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import { helmorQueryKeys } from "@/lib/query-client";
import type {
	ContextCard,
	ContextCardForgeDetailRef,
} from "@/lib/sources/types";
import { cn } from "@/lib/utils";

/** Background revalidation contract shared across detail views. Wiring
 *  a query's `refetch` + `isFetching` into this is enough to surface
 *  the toolbar refresh button. */
export type DetailRefreshControl = {
	refetch: () => void;
	isFetching: boolean;
};

/** Adapt a React Query result into the `RefreshButton` contract. Pure
 *  glue — kept here so individual detail-view files don't repeat the
 *  same 3-line inline object. */
export function toRefreshControl<T>(
	query: UseQueryResult<T>,
): DetailRefreshControl {
	return {
		refetch: () => void query.refetch(),
		isFetching: query.isFetching,
	};
}

/** Shared React Query setup for the forge (GitHub / GitLab) inbox-item
 *  detail page. Every `*-view.tsx` in `github/` and `gitlab/` calls
 *  this — same query key, same staleTime, same focus/mount sync
 *  contract — so the wrapper view files reduce to type-narrowing the
 *  result and forwarding to `GitHubDetailPage`. */
export function useInboxItemDetailQuery(
	detailRef: ContextCardForgeDetailRef | null,
	cardId: string,
) {
	return useQuery({
		queryKey: detailRef
			? helmorQueryKeys.inboxItemDetail(
					detailRef.provider,
					detailRef.login,
					detailRef.source,
					detailRef.externalId,
				)
			: ["inboxItemDetail", "missing", cardId],
		queryFn: () => getInboxItemDetail(detailRef!),
		enabled: detailRef !== null,
		staleTime: 60_000,
		// Re-fetch every time the panel mounts (user opens a card) or
		// the window regains focus — Slack/GitHub/GitLab items mutate
		// quickly and users expect "open / refocus" to be a natural
		// sync point.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
	});
}

export type SourceDetailProps = {
	card: ContextCard;
	appendContextTarget?: ComposerInsertTarget;
};

export function GitHubDetailPage({
	card,
	appendContextTarget,
	description,
	isLoading,
	error,
	kindLabel,
	refresh,
}: {
	card: ContextCard;
	appendContextTarget?: ComposerInsertTarget;
	description?: string;
	isLoading?: boolean;
	error?: Error | null;
	kindLabel: string;
	refresh?: DetailRefreshControl;
}) {
	const { t } = useI18n();
	const reference = parseExternalReference(card.externalId);
	const markdownBody = description?.trim() || t("miscNoDescriptionProvided");

	return (
		<article className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto px-4 [contain:content] [scrollbar-gutter:stable]">
			<header className="shrink-0 py-1.5">
				<div className="flex min-w-0 items-center justify-between gap-4">
					<div className="flex min-w-0 flex-wrap items-center gap-2 text-ui text-muted-foreground">
						{card.state ? <StatePill state={card.state} /> : null}
						<span className="font-medium text-foreground/80">
							{reference.repo}
						</span>
						<span className="inline-flex items-center gap-1 font-normal text-muted-foreground/70">
							<SourceIcon source={card.source} size={13} className="shrink-0" />
							{t(kindLabel)}
						</span>
						<span className="inline-flex items-center gap-1 font-normal text-muted-foreground/70">
							<Clock3 className="size-[13px]" strokeWidth={1.8} />
							<I18nText source="updated" />{" "}
							{formatRelativeTime(card.lastActivityAt)}
						</span>
					</div>
					<SourceDetailActions
						card={card}
						appendContextTarget={appendContextTarget}
						markdownBody={markdownBody}
						copyDisabled={isLoading || Boolean(error)}
						refresh={refresh}
					/>
				</div>
			</header>

			<div
				className={cn(
					"min-h-0 flex-1",
					isLoading || error ? "flex items-center justify-center" : "py-4",
				)}
			>
				{isLoading ? (
					<DetailLoadingState />
				) : error ? (
					<DetailErrorState error={error} />
				) : (
					<MarkdownBody body={markdownBody} />
				)}
			</div>
		</article>
	);
}

function SourceDetailActions({
	card,
	appendContextTarget,
	markdownBody,
	copyDisabled,
	refresh,
}: {
	card: ContextCard;
	appendContextTarget?: ComposerInsertTarget;
	markdownBody: string;
	copyDisabled?: boolean;
	refresh?: DetailRefreshControl;
}) {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	const handleCopy = useCallback(() => {
		if (copyDisabled || !navigator.clipboard?.writeText) return;
		void navigator.clipboard.writeText(markdownBody).then(() => {
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		});
	}, [copyDisabled, markdownBody]);

	return (
		<div className="flex shrink-0 items-center gap-1">
			{refresh ? <RefreshButton refresh={refresh} /> : null}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="openExternally"
						onClick={() => void openUrl(card.externalUrl)}
						className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
					>
						<ExternalLink className="size-[13px]" strokeWidth={1.8} />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="top">
					<I18nText source="openExternally" />
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex" aria-label={t("addContext2")}>
						<AppendContextButton
							subjectLabel={card.title}
							ariaLabel="addContext2"
							getPayload={() =>
								buildCardContextPayload(card, appendContextTarget)
							}
							errorTitle={t("miscCouldnTInsertContextCard")}
							className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg]:size-[13px]"
						/>
					</span>
				</TooltipTrigger>
				<TooltipContent side="top">
					<I18nText source="addContext2" />
				</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="copyMarkdown"
						disabled={copyDisabled}
						onClick={handleCopy}
						className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
					>
						{copied ? (
							<Check className="size-[13px]" strokeWidth={1.8} />
						) : (
							<Copy className="size-[13px]" strokeWidth={1.8} />
						)}
					</Button>
				</TooltipTrigger>
				<TooltipContent side="top">
					{copied ? t("copied") : t("copyMarkdown")}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}

/** Toolbar button that triggers a background refetch of the active
 *  detail query. Spins the icon while the underlying query is fetching,
 *  and disables the button so back-to-back clicks don't queue duplicate
 *  refetches. Shared between Slack and Forge (GitHub/GitLab) detail
 *  views — both wire a React Query `refetch` + `isFetching` pair into
 *  the `refresh` prop. */
export function RefreshButton({ refresh }: { refresh: DetailRefreshControl }) {
	const { t } = useI18n();
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label="refresh"
					disabled={refresh.isFetching}
					onClick={() => refresh.refetch()}
					className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
				>
					<RefreshCw
						className={cn("size-[13px]", refresh.isFetching && "animate-spin")}
						strokeWidth={1.8}
					/>
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">
				{refresh.isFetching ? t("refreshing") : t("refresh")}
			</TooltipContent>
		</Tooltip>
	);
}

function DetailLoadingState() {
	return (
		<div className="flex items-center justify-center">
			<HelmorLogoAnimated size={42} className="opacity-30" />
		</div>
	);
}

function DetailErrorState({ error }: { error: Error }) {
	return (
		<div className="text-center text-ui text-muted-foreground">
			{error.message}
		</div>
	);
}

function MarkdownBody({ body }: { body: string }) {
	return (
		<div className="conversation-markdown max-w-3xl break-words text-ui leading-6 text-foreground after:block after:h-24 after:content-['']">
			<Suspense fallback={<MarkdownFallback body={body} />}>
				<LazyStreamdown className="conversation-streamdown" mode="static">
					{body}
				</LazyStreamdown>
			</Suspense>
		</div>
	);
}

function MarkdownFallback({ body }: { body: string }) {
	return (
		<div className="conversation-streamdown whitespace-pre-wrap break-words">
			{body}
		</div>
	);
}

export function StatePill({
	state,
}: {
	state: NonNullable<ContextCard["state"]>;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 shrink-0 items-center rounded-full border border-current/25 px-2.5 text-small font-semibold leading-none",
				STATE_TONE_CLASS[state.tone],
			)}
		>
			{state.label}
		</span>
	);
}

export function parseExternalReference(externalId: string) {
	// GitHub uses `repo#NN`. GitLab uses `project#NN` (issues) or
	// `project!NN` (MRs). Accept either.
	const hashIdx = externalId.lastIndexOf("#");
	const bangIdx = externalId.lastIndexOf("!");
	const idx = Math.max(hashIdx, bangIdx);
	const number = idx === -1 ? "" : externalId.slice(idx + 1);
	const repo = idx === -1 ? externalId : externalId.slice(0, idx);
	return { repo, number };
}

export function formatRelativeTime(timestamp: number) {
	const deltaMs = Date.now() - timestamp;
	const minutes = Math.max(1, Math.round(deltaMs / 60_000));
	if (minutes < 60) return formatSource("countMAgo", { count: minutes });

	const hours = Math.round(minutes / 60);
	if (hours < 24) return formatSource("countHAgo", { count: hours });

	const days = Math.round(hours / 24);
	return formatSource("countDAgo", { count: days });
}
