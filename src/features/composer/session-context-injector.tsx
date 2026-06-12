import {
	ClaudeIcon,
	CursorIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import type { SessionContextCandidate } from "@/features/panel/session-context";
import type { AgentProvider } from "@/lib/api";
import { cn } from "@/lib/utils";

type SessionContextInjectorProps = {
	candidates: readonly SessionContextCandidate[];
	selectedSessionIds: readonly string[];
	onToggleSession: (sessionId: string) => void;
};

export function SessionContextInjector({
	candidates,
	selectedSessionIds,
	onToggleSession,
}: SessionContextInjectorProps) {
	if (candidates.length === 0) return null;

	const selected = new Set(selectedSessionIds);

	return (
		<div className="pointer-events-auto mb-2 flex w-full items-center gap-2 self-start">
			<span className="shrink-0 text-small font-medium leading-none text-foreground/70">
				Inject sessions:
			</span>
			<div className="flex min-w-0 flex-1 flex-nowrap items-center justify-start gap-1 overflow-x-auto overscroll-x-contain">
				{candidates.map((session) => {
					const isSelected = selected.has(session.id);
					const title = session.title?.trim() || "Untitled";

					return (
						<button
							key={session.id}
							type="button"
							aria-pressed={isSelected}
							title={title}
							onClick={() => onToggleSession(session.id)}
							className={cn(
								"grid h-6 max-w-[15rem] shrink-0 cursor-interactive grid-cols-[0.75rem_minmax(0,1fr)] items-center gap-1 rounded-md border py-0 pl-2 pr-1.5 text-small leading-none transition-[background-color,border-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
								isSelected
									? "border-primary bg-primary text-primary-foreground shadow-xs"
									: "border-border/70 bg-transparent text-muted-foreground hover:border-border hover:bg-muted/45 hover:text-foreground",
							)}
						>
							<SessionProviderIcon
								provider={session.displayProvider}
								className={cn(
									"size-3 shrink-0",
									isSelected
										? "text-primary-foreground/80"
										: "text-muted-foreground",
								)}
							/>
							<span className="flex min-w-0 items-center truncate text-left leading-none">
								{title}
							</span>
						</button>
					);
				})}
			</div>
		</div>
	);
}

function SessionProviderIcon({
	provider,
	className,
}: {
	provider: AgentProvider | null;
	className?: string;
}) {
	if (provider === "codex") {
		return <OpenAIIcon className={className} />;
	}
	if (provider === "cursor") {
		return <CursorIcon className={className} />;
	}
	if (provider === "opencode") {
		return <OpenCodeIcon className={className} />;
	}
	return <ClaudeIcon className={className} />;
}
