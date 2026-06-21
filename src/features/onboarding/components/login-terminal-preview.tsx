import { X } from "lucide-react";
import type { RefObject } from "react";
import { LoginTerminalPreview as LoginTerminalCore } from "@/components/agent-login/login-terminal";
import {
	type TerminalHandle,
	TerminalOutput,
} from "@/components/terminal-output";
import type { AgentLoginProvider } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function OnboardingTerminalPreview({
	title,
	active,
	className,
	heightClassName = "h-[340px]",
	terminalClassName = "h-[300px]",
	panelClassName,
	onData,
	onResize,
	onClose,
	terminalRef,
	padding = "16px 0 72px 20px",
}: {
	title: string;
	active: boolean;
	className?: string;
	heightClassName?: string;
	terminalClassName?: string;
	panelClassName?: string;
	onData?: (data: string) => void;
	onResize?: (cols: number, rows: number) => void;
	/** When provided, the leftmost macOS-style dot becomes a real
	 *  "close" button (red on hover with an `×` mark). */
	onClose?: () => void;
	terminalRef: RefObject<TerminalHandle | null>;
	padding?: string;
}) {
	const { t } = useI18n();
	return (
		<div
			aria-hidden={!active}
			className={cn(
				"absolute top-1/2 right-0 w-[520px] -translate-y-1/2 transition-all duration-700 ease-[cubic-bezier(.22,.82,.2,1)]",
				active
					? "translate-x-0 opacity-100"
					: "pointer-events-none translate-x-[calc(100%+5rem)] opacity-0",
				className,
			)}
		>
			<div
				className={cn(
					"overflow-hidden rounded-xl border border-border/60 bg-card shadow-2xl shadow-black/15",
					heightClassName,
					panelClassName,
				)}
			>
				<div className="flex h-10 items-center gap-2 border-b border-border/55 bg-background px-4">
					{onClose ? (
						// Hover scoped to the close circle itself —
						// landing on the title bar elsewhere shouldn't
						// flash the × in (felt twitchy in testing).
						<button
							type="button"
							onClick={onClose}
							aria-label={t("closeLoginTerminal")}
							className="group/close grid size-2.5 cursor-interactive place-items-center rounded-full bg-muted-foreground/35 leading-none transition-colors hover:bg-status-danger"
						>
							<X
								strokeWidth={4.5}
								className="size-[7px] text-black/0 group-hover/close:text-black/85"
							/>
						</button>
					) : (
						<span className="size-2.5 rounded-full bg-muted-foreground/35" />
					)}
					<span className="size-2.5 rounded-full bg-muted-foreground/25" />
					<span className="size-2.5 rounded-full bg-muted-foreground/20" />
					<span className="ml-2 text-small font-medium text-muted-foreground">
						{title}
					</span>
				</div>
				<TerminalOutput
					terminalRef={terminalRef}
					className={terminalClassName}
					detectLinks
					fontSize={12}
					lineHeight={1.35}
					padding={padding}
					onData={onData}
					onResize={onResize}
				/>
			</div>
		</div>
	);
}

export function LoginTerminalPreview({
	provider,
	instanceId,
	active,
	onExit,
	onError,
	onClose,
}: {
	provider: AgentLoginProvider | null;
	instanceId: string | null;
	active: boolean;
	onExit: (code: number | null) => void;
	onError: (message: string) => void;
	onClose?: () => void;
}) {
	return (
		<LoginTerminalCore
			provider={provider}
			instanceId={instanceId}
			active={active}
			onExit={onExit}
			onError={onError}
			render={({ title, terminalRef, onData, onResize }) => (
				<OnboardingTerminalPreview
					title={title}
					active={active}
					terminalRef={terminalRef}
					onData={onData}
					onResize={onResize}
					onClose={onClose}
				/>
			)}
		/>
	);
}
