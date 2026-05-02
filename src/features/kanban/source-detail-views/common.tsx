import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, Clock3 } from "lucide-react";
import { Suspense } from "react";
import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import { STATE_TONE_CLASS } from "@/features/inbox/state-tone";
import type { ContextCard } from "@/lib/sources/types";
import { cn } from "@/lib/utils";

export type SourceDetailProps = {
	card: ContextCard;
};

export function GitHubDetailPage({
	card,
	description,
	isLoading,
	error,
	kindLabel,
}: {
	card: ContextCard;
	description?: string;
	isLoading?: boolean;
	error?: Error | null;
	kindLabel: string;
}) {
	const reference = parseExternalReference(card.externalId);

	return (
		<article className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-y-auto pr-1">
			<header className="shrink-0 border-b border-border/70 pb-4">
				<div className="flex min-w-0 items-start justify-between gap-4">
					<div className="min-w-0 flex-1">
						<h2 className="min-w-0 text-balance text-[24px] font-semibold leading-8 text-foreground">
							{card.title}
							<span className="ml-2 font-normal text-muted-foreground">
								#{reference.number}
							</span>
						</h2>
						<div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
							{card.state ? <StatePill state={card.state} /> : null}
							<span className="font-medium text-foreground/80">
								{reference.repo}
							</span>
							<span className="text-muted-foreground/70">{kindLabel}</span>
							<span className="inline-flex items-center gap-1 text-muted-foreground/80">
								<Clock3 className="size-3.5" strokeWidth={1.8} />
								Updated {formatRelativeTime(card.lastActivityAt)}
							</span>
						</div>
					</div>

					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => void openUrl(card.externalUrl)}
						className="h-7 shrink-0 cursor-pointer gap-1 px-2 text-[12px]"
					>
						<ArrowUpRight className="size-3" strokeWidth={1.8} />
						Open
					</Button>
				</div>
			</header>

			<div
				className={cn(
					"min-h-0 flex-1",
					isLoading || error ? "flex items-center justify-center" : "py-5",
				)}
			>
				{isLoading ? (
					<DetailLoadingState />
				) : error ? (
					<DetailErrorState error={error} />
				) : (
					<MarkdownBody
						body={description?.trim() || "No description provided."}
					/>
				)}
			</div>
		</article>
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
		<div className="conversation-markdown max-w-3xl break-words text-[13px] leading-6 text-foreground">
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
	const idx = externalId.lastIndexOf("#");
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
