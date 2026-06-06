import { Button } from "@/components/ui/button";

function FixedLinkSteps({ currentStep }: { currentStep: number }) {
	const steps = [
		{ id: "cloudflare", label: "Connect Cloudflare" },
		{ id: "link", label: "Create fixed link" },
		{ id: "done", label: "Keep using it" },
	];

	return (
		<div className="flex items-center gap-2">
			{steps.map((step, index) => {
				const stepNumber = index + 1;
				const isComplete = stepNumber < currentStep;
				const isCurrent = stepNumber === currentStep;
				return (
					<div key={step.id} className="flex min-w-0 flex-1 items-center gap-2">
						<div className="flex min-w-0 items-center gap-2">
							<span
								className={
									isComplete || isCurrent
										? "flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-micro font-medium text-primary-foreground"
										: "flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70 text-micro font-medium text-muted-foreground"
								}
							>
								{stepNumber}
							</span>
							<span className="truncate text-nano text-muted-foreground">
								{step.label}
							</span>
						</div>
						{index < steps.length - 1 ? (
							<span
								className={
									isComplete
										? "h-px min-w-4 flex-1 bg-primary/70"
										: "h-px min-w-4 flex-1 bg-border/60"
								}
							/>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

export function FixedLinkSetup({
	allocateError,
	canAct,
	disconnectError,
	fixedLinkStatus,
	hasFixedLink,
	isAllocating,
	isDisconnecting,
	isSigningIn,
	signedIn,
	signInError,
	stableHost,
	step,
	onCreateFixedLink,
	onDisconnectFixedLink,
	onSignInCloudflare,
}: {
	allocateError: string | null;
	canAct: boolean;
	disconnectError: string | null;
	fixedLinkStatus: string;
	hasFixedLink: boolean;
	isAllocating: boolean;
	isDisconnecting: boolean;
	isSigningIn: boolean;
	signedIn: boolean;
	signInError: string | null;
	stableHost: string | null;
	step: number;
	onCreateFixedLink: () => void;
	onDisconnectFixedLink: () => void;
	onSignInCloudflare: () => void;
}) {
	return (
		<div className="flex flex-col gap-4 py-5">
			<div className="flex items-start justify-between gap-4">
				<div className="min-w-0 flex-1">
					<p className="text-ui font-medium text-foreground">
						Keep the same link
					</p>
					<p className="mt-1 text-small leading-snug text-muted-foreground">
						The default temporary link changes when Helmor or the tunnel
						restarts. A fixed link uses your Cloudflare account to create a
						tunnel you own; Helmor only keeps the remote-*.helmor.ai alias.
					</p>
				</div>
				<span className="shrink-0 rounded-full border border-border/50 px-2 py-0.5 text-nano text-muted-foreground">
					{fixedLinkStatus}
				</span>
			</div>

			<FixedLinkSteps currentStep={step} />

			<div className="flex items-center justify-between gap-3">
				{stableHost ? (
					<p className="min-w-0 truncate text-small text-muted-foreground">
						Fixed link:{" "}
						<span className="font-mono text-foreground">{stableHost}</span>
					</p>
				) : signedIn ? (
					<p className="text-small text-muted-foreground">
						Cloudflare is connected. Create the fixed link next.
					</p>
				) : (
					<p className="text-small text-muted-foreground">
						Start by connecting Cloudflare in your browser.
					</p>
				)}

				{hasFixedLink ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="cursor-pointer text-destructive hover:text-destructive"
						disabled={isDisconnecting}
						onClick={onDisconnectFixedLink}
					>
						{isDisconnecting ? "Removing…" : "Remove fixed link"}
					</Button>
				) : signedIn ? (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="cursor-pointer"
						disabled={!canAct || isAllocating}
						onClick={onCreateFixedLink}
					>
						{isAllocating ? "Creating…" : "Create fixed link"}
					</Button>
				) : (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="cursor-pointer"
						disabled={!canAct || isSigningIn}
						onClick={onSignInCloudflare}
					>
						{isSigningIn ? "Waiting for browser…" : "Connect Cloudflare"}
					</Button>
				)}
			</div>

			{signInError ? (
				<p className="text-small text-destructive">{signInError}</p>
			) : null}
			{allocateError ? (
				<p className="text-small text-destructive">{allocateError}</p>
			) : null}
			{disconnectError ? (
				<p className="text-small text-destructive">{disconnectError}</p>
			) : null}
		</div>
	);
}
