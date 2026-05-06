import { ArrowLeft, ArrowRight } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AgentLoginProvider } from "@/lib/api";
import { AgentStatusAction } from "../components/agent-status-action";
import { LoginTerminalPreview } from "../components/login-terminal-preview";
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
	const terminalProvider = activeLoginProvider ?? primedLoginProvider;
	const terminalActive = activeLoginProvider !== null;

	const startLogin = useCallback((provider: AgentLoginProvider) => {
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

					<div className="mt-7 flex w-full flex-col gap-3">
						{loginItems.map(
							({ icon: Icon, provider, label, description, status }) => (
								<div
									key={label}
									className="flex min-h-20 items-center gap-3 rounded-lg border border-border/55 bg-card px-4 py-3"
								>
									<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground">
										<Icon className="size-5" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="text-sm font-medium text-foreground">
											{label}
										</div>
										<p className="mt-0.5 text-xs leading-5 text-muted-foreground">
											{description}
										</p>
									</div>
									<AgentStatusAction
										provider={provider}
										status={status}
										waiting={waitingProvider === provider}
										onPrimeLogin={setPrimedLoginProvider}
										onStartLogin={startLogin}
									/>
								</div>
							),
						)}
					</div>

					<div className="mt-7 flex items-center gap-3">
						<Button
							type="button"
							variant="ghost"
							size="lg"
							onClick={onBack}
							className="h-11 gap-2 px-4 text-[0.95rem]"
						>
							<ArrowLeft data-icon="inline-start" className="size-4" />
							Back
						</Button>
						<Button
							type="button"
							size="lg"
							onClick={onNext}
							className="h-11 gap-2 px-4 text-[0.95rem]"
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
