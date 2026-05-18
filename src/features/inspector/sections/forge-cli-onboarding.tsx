import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { GithubBrandIcon, GitlabBrandIcon } from "@/components/brand-icon";
import { ForgeConnectDialog } from "@/components/forge-connect-dialog";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ForgeDetection } from "@/lib/api";
import { FORGE_AUTH_TOOLTIP_LINES } from "@/lib/forge-auth-copy";

const DEFAULT_GITHUB_HOST = "github.com";
const DEFAULT_GITLAB_HOST = "gitlab.com";

export function ForgeCliTrigger({
	detection,
	workspaceId,
	connecting = false,
	onConnectingChange,
}: {
	detection: ForgeDetection;
	workspaceId: string | null;
	connecting?: boolean;
	onConnectingChange?: (connecting: boolean) => void;
}) {
	const [open, setOpen] = useState(false);

	const host =
		detection.host ??
		(detection.provider === "gitlab"
			? DEFAULT_GITLAB_HOST
			: DEFAULT_GITHUB_HOST);

	return (
		<>
			<TooltipProvider delayDuration={150}>
				<div className="ml-auto flex items-center self-center translate-y-px">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="xs"
								variant="default"
								onClick={() => setOpen(true)}
								disabled={connecting}
								className="gap-1 bg-primary text-primary-foreground hover:bg-primary/90"
							>
								{connecting ? (
									<LoaderCircle
										size={12}
										className="self-center animate-spin"
										strokeWidth={2}
									/>
								) : detection.provider === "gitlab" ? (
									<GitlabBrandIcon
										size={12}
										className="self-center text-[#FC6D26]"
									/>
								) : (
									<GithubBrandIcon size={12} className="self-center" />
								)}
								{connecting ? "Connecting" : detection.labels.connectAction}
							</Button>
						</TooltipTrigger>
						<TooltipContent
							side="bottom"
							className="max-w-xs whitespace-normal"
						>
							<ForgeDetectionTooltipBody detection={detection} />
						</TooltipContent>
					</Tooltip>
				</div>
			</TooltipProvider>
			<ForgeConnectDialog
				open={open}
				onOpenChange={(next) => {
					if (!next) onConnectingChange?.(true);
					setOpen(next);
				}}
				provider={detection.provider}
				host={host}
				workspaceId={workspaceId}
				onCloseSettled={({ connected }) => {
					if (!connected) onConnectingChange?.(false);
				}}
			/>
		</>
	);
}

function ForgeDetectionTooltipBody({
	detection,
}: {
	detection: ForgeDetection;
}) {
	const providerName = detection.labels.providerName;
	const host = detection.host ?? "this host";
	return (
		<div className="space-y-1.5">
			<div className="text-[11px] font-medium leading-snug">
				Detected {providerName} at {host}
			</div>
			<div className="space-y-0.5 text-[10.5px] leading-snug opacity-90">
				{FORGE_AUTH_TOOLTIP_LINES.map((line) => (
					<div key={line}>{line}</div>
				))}
			</div>
			{detection.detectionSignals.length > 0 && (
				<div className="space-y-0.5 border-t border-background/20 pt-1.5 text-[10.5px] leading-snug opacity-90">
					<div className="font-medium">Why we think so:</div>
					<ul className="list-disc space-y-0.5 pl-3.5">
						{detection.detectionSignals.map((signal) => (
							<li key={`${signal.layer}:${signal.detail}`}>{signal.detail}</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
