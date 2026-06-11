import { CopyIcon, RefreshCw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CompanionPairingPayload } from "@/lib/api";

function LinkIconButton({
	label,
	disabled,
	onClick,
	children,
}: {
	label: string;
	disabled?: boolean;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={label}
					disabled={disabled}
					className="cursor-pointer text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

export function ConnectPhoneSection({
	connectDescription,
	copied,
	isMobileAccessEnabled,
	isMobileAccessError,
	isPreparing,
	isRefreshing,
	pairedDevicesList,
	pairing,
	canRefresh,
	onCopyLink,
	onRefreshCode,
	onRetryMobileAccess,
}: {
	connectDescription: string;
	copied: boolean;
	isMobileAccessEnabled: boolean;
	isMobileAccessError: boolean;
	isPreparing: boolean;
	isRefreshing: boolean;
	pairedDevicesList: ReactNode;
	pairing: CompanionPairingPayload | null;
	canRefresh: boolean;
	onCopyLink: () => void;
	onRefreshCode: () => void;
	onRetryMobileAccess: () => void;
}) {
	return (
		<div className="flex items-start justify-between gap-6 py-5">
			<div className="flex h-[216px] min-w-0 flex-1 flex-col">
				<div>
					<p className="text-ui font-medium text-foreground">
						Connect a device
					</p>
					<p className="mt-1 max-w-[460px] text-small leading-snug text-muted-foreground">
						{connectDescription}
					</p>
					{isMobileAccessError ? (
						<div className="mt-3">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="cursor-pointer"
								onClick={onRetryMobileAccess}
							>
								Retry mobile access
							</Button>
						</div>
					) : null}
				</div>
				<div className="mt-4 min-h-0 flex-1">{pairedDevicesList}</div>
			</div>

			<TooltipProvider delayDuration={150}>
				<div className="flex h-[216px] w-[176px] shrink-0 flex-col gap-2">
					<div className="flex size-[176px] items-center justify-center rounded-lg bg-white p-3">
						{pairing ? (
							<QRCodeSVG value={pairing.url} size={148} />
						) : (
							<span className="text-small text-muted-foreground/80">
								{isMobileAccessEnabled ? "Preparing…" : "Off"}
							</span>
						)}
					</div>
					<div className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-border/40 bg-muted/25 px-2">
						<span className="min-w-0 flex-1 truncate font-mono text-nano text-muted-foreground">
							{pairing?.baseUrl ??
								(isMobileAccessEnabled ? "Preparing link…" : "Not running")}
						</span>
						<LinkIconButton
							label={copied ? "Copied" : "Copy link"}
							disabled={!pairing}
							onClick={onCopyLink}
						>
							<CopyIcon className="size-3.5" strokeWidth={1.9} />
						</LinkIconButton>
						<LinkIconButton
							label="Refresh code"
							disabled={!canRefresh || isRefreshing || isPreparing}
							onClick={onRefreshCode}
						>
							<RefreshCw
								className="size-3.5"
								strokeWidth={1.9}
								aria-hidden="true"
							/>
						</LinkIconButton>
					</div>
				</div>
			</TooltipProvider>
		</div>
	);
}
