import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { requestQuit } from "@/lib/api";
import type { SessionRunState } from "@/lib/session-run-state";

export function QuitConfirmDialog({
	sessionRunStates,
}: {
	sessionRunStates: ReadonlyMap<string, SessionRunState>;
}) {
	const [open, setOpen] = useState(false);
	const runningRef = useRef(sessionRunStates);
	runningRef.current = sessionRunStates;

	const handleQuit = useCallback(async (force: boolean) => {
		setOpen(false);
		await requestQuit(force);
	}, []);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;

		// Rust intercepts every OS-level exit path (close button, Cmd+Q,
		// app-menu Quit, programmatic ExitRequested) and emits this
		// event. We're the only gate that knows about in-flight tasks.
		void listen("helmor://quit-requested", () => {
			if (runningRef.current.size === 0) {
				void requestQuit(false);
				return;
			}
			setOpen(true);
		}).then((fn) => {
			if (disposed) {
				fn();
				return;
			}
			unlisten = fn;
		});

		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	const count = sessionRunStates.size;

	return (
		<ConfirmDialog
			open={open}
			onOpenChange={setOpen}
			title="Quit Helmor?"
			description={
				count === 1
					? "There is 1 task in progress. Quitting now will cancel it."
					: `There are ${count} tasks in progress. Quitting now will cancel them.`
			}
			confirmLabel="Quit anyway"
			onConfirm={() => void handleQuit(true)}
		/>
	);
}
