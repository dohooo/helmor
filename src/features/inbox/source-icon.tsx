import { CircleDot, GitPullRequest, MessagesSquare } from "lucide-react";
import { LinearBrandIcon, SlackBrandIcon } from "@/components/brand-icon";
import type { ContextCardSource } from "@/lib/sources/types";

export function SourceIcon({
	source,
	className,
	size = 14,
}: {
	source: ContextCardSource;
	className?: string;
	size?: number;
}) {
	switch (source) {
		case "linear":
			return <LinearBrandIcon className={className} size={size} />;
		case "github_issue":
			return <CircleDot className={className} size={size} strokeWidth={2} />;
		case "github_pr":
			return (
				<GitPullRequest className={className} size={size} strokeWidth={2} />
			);
		case "github_discussion":
			return (
				<MessagesSquare className={className} size={size} strokeWidth={2} />
			);
		case "gitlab_issue":
			return <CircleDot className={className} size={size} strokeWidth={2} />;
		case "gitlab_mr":
			return (
				<GitPullRequest className={className} size={size} strokeWidth={2} />
			);
		case "slack_thread":
			return <SlackBrandIcon className={className} size={size} />;
	}
}
