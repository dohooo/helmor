import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { TerminalHandle } from "@/components/terminal-output";
import {
	type AgentLoginProvider,
	resizeAgentLoginTerminal,
	type ScriptEvent,
	spawnAgentLoginTerminal,
	stopAgentLoginTerminal,
	writeAgentLoginTerminalStdin,
} from "@/lib/api";
import { useI18n } from "@/lib/i18n";

export const providerLabels: Record<AgentLoginProvider, string> = {
	claude: "Claude Code",
	codex: "Codex",
	// Cursor never reaches the login terminal; here for the exhaustive Record.
	cursor: "Cursor",
	opencode: "OpenCode",
	kimi: "Kimi",
};

export function LoginTerminalPreview({
	provider,
	instanceId,
	active,
	onExit,
	onError,
	render,
}: {
	provider: AgentLoginProvider | null;
	instanceId: string | null;
	active: boolean;
	onExit: (code: number | null) => void;
	onError: (message: string) => void;
	render: (args: {
		title: string;
		terminalRef: RefObject<TerminalHandle | null>;
		onData: (data: string) => void;
		onResize: (cols: number, rows: number) => void;
	}) => React.ReactNode;
}) {
	const { t } = useI18n();
	const termRef = useRef<TerminalHandle | null>(null);
	const resolvedProvider = provider ?? "codex";

	// Keep onExit/onError out of the spawn effect's deps to avoid tear-down/respawn.
	const onExitRef = useRef(onExit);
	const onErrorRef = useRef(onError);
	useEffect(() => {
		onExitRef.current = onExit;
		onErrorRef.current = onError;
	}, [onExit, onError]);

	// RAF-deferred focus so the height transition + xterm textarea attach finish first.
	useEffect(() => {
		if (!active || !provider || !instanceId) return;
		const id = requestAnimationFrame(() => {
			termRef.current?.focus();
		});
		return () => cancelAnimationFrame(id);
	}, [active, provider, instanceId]);

	useEffect(() => {
		if (!active || !provider || !instanceId) return;

		let cancelled = false;
		const replay = () => {
			termRef.current?.clear();
			termRef.current?.refit();
		};

		if (termRef.current) replay();
		else requestAnimationFrame(replay);

		void spawnAgentLoginTerminal(provider, instanceId, (event: ScriptEvent) => {
			if (cancelled) return;
			switch (event.type) {
				case "stdout":
				case "stderr":
					termRef.current?.write(event.data);
					break;
				case "error":
					termRef.current?.write(`\r\n${event.message}\r\n`);
					onErrorRef.current(event.message);
					break;
				case "exited":
					onExitRef.current(event.code);
					break;
				case "started":
					break;
			}
		}).catch((error) => {
			if (cancelled) return;
			const message =
				error instanceof Error ? error.message : t("miscUnableToStartLogin");
			termRef.current?.write(`\r\n${message}\r\n`);
			onErrorRef.current(message);
		});

		return () => {
			cancelled = true;
			void stopAgentLoginTerminal(provider, instanceId);
		};
	}, [active, provider, instanceId]);

	const handleData = useCallback(
		(data: string) => {
			if (!provider || !instanceId) return;
			void writeAgentLoginTerminalStdin(provider, instanceId, data);
		},
		[provider, instanceId],
	);

	const handleResize = useCallback(
		(cols: number, rows: number) => {
			if (!provider || !instanceId) return;
			void resizeAgentLoginTerminal(provider, instanceId, cols, rows);
		},
		[provider, instanceId],
	);

	return render({
		title: `${providerLabels[resolvedProvider]} ${t("login")}`,
		terminalRef: termRef,
		onData: handleData,
		onResize: handleResize,
	});
}
