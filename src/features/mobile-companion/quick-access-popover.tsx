import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	Loader2,
	QrCode,
	RefreshCw,
	Smartphone,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	type CompanionPairingPayload,
	type CompanionStatus,
	enableCompanion,
	enableLanCompanion,
	getCompanionStatus,
	listPairedDevices,
	pairCompanionDevice,
	revokePairedDevice,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { PairedDevicesSection } from "../settings/panels/mobile-companion/paired-devices-section";

const COMPANION_STATUS_KEY = ["companionStatus"] as const;
const COMPANION_PAIRING_KEY = ["companionQuickAccessPairing"] as const;
const LAN_COMPANION_ENABLED = import.meta.env.DEV;

type CompanionLightState =
	| "idle"
	| "preparing"
	| "ready"
	| "connected"
	| "error";

function deviceLabel(): string {
	const date = new Date().toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	return `Device · ${date}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pairingMatchesBaseUrl(
	pairing: CompanionPairingPayload | null,
	baseUrl: string | null,
): boolean {
	if (!pairing || !baseUrl) return false;
	try {
		return new URL(pairing.baseUrl).origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}

function statusCopy(state: CompanionLightState): string {
	switch (state) {
		case "connected":
			return "Device connected";
		case "ready":
			return "Ready to scan";
		case "preparing":
			return "Preparing link";
		case "error":
			return "Needs attention";
		case "idle":
			return "Mobile connection";
	}
}

function MobileStatusLight({ state }: { state: CompanionLightState }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"absolute -right-px top-0 size-2 rounded-full border border-background",
				state === "connected" && "bg-status-success",
				state === "ready" && "animate-pulse bg-status-info",
				state === "preparing" && "animate-pulse bg-status-warning",
				state === "error" && "bg-status-danger",
				state === "idle" && "bg-muted-foreground/45",
			)}
		/>
	);
}

export function MobileCompanionQuickAccessPopover() {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);

	const statusQuery = useQuery({
		queryKey: COMPANION_STATUS_KEY,
		queryFn: getCompanionStatus,
		refetchInterval: open ? 2500 : 15000,
		staleTime: 0,
	});
	const devicesQuery = useQuery({
		queryKey: helmorQueryKeys.pairedDevices,
		queryFn: listPairedDevices,
		refetchInterval: open ? 3000 : false,
		staleTime: 0,
	});
	const pairingQuery = useQuery<CompanionPairingPayload | null>({
		queryKey: COMPANION_PAIRING_KEY,
		queryFn: () => Promise.resolve(null),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});

	const devices = devicesQuery.data ?? [];
	const pairing = pairingQuery.data ?? null;
	const publicUrl = statusQuery.data?.publicUrl ?? null;
	const lanUrl = statusQuery.data?.lanUrl ?? null;
	const connectionUrl = publicUrl ?? (LAN_COMPANION_ENABLED ? lanUrl : null);
	const hasDevices = devices.length > 0;
	const pairingIsCurrent = pairingMatchesBaseUrl(pairing, connectionUrl);

	const setStatus = (status: CompanionStatus) =>
		queryClient.setQueryData(COMPANION_STATUS_KEY, status);
	const setPairingCode = (payload: CompanionPairingPayload | null) =>
		queryClient.setQueryData(COMPANION_PAIRING_KEY, payload);

	const enableMutation = useMutation({
		mutationFn: LAN_COMPANION_ENABLED ? enableLanCompanion : enableCompanion,
		onSuccess: (status) => {
			setStatus(status);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const pairingMutation = useMutation({
		mutationFn: async ({
			replaceDeviceId,
		}: {
			replaceDeviceId?: string;
		} = {}) => pairCompanionDevice(deviceLabel(), replaceDeviceId),
		onSuccess: setPairingCode,
	});
	const revokeMutation = useMutation({
		mutationFn: async (id: string) => {
			await revokePairedDevice(id);
			return id;
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.pairedDevices,
			});
		},
	});

	const preparing =
		statusQuery.isPending ||
		enableMutation.isPending ||
		pairingMutation.isPending;
	const error =
		enableMutation.error ??
		pairingMutation.error ??
		revokeMutation.error ??
		statusQuery.error ??
		devicesQuery.error;
	const lightState = useMemo<CompanionLightState>(() => {
		if (error) return "error";
		if (hasDevices) return "connected";
		if (pairing && connectionUrl) return "ready";
		if (preparing || (open && statusQuery.data?.running)) return "preparing";
		return "idle";
	}, [
		connectionUrl,
		error,
		hasDevices,
		open,
		pairing,
		preparing,
		statusQuery.data,
	]);

	useEffect(() => {
		if (!open || hasDevices || enableMutation.isPending) return;
		if (connectionUrl) return;
		enableMutation.mutate();
	}, [
		connectionUrl,
		enableMutation.isPending,
		enableMutation.mutate,
		hasDevices,
		open,
	]);

	useEffect(() => {
		if (!open || hasDevices || !connectionUrl || pairingMutation.isPending) {
			return;
		}
		if (pairingIsCurrent) return;
		pairingMutation.mutate({
			replaceDeviceId: pairing?.deviceId,
		});
	}, [
		hasDevices,
		open,
		pairing?.deviceId,
		pairingIsCurrent,
		pairingMutation.isPending,
		pairingMutation.mutate,
		connectionUrl,
	]);

	const title = hasDevices ? "Connected devices" : "Connect mobile";

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger asChild>
					<PopoverTrigger asChild>
						<Button
							aria-label="Mobile connection"
							variant="ghost"
							size="icon-xs"
							className="relative text-muted-foreground hover:text-foreground max-[960px]:hidden"
						>
							<Smartphone className="size-4" strokeWidth={1.8} />
							<MobileStatusLight state={lightState} />
						</Button>
					</PopoverTrigger>
				</TooltipTrigger>
				<TooltipContent
					side="bottom"
					className="flex h-[24px] items-center gap-2 rounded-md px-2 text-small leading-none"
				>
					{statusCopy(lightState)}
				</TooltipContent>
			</Tooltip>
			<PopoverContent
				align="start"
				side="bottom"
				sideOffset={8}
				className="w-[264px] gap-4 p-4"
			>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<p className="text-ui font-semibold text-foreground">{title}</p>
					</div>
					<span
						className={cn(
							"inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-mini font-medium leading-none",
							lightState === "connected" &&
								"border-status-success/30 bg-status-success/10 text-status-success",
							lightState === "ready" &&
								"border-status-info/30 bg-status-info/10 text-status-info",
							lightState === "preparing" &&
								"border-status-warning/30 bg-status-warning/10 text-status-warning",
							lightState === "error" &&
								"border-status-danger/30 bg-status-danger/10 text-status-danger",
							lightState === "idle" &&
								"border-border/50 bg-muted/40 text-muted-foreground",
						)}
					>
						{lightState === "connected" ? (
							<CheckCircle2 className="size-3" strokeWidth={2} />
						) : lightState === "preparing" ? (
							<Loader2 className="size-3 animate-spin" strokeWidth={2} />
						) : (
							<QrCode className="size-3" strokeWidth={2} />
						)}
						{statusCopy(lightState)}
					</span>
				</div>

				{hasDevices ? (
					<PairedDevicesSection
						className="max-h-[220px]"
						devices={devices}
						isDisconnecting={revokeMutation.isPending}
						onDisconnect={(deviceId) => revokeMutation.mutate(deviceId)}
					/>
				) : (
					<div className="flex flex-col items-center gap-3">
						<div className="flex size-[196px] items-center justify-center rounded-xl border border-border/50 bg-white p-3 shadow-sm">
							{pairing ? (
								<QRCodeSVG value={pairing.url} size={168} />
							) : (
								<div className="flex flex-col items-center gap-2 text-muted-foreground">
									<Loader2
										className="size-5 animate-spin"
										strokeWidth={1.8}
										aria-hidden="true"
									/>
									<span className="text-small">Preparing QR code</span>
								</div>
							)}
						</div>
						<div className="flex w-full items-center justify-between gap-2">
							<p className="min-w-0 flex-1 truncate text-nano text-muted-foreground">
								{connectionUrl ??
									(LAN_COMPANION_ENABLED
										? "Starting LAN access..."
										: "Starting Cloudflare tunnel...")}
							</p>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label="Refresh QR code"
								disabled={!connectionUrl || pairingMutation.isPending}
								onClick={() =>
									pairingMutation.mutate({
										replaceDeviceId: pairing?.deviceId,
									})
								}
							>
								<RefreshCw className="size-3.5" strokeWidth={1.8} />
							</Button>
						</div>
					</div>
				)}

				{error ? (
					<div className="rounded-lg border border-status-danger/30 bg-status-danger/10 px-3 py-2 text-small leading-snug text-status-danger">
						{errorText(error)}
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
