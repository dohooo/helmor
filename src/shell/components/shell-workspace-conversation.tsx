// Workspace-surface conversation pane. Subscribes the four selection tracks
// (selected/displayed workspace + session) straight off the selection store
// instead of receiving them as flattened props from AppShell, then forwards
// everything else to `WorkspaceConversationContainer`. Moving just the
// delivery channel keeps an unrelated selection-field change from re-rendering
// the conversation via prop churn. The start-surface instance keeps rendering
// `WorkspaceConversationContainer` directly with `null` tracks (zero
// subscription), so the inner container retains its full prop contract.
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
	WorkspaceConversationContainer,
	type WorkspaceConversationContainerProps,
} from "@/features/conversation";
import { useSelectionStore } from "@/shell/controllers/selection-store-context";

type Props = Omit<
	WorkspaceConversationContainerProps,
	| "selectedWorkspaceId"
	| "displayedWorkspaceId"
	| "selectedSessionId"
	| "displayedSessionId"
>;

export function ShellWorkspaceConversation(props: Props) {
	// One `useShallow` subscription for all four tracks — never four
	// independent `useStore` calls, which would tear the two-track pairing
	// across renders. These are the same store fields AppShell read off its
	// `selection` snapshot; only the delivery channel moved.
	const {
		selectedWorkspaceId,
		displayedWorkspaceId,
		selectedSessionId,
		displayedSessionId,
	} = useStore(
		useSelectionStore(),
		useShallow((s) => ({
			selectedWorkspaceId: s.selectedWorkspaceId,
			displayedWorkspaceId: s.displayedWorkspaceId,
			selectedSessionId: s.selectedSessionId,
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
