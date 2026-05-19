import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Clock3, Copy, ExternalLink } from "lucide-react";
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
import type { ComposerInsertTarget } from "@/lib/composer-insert";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";

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
}: {
	card: ContextCard;
	appendContextTarget?: ComposerInsertTarget;
	description?: string;
	isLoading?: boolean;
	error?: Error | null;
	kindLabel: string;
}) {
	const reference = parseExternalReference(card.externalId);
	const markdownBody = description?.trim() || "No description provided.";

	return (
		<article className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto px-4 [contain:content] [scrollbar-gutter:stable]">
			<header className="shrink-0 py-1.5">
				<div className="flex min-w-0 items-center justify-between gap-4">
					<div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
						{card.state ? <StatePill state={card.state} /> : null}
						<span className="font-medium text-foreground/80">
							{reference.repo}
						</span>
						<span className="inline-flex items-center gap-1 font-normal text-muted-foreground/70">
							<SourceIcon source={card.source} size={13} className="shrink-0" />
							{kindLabel}
						</span>
						<span className="inline-flex items-center gap-1 font-normal text-muted-foreground/70">
							<Clock3 className="size-[13px]" strokeWidth={1.8} />
							Updated {formatRelativeTime(card.lastActivityAt)}
						</span>
					</div>
					<SourceDetailActions
						card={card}
						appendContextTarget={appendContextTarget}
						markdownBody={markdownBody}
						copyDisabled={isLoading || Boolean(error)}
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
}: {
	card: ContextCard;
	appendContextTarget?: ComposerInsertTarget;
	markdownBody: string;
	copyDisabled?: boolean;
}) {
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
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="Open externally"
						onClick={() => void openUrl(card.externalUrl)}
						className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
					>
						<ExternalLink className="size-[13px]" strokeWidth={1.8} />
					</Button>
				</TooltipTrigger>
				<TooltipContent side="top">Open externally</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex" aria-label="Add to context">
						<AppendContextButton
							subjectLabel={card.title}
							ariaLabel="Add to context"
							getPayload={() =>
								buildCardContextPayload(card, appendContextTarget)
							}
							errorTitle="Couldn't insert context card"
							className="size-7 cursor-interactive rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground [&_svg]:size-[13px]"
						/>
					</span>
				</TooltipTrigger>
				<TooltipContent side="top">Add to context</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label="Copy markdown"
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
					{copied ? "Copied" : "Copy markdown"}
				</TooltipContent>
			</Tooltip>
		</div>
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
		<div className="text-center text-[13px] text-muted-foreground">
			{error.message}
		</div>
	);
}

function MarkdownBody({ body }: { body: string }) {
	return (
		<div className="conversation-markdown max-w-3xl break-words text-[13px] leading-6 text-foreground after:block after:h-24 after:content-['']">
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
				"inline-flex h-6 shrink-0 items-center rounded-full border border-current/25 px-2.5 text-[12px] font-semibold leading-none",
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
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	const days = Math.round(hours / 24);
	return `${days}d ago`;
}
