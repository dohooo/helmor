import {
	GithubBrandIcon,
	GitlabBrandIcon,
	LarkBrandIcon,
	SlackBrandIcon,
} from "@/components/brand-icon";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Brand glyph + label for each triage source platform. Keyed by the
 *  `triageSourceType` wire value the backend writes on ai_triage rows
 *  (mirrors the fetcher `SOURCE` ids: "github" / "gitlab" / "slack" /
 *  "lark"). */
const SOURCE_META = {
	github: { label: "GitHub", Icon: GithubBrandIcon },
	gitlab: { label: "GitLab", Icon: GitlabBrandIcon },
	slack: { label: "Slack", Icon: SlackBrandIcon },
	lark: { label: "Lark", Icon: LarkBrandIcon },
} as const;

/** Resolve a triage source id to its brand metadata, or `null` when the
 *  source is absent / unrecognized (callers then fall back to the plain
 *  status dot). */
export function triageSourceMeta(sourceType: string | null | undefined) {
	if (!sourceType) {
		return null;
	}
	return SOURCE_META[sourceType as keyof typeof SOURCE_META] ?? null;
}

/**
 * Bottom-right avatar badge showing which platform an AI task was proposed
 * from. Replaces the red "proposal" status dot on triage rows — pinned to
 * the opposite (bottom-right) corner and a touch larger so the logo reads.
 * Renders nothing for unknown sources. Must live inside a `relative`
 * container (the workspace avatar root provides it).
 */
export function TriageSourceBadge({
	sourceType,
	className,
}: {
	sourceType: string | null | undefined;
	className?: string;
}) {
	const { f } = useI18n();
	const meta = triageSourceMeta(sourceType);
	if (!meta) {
		return null;
	}
	const { label, Icon } = meta;
	return (
		<span
			aria-label={f("AI proposal from {source} — open to review", {
				source: label,
			})}
			className={cn(
				"pointer-events-none absolute -right-1 -bottom-1 z-10 grid size-3 place-items-center rounded-full bg-sidebar ring-1 ring-sidebar",
				className,
			)}
		>
			<Icon size={10} className="text-foreground" />
		</span>
	);
}
