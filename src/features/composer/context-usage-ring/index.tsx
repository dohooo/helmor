import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import { setSessionContextUsage } from "@/lib/api";
import {
	claudeRichContextUsageQueryOptions,
	sessionContextUsageQueryOptions,
} from "@/lib/query-client";
import { CONTEXT_USAGE_AUTO_REVEAL_THRESHOLD } from "@/lib/settings";
import { cn } from "@/lib/utils";
import {
	isTrustedRich,
	parseClaudeRichMeta,
	parseStoredMeta,
	resolveContextUsageDisplay,
} from "./parse";
import { ContextUsagePopoverContent } from "./popover";

type Props = {
	sessionId: string;
	/** Provider's own session id (Claude UUID). Needed for the rich
	 *  fetch's `resume`. Null before the first turn. */
	providerSessionId: string | null;
	/** Workspace root; passed as `cwd` so the ad-hoc Query loads the
	 *  right project config. */
	cwd: string | null;
	/** Only Claude supports the rich hover breakdown. */
	agentType: "claude" | "codex" | "cursor" | null;
	/** Composer's current model id; used as the rich-fetch cache key. */
	composerModelId: string | null;
	alwaysShow: boolean;
	disabled?: boolean;
	className?: string;
};

const RING_SIZE = 18;
const RING_STROKE = 1.75;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUM = 2 * Math.PI * RING_RADIUS;
const HOVER_OPEN_DELAY_MS = 180;
const HOVER_CLOSE_DELAY_MS = 80;

// Baseline comes from DB; Claude rich details are fetched on hover.
export function ContextUsageRing({
	sessionId,
	providerSessionId,
	cwd,
	agentType,
	composerModelId,
	alwaysShow,
	disabled,
	className,
}: Props) {
	const { data: metaJson = null } = useQuery(
		sessionContextUsageQueryOptions(sessionId),
	);
	const baseline = useMemo(() => parseStoredMeta(metaJson), [metaJson]);

	const [open, setOpen] = useState(false);

	const isClaude = agentType === "claude";
	// No provider session means there is nothing useful to resume.
	const { data: richJson = null, isFetching: richFetching } = useQuery(
		claudeRichContextUsageQueryOptions({
			sessionId,
			providerSessionId,
			model: composerModelId,
			cwd,
			enabled:
				open &&
				isClaude &&
				composerModelId !== null &&
				providerSessionId !== null,
		}),
	);
	const rich = useMemo(() => parseClaudeRichMeta(richJson), [richJson]);

	const display = useMemo(
		() => resolveContextUsageDisplay(baseline, rich),
		[baseline, rich],
	);

	// Promote a trustworthy rich fetch back to the DB so cold starts
	// see the freshest numbers. The backend broadcasts
	// `ContextUsageChanged`, which invalidates the baseline query and
	// brings everyone in sync. Skip when baseline already matches.
	useEffect(() => {
		if (!isTrustedRich(rich)) return;
		if (
			baseline &&
			baseline.modelId === rich.modelId &&
			baseline.usedTokens === rich.usedTokens &&
			baseline.maxTokens === rich.maxTokens
		) {
			return;
		}
		void setSessionContextUsage(
			sessionId,
			JSON.stringify({
				modelId: rich.modelId,
				usedTokens: rich.usedTokens,
				maxTokens: rich.maxTokens,
				percentage: rich.percentage,
			}),
		);
	}, [rich, baseline, sessionId]);

	const visible =
		alwaysShow ||
		(display.kind === "full" &&
			display.percentage >= CONTEXT_USAGE_AUTO_REVEAL_THRESHOLD);
	if (!visible) return null;

	const ringPercentage = display.kind === "full" ? display.percentage : 0;
	const ringTier = display.kind === "full" ? display.tier : "default";
	const strokeColor =
		ringTier === "danger"
			? "stroke-destructive"
			: ringTier === "warning"
				? "stroke-amber-500"
				: "stroke-foreground/70";
	const offset = RING_CIRCUM * (1 - Math.min(100, ringPercentage) / 100);

	const ariaLabel =
		display.kind === "full"
			? `Context usage ${display.percentage.toFixed(0)}%`
			: "Context usage";

	return (
		<HoverCard
			open={open}
			onOpenChange={setOpen}
			openDelay={HOVER_OPEN_DELAY_MS}
			closeDelay={HOVER_CLOSE_DELAY_MS}
		>
			<HoverCardTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					aria-label={ariaLabel}
					className={cn(
						"flex size-7 cursor-pointer items-center justify-center rounded-md disabled:cursor-not-allowed disabled:opacity-50",
						className,
					)}
				>
					<svg
						width={RING_SIZE}
						height={RING_SIZE}
						viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
						aria-hidden
					>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							r={RING_RADIUS}
							fill="none"
							className="stroke-muted"
							strokeWidth={RING_STROKE}
						/>
						<circle
							cx={RING_SIZE / 2}
							cy={RING_SIZE / 2}
							r={RING_RADIUS}
							fill="none"
							className={cn(strokeColor, "transition-all")}
							strokeWidth={RING_STROKE}
							strokeLinecap="round"
							strokeDasharray={RING_CIRCUM}
							strokeDashoffset={offset}
							transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
						/>
					</svg>
				</button>
			</HoverCardTrigger>
			<HoverCardContent side="top" align="end" className="w-[280px]">
				<ContextUsagePopoverContent
					display={display}
					richLoading={isClaude && richFetching && rich === null}
				/>
			</HoverCardContent>
		</HoverCard>
	);
}
