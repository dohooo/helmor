import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentLoginProvider } from "@/lib/api";
import { AgentStatusAction } from "../components/agent-status-action";
import { CursorApiKeyAction } from "../components/cursor-api-key-action";
import { LoginTerminalPreview } from "../components/login-terminal-preview";
import { ReadyStatus } from "../components/ready-status";
import type { AgentLoginItem, OnboardingStep } from "../types";

export function AgentLoginStep({
	step,
	loginItems,
	onBack,
	onNext,
	onRefreshLoginItems,
}: {
	step: OnboardingStep;
	loginItems: AgentLoginItem[];
	onBack: () => void;
	onNext: () => void;
	onRefreshLoginItems: () => void;
}) {
	const [primedLoginProvider, setPrimedLoginProvider] =
		useState<AgentLoginProvider | null>(null);
	const [activeLoginProvider, setActiveLoginProvider] =
		useState<AgentLoginProvider | null>(null);
	const [loginInstanceId, setLoginInstanceId] = useState<string | null>(null);
	const [waitingProvider, setWaitingProvider] =
		useState<AgentLoginProvider | null>(null);
	const [cursorKeyError, setCursorKeyError] = useState<string | null>(null);
	const terminalProvider = activeLoginProvider ?? primedLoginProvider;
	const terminalActive = activeLoginProvider !== null;

	const startLogin = useCallback((provider: AgentLoginProvider) => {
		// Cursor uses an API key, not a CLI login terminal.
		if (provider === "cursor") return;
		setPrimedLoginProvider(provider);
		setActiveLoginProvider(provider);
		setWaitingProvider(provider);
		setLoginInstanceId(crypto.randomUUID());
	}, []);

	const handleTerminalExit = useCallback(
		(code: number | null) => {
			onRefreshLoginItems();
			if (code !== 0) {
				setWaitingProvider((current) =>
					current === activeLoginProvider ? null : current,
				);
			}
		},
		[activeLoginProvider, onRefreshLoginItems],
	);

	const handleTerminalError = useCallback(() => {
		setWaitingProvider(null);
	}, []);

	/// Bail out of the in-progress login. `setActiveLoginProvider(null)`
	/// triggers `LoginTerminalPreview`'s effect cleanup, which kills
	/// the spawned PTY via `stopAgentLoginTerminal`.
	const handleAbortLogin = useCallback(() => {
		setActiveLoginProvider(null);
		setLoginInstanceId(null);
		setWaitingProvider(null);
	}, []);

	return (
		<section
			aria-label="Agent login"
			aria-hidden={step !== "agents"}
			className={`absolute inset-x-0 top-[calc(50vh-40px)] z-20 flex origin-top flex-col items-center px-8 pb-12 pt-8 transition-transform duration-1000 ease-[cubic-bezier(.22,.82,.2,1)] ${
				step === "corner"
					? "pointer-events-none -translate-x-[50vw] translate-y-[126vh] opacity-100"
					: step === "agents"
						? "translate-x-0 translate-y-0 scale-100 opacity-100"
						: "pointer-events-none translate-x-[22vw] translate-y-[64vh] scale-[0.7] opacity-100"
			}`}
		>
			<div className="relative w-full max-w-[1180px]">
				<div
					className={`transition-all duration-700 ease-[cubic-bezier(.22,.82,.2,1)] ${
						terminalActive
							? "ml-0 w-1/2 max-w-[540px]"
							: "ml-[230px] w-full max-w-[720px]"
					}`}
				>
					<h2 className="text-3xl font-semibold tracking-normal text-foreground">
						Log in to your agents
					</h2>
					<p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
						Helmor uses your local Claude Code and Codex login sessions. You can
						log in now, or continue and log in later.
					</p>

					{/* h-13 (~52px) keeps three tiles + Back/Next inside the
					    step container at ~720–820px laptop viewports. */}
					<div className="mt-6 flex w-full flex-col gap-2">
						{loginItems.map(
							({ icon: Icon, provider, label, description, status }) => {
								const subLabel =
									provider === "cursor" && cursorKeyError
										? `Couldn't validate key: ${cursorKeyError}`
										: description;
								const subLabelTone =
									provider === "cursor" && cursorKeyError
										? "text-destructive/90"
										: "text-muted-foreground/85";
								return (
									<div
										key={label}
										className="flex h-13 items-center gap-3 rounded-lg border border-border/45 bg-card/80 px-3"
									>
										<div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/40 bg-background text-foreground">
											<Icon className="size-4" />
										</div>
										<div className="flex min-w-0 flex-1 items-baseline gap-2">
											<span className="truncate text-[13px] font-medium leading-none text-foreground">
												{label}
											</span>
											<span
												className={`truncate text-[11px] leading-none ${subLabelTone}`}
											>
												{subLabel}
											</span>
										</div>
										{provider === "cursor" ? (
											status === "ready" ? (
												<ReadyStatus />
											) : (
												<CursorApiKeyAction
													onSaved={onRefreshLoginItems}
													onError={setCursorKeyError}
												/>
											)
										) : (
											<AgentStatusAction
												provider={provider}
												status={status}
												waiting={waitingProvider === provider}
												onPrimeLogin={setPrimedLoginProvider}
												onStartLogin={startLogin}
											/>
										)}
									</div>
								);
							},
						)}
					</div>

					<div className="mt-6 flex items-center gap-3">
						<Button
							type="button"
							variant="ghost"
							size="lg"
							onClick={onBack}
							className="h-10 gap-2 px-4 text-[0.95rem]"
						>
							<ArrowLeft data-icon="inline-start" className="size-4" />
							Back
						</Button>
						<Button
							type="button"
							size="lg"
							onClick={onNext}
							className="h-10 gap-2 px-4 text-[0.95rem]"
						>
							Next
							<ArrowRight data-icon="inline-end" className="size-4" />
						</Button>
					</div>
				</div>

				<LoginTerminalPreview
					provider={terminalProvider}
					instanceId={loginInstanceId}
					active={terminalActive}
					onExit={handleTerminalExit}
					onError={handleTerminalError}
					onClose={handleAbortLogin}
				/>
			</div>
		</section>
	);
}
