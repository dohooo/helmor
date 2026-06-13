import { HelmorLogoAnimated } from "@/components/helmor-logo-animated";
import { Button } from "@/components/ui/button";
import { confirmCompanionPairing } from "@/lib/ipc";

/**
 * Shown when a pairing token was scanned (`#pair=`) but not yet activated.
 * Scanning a code only *stages* the token; this screen requires an explicit
 * confirmation before the browser gains access to the desktop — so a scanned or
 * shared link never silently pairs.
 */
export function CompanionPairingConfirm() {
	return (
		<div className="fixed inset-0 z-[9998] flex items-center justify-center bg-background p-6">
			<div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
				<HelmorLogoAnimated size={56} className="opacity-90" />
				<div className="flex flex-col gap-2">
					<h1 className="font-semibold text-foreground text-heading">
						Pair this browser
					</h1>
					<p className="text-muted-foreground text-body">
						Connect this browser to your Helmor desktop so you can open your
						workspaces, sessions, and agents from here. Only continue if you
						started this pairing yourself.
					</p>
				</div>
				<Button
					className="w-full"
					onClick={() => {
						confirmCompanionPairing();
					}}
				>
					Confirm pairing
				</Button>
			</div>
		</div>
	);
}
