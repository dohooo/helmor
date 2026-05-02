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
	return (
		<div className="flex h-full min-h-0 flex-col bg-sidebar">
			<div className="flex h-8 shrink-0 items-center border-border/60 border-b bg-muted/25 px-3">
				<h2 className="text-[13px] font-medium leading-8 tracking-[-0.01em] text-muted-foreground">
					Context
				</h2>
			</div>
			<InboxSidebar
				className="flex min-h-0 flex-1 bg-sidebar"
				onOpenCard={onOpenCard}
				selectedCardId={selectedCardId}
				repoFilter={parseGithubRepoFilter(repository)}
				providerTab={
					inboxProviderTab as Parameters<typeof InboxSidebar>[0]["providerTab"]
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
