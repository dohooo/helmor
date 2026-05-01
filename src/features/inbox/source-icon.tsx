import { GitPullRequest, MessageSquareText } from "lucide-react";
import {
	GithubBrandIcon,
	LinearBrandIcon,
	SlackBrandIcon,
} from "@/components/brand-icon";
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
			return <GithubBrandIcon className={className} size={size} />;
		case "github_pr":
			return (
				<GitPullRequest className={className} size={size} strokeWidth={2} />
			);
		case "github_discussion":
			return (
				<MessageSquareText className={className} size={size} strokeWidth={2} />
			);
		case "slack_thread":
			return <SlackBrandIcon className={className} size={size} />;
	}
}
