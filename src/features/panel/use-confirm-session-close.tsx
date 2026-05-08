import type { QueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
	stopAgentStream,
	type WorkspaceDetail,
	type WorkspaceSessionSummary,
} from "@/lib/api";
import type { PushWorkspaceToast } from "@/lib/workspace-toast-context";
import { shouldConfirmRunningSessionClose } from "./close-guard";
import { RunningSessionCloseDialog } from "./running-session-close-dialog";
import { closeWorkspaceSession } from "./session-close";

// A single close request — captured in full at request time so the
// confirm handler never has to re-derive "which session did the user
// click close on?" from whatever is currently selected.
export type SessionCloseRequest = {
	workspace: WorkspaceDetail;
	sessions: WorkspaceSessionSummary[];
	session: WorkspaceSessionSummary;
	activateAdjacent?: boolean;
	// Display-provider override (from sessionDisplayProviders). Falls back
	// to `session.agentType` for label and stop call.
	provider?: string | null;
	onSessionsChanged?: () => void;
};

type UseConfirmSessionCloseOptions = {
	busySessionIds?: Set<string>;
	onSelectSession?: (sessionId: string) => void;
	onSessionHidden?: (sessionId: string, workspaceId: string) => void;
	pushToast: PushWorkspaceToast;
	queryClient: QueryClient;
};

type UseConfirmSessionCloseReturn = {
	requestClose: (request: SessionCloseRequest) => Promise<void>;
	dialogNode: ReactNode;
};

// Shared "close a session, prompt if it's running" flow. Mount the
// `dialogNode` once at the top of the tree; every close entry point
// (tab × button, Cmd+W, etc.) calls `requestClose` with the target
// session's full context.
export function useConfirmSessionClose({
	busySessionIds,
	onSelectSession,
	onSessionHidden,
	pushToast,
	queryClient,
}: UseConfirmSessionCloseOptions): UseConfirmSessionCloseReturn {
	const [pending, setPending] = useState<SessionCloseRequest | null>(null);
	const [loading, setLoading] = useState(false);

	const performClose = useCallback(
		async (request: SessionCloseRequest) => {
			await closeWorkspaceSession({
				queryClient,
				workspace: request.workspace,
				sessions: request.sessions,
				sessionId: request.session.id,
				activateAdjacent: request.activateAdjacent,
				onSelectSession,
				onSessionsChanged: request.onSessionsChanged,
				onSessionHidden,
				pushToast,
			});
		},
		[onSelectSession, onSessionHidden, pushToast, queryClient],
	);

	const requestClose = useCallback(
		async (request: SessionCloseRequest) => {
			if (shouldConfirmRunningSessionClose(request.session, busySessionIds)) {
				setPending(request);
				return;
			}
			await performClose(request);
		},
		[busySessionIds, performClose],
	);

	const handleConfirm = useCallback(async () => {
		const request = pending;
		if (!request) {
			return;
		}

		const provider = request.provider ?? request.session.agentType ?? undefined;

		setLoading(true);
		try {
			await stopAgentStream(request.session.id, provider ?? undefined);
		} catch (error) {
			pushToast(
				error instanceof Error ? error.message : String(error),
				"Unable to stop chat",
				"destructive",
			);
			setLoading(false);
			return;
		}

		setPending(null);
		setLoading(false);
		await performClose(request);
	}, [pending, performClose, pushToast]);

	const agentLabel = useMemo(() => {
		if (!pending) {
			return "Claude";
		}
		const provider = pending.provider ?? pending.session.agentType;
		if (provider === "codex") return "Codex";
		if (provider === "cursor") return "Cursor";
		return "Claude";
	}, [pending]);

	const dialogNode = (
		<RunningSessionCloseDialog
			open={pending !== null}
			agentLabel={agentLabel}
			loading={loading}
			onOpenChange={(open) => {
				if (loading || open) {
					return;
				}
				setPending(null);
			}}
			onConfirm={() => void handleConfirm()}
		/>
	);

	return { requestClose, dialogNode };
}
