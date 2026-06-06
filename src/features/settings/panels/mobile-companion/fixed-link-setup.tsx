import { Button } from "@/components/ui/button";

type FixedLinkSetupState =
	| {
			kind: "fixed";
			pending: boolean;
			stableHost: string;
	  }
	| {
			canAct: boolean;
			kind: "ready";
			pending: boolean;
	  }
	| {
			canAct: boolean;
			kind: "needsSignIn";
			pending: boolean;
	  };

export function FixedLinkSetup({
	allocateError,
	signInError,
	signOutError,
	state,
	onCreateFixedLink,
	onSignInCloudflare,
	onSignOutCloudflare,
}: {
	allocateError: string | null;
	signInError: string | null;
	signOutError: string | null;
	state: FixedLinkSetupState;
	onCreateFixedLink: () => void;
	onSignInCloudflare: () => void;
	onSignOutCloudflare: () => void;
}) {
	return (
		<div className="flex flex-col gap-3 py-5">
			<p className="text-ui font-medium text-foreground">Keep the same link</p>

			<div className="flex items-center justify-between gap-3">
				{state.kind === "fixed" ? (
					<p className="min-w-0 truncate text-small text-muted-foreground">
						Fixed link:{" "}
						<span className="font-mono text-foreground">
							{state.stableHost}
						</span>
					</p>
				) : state.kind === "ready" ? (
					<p className="text-small text-muted-foreground">
						Cloudflare is connected. Create the fixed link next.
					</p>
				) : (
					<p className="text-small text-muted-foreground">
						Start by connecting Cloudflare in your browser.
					</p>
				)}

				{state.kind === "fixed" ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="cursor-pointer text-destructive hover:text-destructive"
						disabled={state.pending}
						onClick={onSignOutCloudflare}
					>
						{state.pending ? "Signing out…" : "Sign out of Cloudflare"}
					</Button>
				) : state.kind === "ready" ? (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="cursor-pointer"
						disabled={!state.canAct || state.pending}
						onClick={onCreateFixedLink}
					>
						{state.pending ? "Creating…" : "Create fixed link"}
					</Button>
				) : (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="cursor-pointer"
						disabled={!state.canAct || state.pending}
						onClick={onSignInCloudflare}
					>
						{state.pending ? "Waiting for browser…" : "Connect Cloudflare"}
					</Button>
				)}
			</div>

			{signInError ? (
				<p className="text-small text-destructive">{signInError}</p>
			) : null}
			{allocateError ? (
				<p className="text-small text-destructive">{allocateError}</p>
			) : null}
			{signOutError ? (
				<p className="text-small text-destructive">{signOutError}</p>
			) : null}
			<p className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-nano leading-snug text-muted-foreground">
				Tip: The default temporary link changes when Helmor or the tunnel
				restarts. A fixed link uses your Cloudflare account to create a tunnel
				you own; Helmor only keeps the remote-*.helmor.ai alias.
			</p>
		</div>
	);
}
