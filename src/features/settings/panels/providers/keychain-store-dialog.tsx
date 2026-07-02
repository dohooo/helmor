// In-app terminal dialog that stores the Vertex gateway token in macOS
// Keychain. On open it spawns `security add-generic-password -s … -a … -U -w`
// pre-typed in an embedded PTY; the user pastes the token at the prompt and
// the secret goes straight into Keychain without passing through Helmor.
// Modeled on `forge-connect-dialog` (same Dialog + TerminalOutput shell).

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	resizeKeychainStoreTerminal,
	type ScriptEvent,
	spawnKeychainStoreTerminal,
	stopKeychainStoreTerminal,
	writeKeychainStoreTerminalStdin,
} from "@/lib/api";
import { I18nText, useI18n } from "@/lib/i18n";

export function KeychainStoreDialog({
	open,
	onOpenChange,
	service,
	account,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	service: string;
	account: string;
}) {
	const { t } = useI18n();
	const termRef = useRef<TerminalHandle | null>(null);
	// Fresh PTY per open; also keys the backend session.
	const [instanceId, setInstanceId] = useState<string | null>(null);

	// Keep the latest close handler out of the spawn effect's deps.
	const onOpenChangeRef = useRef(onOpenChange);
	useEffect(() => {
		onOpenChangeRef.current = onOpenChange;
	}, [onOpenChange]);

	useEffect(() => {
		if (!open) {
			setInstanceId(null);
			return;
		}
		setInstanceId(crypto.randomUUID());
	}, [open]);

	useEffect(() => {
		if (!open || !instanceId) return;

		let cancelled = false;
		const replay = () => {
			termRef.current?.clear();
			termRef.current?.refit();
			termRef.current?.focus();
		};
		if (termRef.current) replay();
		else requestAnimationFrame(replay);

		void spawnKeychainStoreTerminal(
			service,
			account,
			instanceId,
			(event: ScriptEvent) => {
				if (cancelled) return;
				switch (event.type) {
					case "stdout":
					case "stderr":
						termRef.current?.write(event.data);
						break;
					case "error":
						termRef.current?.write(`\r\n${event.message}\r\n`);
						break;
					case "exited":
						// `security` exits 0 once the token is written; the shell
						// then exits via the boot input's trailing `; exit`.
						if (event.code === 0) {
							toast.success(t("vertexKeychainStored"));
							onOpenChangeRef.current(false);
						}
						break;
					case "started":
						break;
				}
			},
		).catch((error) => {
			if (cancelled) return;
			const message = error instanceof Error ? error.message : String(error);
			termRef.current?.write(`\r\n${message}\r\n`);
		});

		return () => {
			cancelled = true;
			void stopKeychainStoreTerminal(instanceId);
		};
	}, [open, instanceId, service, account, t]);

	const onData = useCallback(
		(data: string) => {
			if (!instanceId) return;
			void writeKeychainStoreTerminalStdin(instanceId, data);
		},
		[instanceId],
	);
	const onResize = useCallback(
		(cols: number, rows: number) => {
			if (!instanceId) return;
			void resizeKeychainStoreTerminal(instanceId, cols, rows);
		},
		[instanceId],
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="w-[640px] max-w-[calc(100vw-4rem)] gap-0 overflow-hidden p-0 sm:max-w-[640px]"
			>
				<DialogTitle className="sr-only">
					<I18nText source="vertexKeychainDialogTitle" />
				</DialogTitle>
				<header className="flex h-10 items-center gap-2 border-b border-border/55 px-3">
					<div className="flex min-w-0 items-center gap-1.5 text-small font-medium text-foreground">
						<span className="truncate">
							<I18nText source="vertexKeychainDialogTitle" />
						</span>
					</div>
					<div className="ml-auto">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onOpenChange(false)}
							aria-label="close"
							className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
						>
							<ShortcutDisplay hotkey="Escape" />
							<X className="size-3.5" strokeWidth={1.8} />
						</Button>
					</div>
				</header>
				<p className="border-b border-border/55 px-3 py-2 text-[12px] text-muted-foreground">
					<I18nText source="vertexKeychainDialogHint" />
				</p>
				<div className="bg-card">
					<TerminalOutput
						terminalRef={termRef}
						className="h-[280px]"
						fontSize={12}
						lineHeight={1.35}
						padding="12px 0 12px 16px"
						onData={onData}
						onResize={onResize}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
