import { Check, Download, Loader2, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type CliStatus, getCliStatus, installCli } from "@/lib/api";

export function CliInstallPanel() {
	const [status, setStatus] = useState<CliStatus | null>(null);
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void getCliStatus().then(setStatus);
	}, []);

	const handleInstall = useCallback(async () => {
		setInstalling(true);
		setError(null);
		try {
			const result = await installCli();
			setStatus(result);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setInstalling(false);
		}
	}, []);

	return (
		<div className="rounded-xl border border-border/30 bg-muted/30 px-5 py-4">
			<div className="flex items-center gap-2">
				<Terminal className="size-4 text-muted-foreground" strokeWidth={1.8} />
				<div className="text-[13px] font-medium leading-snug text-foreground">
					Command Line Tool
				</div>
			</div>
			<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
				Install the{" "}
				<code className="rounded bg-muted px-1 py-0.5 text-[11px]">helmor</code>{" "}
				command to manage workspaces and sessions from the terminal.{" "}
				{status?.buildMode === "development" ? "Debug" : "Release"} build.
			</div>

			<div className="mt-4">
				{status?.installed ? (
					<div className="space-y-3">
						<div className="flex items-center gap-2 text-[12px] text-green-400/90">
							<Check className="size-3.5" strokeWidth={2} />
							<span>
								Installed at{" "}
								<code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
									{status.installPath}
								</code>
							</span>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={handleInstall}
							disabled={installing}
						>
							{installing ? (
								<Loader2 className="size-3.5 animate-spin" />
							) : (
								<Download className="size-3.5" strokeWidth={1.8} />
							)}
							Reinstall
						</Button>
					</div>
				) : (
					<Button
						variant="outline"
						size="sm"
						onClick={handleInstall}
						disabled={installing}
					>
						{installing ? (
							<Loader2 className="size-3.5 animate-spin" />
						) : (
							<Download className="size-3.5" strokeWidth={1.8} />
						)}
						Install to /usr/local/bin
					</Button>
				)}

				{error && (
					<p className="mt-2 text-[11px] leading-relaxed text-destructive">
						{error}
					</p>
				)}
			</div>
		</div>
	);
}
