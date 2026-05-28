// In-app `lark-cli` connect modal. Actions: install / signIn. Post-close polls source-health for ~8s (token-write lag).

import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LarkBrandIcon } from "@/components/brand-icon";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import {
	getTriageSourceHealth,
	type LarkAuthAction,
	resizeLarkCliAuthTerminal,
	type ScriptEvent,
	spawnLarkCliAuthTerminal,
	stopLarkCliAuthTerminal,
	type TriageSourceHealth,
	writeLarkCliAuthTerminalStdin,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const POST_CLOSE_POLL_TIMEOUT_MS = 8000;
const POST_CLOSE_POLL_INTERVAL_MS = 1000;
const SOURCE_HEALTH_KEY = ["triageSourceHealth"] as const;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

async function detectLarkOkAfterClose(): Promise<TriageSourceHealth | null> {
	const startedAt = Date.now();
	let lastLark: TriageSourceHealth | null = null;
	while (Date.now() - startedAt < POST_CLOSE_POLL_TIMEOUT_MS) {
		try {
			const rows = await getTriageSourceHealth();
			lastLark = rows.find((r) => r.source === "lark") ?? null;
			if (lastLark?.state === "ok") return lastLark;
		} catch {
			// Probe failure (slow CLI / IPC blip) — keep polling.
		}
		if (Date.now() - startedAt >= POST_CLOSE_POLL_TIMEOUT_MS) break;
		await sleep(POST_CLOSE_POLL_INTERVAL_MS);
	}
	return lastLark;
}

export type LarkConnectDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	action: LarkAuthAction;
};

export function LarkConnectDialog({
	open,
	onOpenChange,
	action,
}: LarkConnectDialogProps) {
	const queryClient = useQueryClient();
	const termRef = useRef<TerminalHandle | null>(null);
	const instanceIdRef = useRef<string>("");
	const cleanedUpRef = useRef(false);

	const [instanceId, setInstanceId] = useState<string>("");

	useEffect(() => {
		if (!open) return;
		const id =
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `lark-connect-${Date.now()}`;
		instanceIdRef.current = id;
		cleanedUpRef.current = false;
		setInstanceId(id);
	}, [open]);

	const onOpenChangeRef = useRef(onOpenChange);

	const handleClose = useCallback(async () => {
		if (cleanedUpRef.current) return;
		cleanedUpRef.current = true;
		const id = instanceIdRef.current;
		if (id) {
			try {
				await stopLarkCliAuthTerminal(action, id);
			} catch {
				// Already exited / never spawned.
			}
		}
		const settled = await detectLarkOkAfterClose();
		void queryClient.invalidateQueries({ queryKey: SOURCE_HEALTH_KEY });
		if (settled?.state === "ok") {
			toast.success("Lark connected");
		}
	}, [action, queryClient]);

	useEffect(() => {
		onOpenChangeRef.current = (next) => {
			if (!next) {
				void handleClose();
			}
			onOpenChange(next);
		};
	}, [handleClose, onOpenChange]);

	useEffect(() => {
		if (!open || !instanceId) return;
		const id = requestAnimationFrame(() => {
			termRef.current?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [open, instanceId]);

	useEffect(() => {
		if (!open || !instanceId) return;
		let cancelled = false;
		void spawnLarkCliAuthTerminal(action, instanceId, (event: ScriptEvent) => {
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
					// Successful login → auto-dismiss. Non-zero → let the
					// user read the error before closing.
					if (event.code === 0) onOpenChangeRef.current(false);
					break;
				case "started":
					break;
			}
		}).catch((error) => {
			if (cancelled) return;
			const message =
				error instanceof Error ? error.message : "Unable to start lark-cli.";
			termRef.current?.write(`\r\n${message}\r\n`);
		});
		return () => {
			cancelled = true;
		};
	}, [open, action, instanceId]);

	const handleOpenChange = useCallback((next: boolean) => {
		onOpenChangeRef.current(next);
	}, []);

	const onTerminalData = useCallback(
		(data: string) => {
			const id = instanceIdRef.current;
			if (!id) return;
			void writeLarkCliAuthTerminalStdin(action, id, data);
		},
		[action],
	);

	const onTerminalResize = useCallback(
		(cols: number, rows: number) => {
			const id = instanceIdRef.current;
			if (!id) return;
			void resizeLarkCliAuthTerminal(action, id, cols, rows);
		},
		[action],
	);

	const titleSuffix = action === "install" ? "Install lark-cli" : "Sign in";

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="w-[640px] max-w-[calc(100vw-4rem)] gap-0 overflow-hidden p-0 sm:max-w-[640px]"
			>
				<DialogTitle className="sr-only">
					Connect Lark — {titleSuffix}
				</DialogTitle>
				<header className="flex h-10 items-center gap-2 border-b border-border/55 px-3">
					<div className="flex items-center gap-1.5 text-small font-medium text-foreground">
						<LarkBrandIcon size={12} />
						<span>Connect Lark</span>
						<span className="ml-1 text-muted-foreground/80">
							· {titleSuffix}
						</span>
					</div>
					<div className="ml-auto">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => handleOpenChange(false)}
							aria-label="Close"
							className={cn(
								"gap-1.5 px-2 text-muted-foreground hover:text-foreground",
							)}
						>
							<ShortcutDisplay hotkey="Escape" />
							<X className="size-3.5" strokeWidth={1.8} />
						</Button>
					</div>
				</header>
				<div className="bg-card">
					<TerminalOutput
						terminalRef={termRef}
						className="h-[360px]"
						detectLinks
						fontSize={12}
						lineHeight={1.35}
						padding="12px 0 12px 16px"
						onData={onTerminalData}
						onResize={onTerminalResize}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
