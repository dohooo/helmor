// Workspace-surface conversation pane. Stage 3b: the `selected*` tracks come
// from the ROUTER (the source of truth for navigation intent), the `displayed*`
// paint tracks stay in the selection store. Both `displayed*` reads share ONE
// `useShallow` subscription so the two-track pairing is never torn across
// renders. Moving the delivery channel (router for selected, store for
// displayed) keeps an unrelated field change from re-rendering the conversation
// via prop churn. The start-surface instance keeps rendering
// `WorkspaceConversationContainer` directly with `null` tracks (zero
// subscription), so the inner container retains its full prop contract.
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
	WorkspaceConversationContainer,
	type WorkspaceConversationContainerProps,
} from "@/features/conversation";
import { useRouterSelection } from "@/router/use-router-selection";
import { useSelectionStore } from "@/shell/controllers/selection-store-context";

type Props = Omit<
	WorkspaceConversationContainerProps,
	| "selectedWorkspaceId"
	| "displayedWorkspaceId"
	| "selectedSessionId"
	| "displayedSessionId"
>;

export function ShellWorkspaceConversation(props: Props) {
	// `selected*` from the router (structurally shared → stable identity).
	const { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId } =
		useRouterSelection();
	// `displayed*` from the store — ONE `useShallow` subscription for both, never
	// two independent `useStore` calls, which would tear the pairing.
	const { displayedWorkspaceId, displayedSessionId } = useStore(
		useSelectionStore(),
		useShallow((s) => ({
			displayedWorkspaceId: s.displayedWorkspaceId,
			displayedSessionId: s.displayedSessionId,
		})),
	);

	return (
		<WorkspaceConversationContainer
			{...props}
			selectedWorkspaceId={selectedWorkspaceId}
			displayedWorkspaceId={displayedWorkspaceId}
			selectedSessionId={selectedSessionId}
			displayedSessionId={displayedSessionId}
		/>
	);
}
