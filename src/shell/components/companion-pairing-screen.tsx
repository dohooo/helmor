import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";

/**
 * Shown in the companion browser when this client has no valid pairing token
 * (never paired, or the token was revoked / expired). Without it an
 * unauthenticated visitor falls through to the onboarding flow and sees demo
 * workspaces — confusing, and easily mistaken for "wrong data". This screen
 * explains how to pair instead.
 */
export function CompanionPairingScreen() {
	return (
		<div className="fixed inset-0 z-[9998] flex items-center justify-center bg-background p-6">
			<div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
				<HelmorLogoAnimated size={56} className="opacity-90" />
				<div className="flex flex-col gap-2">
					<h1 className="font-semibold text-foreground text-heading">
						Pair this browser
					</h1>
					<p className="text-muted-foreground text-body">
						This browser isn’t connected to your Helmor desktop yet.
					</p>
				</div>
				<ol className="flex w-full flex-col gap-3 text-left text-muted-foreground text-body">
					<li>
						<span className="font-medium text-foreground">1.</span> On the
						computer running Helmor, open{" "}
						<span className="font-medium text-foreground">
							Settings → Mobile companion
						</span>
						.
					</li>
					<li>
						<span className="font-medium text-foreground">2.</span> Scan the QR
						code with this device, or open the pairing link in this browser.
					</li>
				</ol>
			</div>
		</div>
	);
}
