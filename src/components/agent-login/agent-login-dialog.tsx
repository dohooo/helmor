// Centered modal hosting the agent-login PTY (claude / codex / opencode).
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	ClaudeColorIcon,
	KimiIcon,
	MiMoCodeIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import { TerminalOutput } from "@/components/terminal-output";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ShortcutDisplay } from "@/features/shortcuts/shortcut-display";
import type { AgentLoginProvider } from "@/lib/api";
import {
	LoginTerminalPreview as LoginTerminalCore,
	providerLabels,
} from "./login-terminal";

function providerIcon(provider: AgentLoginProvider) {
	const className = "size-3.5";
	if (provider === "claude") return <ClaudeColorIcon className={className} />;
	if (provider === "opencode")
		return <OpenCodeIcon className={`${className} text-foreground`} />;
	if (provider === "kimi")
		return <KimiIcon className={`${className} text-foreground`} />;
	if (provider === "mimo")
		return <MiMoCodeIcon className={`${className} text-foreground`} />;
	return <OpenAIIcon className={`${className} text-foreground`} />;
}

export function AgentLoginDialog({
	open,
	onOpenChange,
	provider,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	provider: AgentLoginProvider;
}) {
	// Fresh instance id each open: backend keys PTYs by it.
	const [instanceId, setInstanceId] = useState<string>("");
	useEffect(() => {
		if (!open) return;
		setInstanceId(
			typeof crypto !== "undefined" && "randomUUID" in crypto
				? crypto.randomUUID()
				: `agent-login-${Date.now()}`,
		);
	}, [open]);

	// Exit 0 closes; non-zero stays open so the error is readable.
	const handleExit = useCallback(
		(code: number | null) => {
			if (code === 0) onOpenChange(false);
		},
		[onOpenChange],
	);

	const handleError = useCallback(() => {}, []);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				showCloseButton={false}
				className="w-[640px] max-w-[calc(100vw-4rem)] gap-0 overflow-hidden p-0 sm:max-w-[640px]"
			>
				<DialogTitle className="sr-only">
					{providerLabels[provider]} login
				</DialogTitle>
				{open && instanceId ? (
					<LoginTerminalCore
						provider={provider}
						instanceId={instanceId}
						active={open}
						onExit={handleExit}
						onError={handleError}
						render={({ title, terminalRef, onData, onResize }) => (
							<>
								<header className="flex h-10 items-center gap-2 border-b border-border/55 px-3">
									<div className="flex items-center gap-1.5 text-small font-medium text-foreground">
										{providerIcon(provider)}
										<span>{title}</span>
									</div>
									<div className="ml-auto">
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() => onOpenChange(false)}
											aria-label="Close"
											className="gap-1.5 px-2 text-muted-foreground hover:text-foreground"
										>
											<ShortcutDisplay hotkey="Escape" />
											<X className="size-3.5" strokeWidth={1.8} />
										</Button>
									</div>
								</header>
								<div className="bg-card">
									<TerminalOutput
										terminalRef={terminalRef}
										className="h-[360px]"
										detectLinks
										fontSize={12}
										lineHeight={1.35}
										padding="12px 0 12px 16px"
										onData={onData}
										onResize={onResize}
									/>
								</div>
							</>
						)}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
