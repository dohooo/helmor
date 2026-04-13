import { MessageSquareText } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";

export function EmptyState({ hasSession }: { hasSession: boolean }) {
	return (
		<Empty className="max-w-sm">
			<EmptyHeader>
				<EmptyMedia className="mb-1 text-app-foreground-soft/72 [&_svg:not([class*='size-'])]:size-7">
					<MessageSquareText strokeWidth={1.7} />
				</EmptyMedia>
				<EmptyTitle>
					{hasSession ? "Nothing here yet" : "No session selected"}
				</EmptyTitle>
				<EmptyDescription>
					{hasSession
						? "This session does not have any messages yet."
						: "Choose a session from the header to inspect its timeline."}
				</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}
