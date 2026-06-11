// The shell's context-provider stack: Tooltip → SelectionStore → WorkspaceToast
// → SessionRunStates → ComposerInsert, with the QuitConfirmDialog mounted as a
// sibling of WorkspaceToast inside the selection-store scope (it reads the same
// run-states map). Lifted verbatim out of AppShell's return wrapper so the
// whole layout can be assembled outside the AppShell function body. Provider
// nesting order is load-bearing and preserved exactly.
import type { ComponentProps, ReactNode } from "react";
import { QuitConfirmDialog } from "@/components/quit-confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ComposerInsertProvider } from "@/lib/composer-insert-context";
import { SessionRunStatesProvider } from "@/lib/session-run-state-context";
import { WorkspaceToastProvider } from "@/lib/workspace-toast-context";
import { SelectionStoreProvider } from "@/shell/controllers/selection-store-context";

type Props = {
	selectionStore: ComponentProps<typeof SelectionStoreProvider>["value"];
	pushWorkspaceToast: ComponentProps<typeof WorkspaceToastProvider>["value"];
	sessionRunStates: ComponentProps<typeof SessionRunStatesProvider>["value"];
	insertIntoComposer: ComponentProps<typeof ComposerInsertProvider>["value"];
	/** The quick panel opts out: only the main window confirms app quit. */
	showQuitConfirm?: boolean;
	children: ReactNode;
};

export function AppShellProviderStack({
	selectionStore,
	pushWorkspaceToast,
	sessionRunStates,
	insertIntoComposer,
	showQuitConfirm = true,
	children,
}: Props) {
	return (
		<TooltipProvider delayDuration={0}>
			<SelectionStoreProvider value={selectionStore}>
				<WorkspaceToastProvider value={pushWorkspaceToast}>
					<SessionRunStatesProvider value={sessionRunStates}>
						<ComposerInsertProvider value={insertIntoComposer}>
							{children}
						</ComposerInsertProvider>
					</SessionRunStatesProvider>
				</WorkspaceToastProvider>
				{showQuitConfirm && (
					<QuitConfirmDialog sessionRunStates={sessionRunStates} />
				)}
			</SelectionStoreProvider>
		</TooltipProvider>
	);
}
