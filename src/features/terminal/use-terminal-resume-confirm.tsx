import { type ReactNode, useCallback, useState } from "react";
import { useSettings } from "@/lib/settings";
import { TerminalResumeDialog } from "./terminal-resume-dialog";

const PROVIDER_LABELS: Record<string, string> = {
	claude: "Claude",
	codex: "Codex",
};

type PendingResume = { provider: string; run: () => void };

type UseTerminalResumeConfirmReturn = {
	/** Gate `run` behind the heads-up dialog. Runs immediately when the user has
	 *  opted out via "don't remind again". */
	confirmResume: (provider: string, run: () => void) => void;
	dialogNode: ReactNode;
};

/** Heads-up confirmation for sending a conversation-with-history to the terminal:
 *  it opens a NEW Terminal session that resumes the chat, and TUI messages don't
 *  sync back. Mount `dialogNode` once near the top of the tree (mirrors
 *  `useConfirmSessionClose`); call `confirmResume` from the terminal-send path. */
export function useTerminalResumeConfirm(): UseTerminalResumeConfirmReturn {
	const { settings, updateSettings } = useSettings();
	const [pending, setPending] = useState<PendingResume | null>(null);
	const [dontRemind, setDontRemind] = useState(false);

	const confirmResume = useCallback(
		(provider: string, run: () => void) => {
			if (settings.suppressTerminalResumeWarning) {
				run();
				return;
			}
			setPending({ provider, run });
		},
		[settings.suppressTerminalResumeWarning],
	);

	const close = useCallback(() => {
		setPending(null);
		setDontRemind(false);
	}, []);

	const dialogNode = (
		<TerminalResumeDialog
			open={pending !== null}
			providerLabel={
				(pending && PROVIDER_LABELS[pending.provider]) || "the agent"
			}
			dontRemind={dontRemind}
			onDontRemindChange={setDontRemind}
			onOpenChange={(open) => {
				if (!open) close();
			}}
			onConfirm={() => {
				const run = pending?.run;
				if (dontRemind) {
					void updateSettings({ suppressTerminalResumeWarning: true });
				}
				close();
				run?.();
			}}
		/>
	);

	return { confirmResume, dialogNode };
}
