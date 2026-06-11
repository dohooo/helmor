import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import {
	allocateStableUrl,
	type CompanionPairingPayload,
	type CompanionStatus,
	disableCompanion,
	disableCompanionTunnel,
	enableCompanion,
	enableLanCompanion,
	getCompanionStatus,
	listPairedDevices,
	pairCompanionDevice,
	revokePairedDevice,
	signInCloudflare,
	signOutCloudflare,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { SettingsGroup } from "../components/settings-row";
import { ConnectPhoneSection } from "./mobile-companion/connect-phone-section";
import { FixedLinkSetup } from "./mobile-companion/fixed-link-setup";
import { PairedDevicesSection } from "./mobile-companion/paired-devices-section";

const COMPANION_STATUS_KEY = ["companionStatus"] as const;
const COMPANION_PAIRING_KEY = ["companionPairingCode"] as const;
const LAN_COMPANION_ENABLED = import.meta.env.DEV;

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

/// Settings → Mobile panel for the mobile browser companion. Debug builds keep
/// the LAN-only switch for development pairing; release builds expose Cloudflare
/// tunnel pairing only. The advanced "Keep the same link" section upgrades the
/// ephemeral quick tunnel to a stable remote-*.helmor.ai address; pairing mints
/// a per-device token shown as a QR.
export function MobileCompanionPanel() {
	const queryClient = useQueryClient();
	const [copied, setCopied] = useState(false);

	const statusQuery = useQuery({
		queryKey: COMPANION_STATUS_KEY,
		queryFn: getCompanionStatus,
		staleTime: 0,
	});
	const devicesQuery = useQuery({
		queryKey: helmorQueryKeys.pairedDevices,
		queryFn: listPairedDevices,
		staleTime: 0,
	});
	const pairingQuery = useQuery<CompanionPairingPayload | null>({
		queryKey: COMPANION_PAIRING_KEY,
		queryFn: () => Promise.resolve(null),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
	});

	const publicUrl = statusQuery.data?.publicUrl ?? null;
	const lanUrl = statusQuery.data?.lanUrl ?? null;
	const signedIn = statusQuery.data?.signedIn ?? false;
	const stableHost = statusQuery.data?.stableHost ?? null;
	const hasFixedLink = stableHost !== null;
	const devices = devicesQuery.data ?? [];
	const pairing = pairingQuery.data ?? null;
	const connectionUrl = publicUrl ?? (LAN_COMPANION_ENABLED ? lanUrl : null);
	const pairingIsCurrent = pairingMatchesBaseUrl(pairing, connectionUrl);
	const replacePendingDeviceId = pairing?.deviceId;
	const accessEnabled = statusQuery.data?.running ?? false;
	const cloudflareEnabled = publicUrl !== null;

	const setStatus = (status: CompanionStatus) =>
		queryClient.setQueryData(COMPANION_STATUS_KEY, status);
	const setPairingCode = (payload: CompanionPairingPayload | null) =>
		queryClient.setQueryData(COMPANION_PAIRING_KEY, payload);

	const enableLanMutation = useMutation({
		mutationFn: enableLanCompanion,
		onSuccess: (status) => {
			setStatus(status);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const enableTunnelMutation = useMutation({
		mutationFn: enableCompanion,
		onSuccess: (status) => {
			setStatus(status);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const disableMutation = useMutation({
		mutationFn: disableCompanion,
		onSuccess: () => {
			setPairingCode(null);
			queryClient.setQueryData<CompanionStatus | undefined>(
				COMPANION_STATUS_KEY,
				(current) =>
					current
						? {
								...current,
								running: false,
								addr: null,
								lanUrl: null,
								publicUrl: null,
								mode: "none",
							}
						: current,
			);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const disableTunnelMutation = useMutation({
		mutationFn: disableCompanionTunnel,
		onSuccess: (status) => {
			setPairingCode(null);
			setStatus(status);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const signInMutation = useMutation({
		mutationFn: signInCloudflare,
		onSuccess: () =>
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY }),
	});
	const allocateMutation = useMutation({
		mutationFn: allocateStableUrl,
		onSuccess: (status) => {
			setPairingCode(null);
			setStatus(status);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const signOutMutation = useMutation({
		mutationFn: signOutCloudflare,
		onSuccess: (status) => {
			setPairingCode(null);
			setStatus(status);
			void queryClient.invalidateQueries({ queryKey: COMPANION_STATUS_KEY });
		},
	});
	const pairingCodeMutation = useMutation({
		mutationFn: async ({
			replaceDeviceId,
		}: {
			replaceDeviceId?: string;
		} = {}) => {
			return pairCompanionDevice(deviceLabel(), replaceDeviceId);
		},
		onSuccess: (payload) => {
			setCopied(false);
			setPairingCode(payload);
		},
	});
	const revokeMutation = useMutation({
		mutationFn: async (id: string) => {
			await revokePairedDevice(id);
			return id;
		},
		onSuccess: (id) => {
			if (pairing?.deviceId === id) {
				setPairingCode(null);
			}
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.pairedDevices,
			});
		},
	});

	const starting =
		statusQuery.isPending ||
		enableLanMutation.isPending ||
		enableTunnelMutation.isPending;
	const stopping = disableMutation.isPending || disableTunnelMutation.isPending;
	useEffect(() => {
		if (!LAN_COMPANION_ENABLED) return;
		if (statusQuery.isPending || statusQuery.data?.running) return;
		if (enableLanMutation.isPending || disableMutation.isPending) return;
		enableLanMutation.mutate();
	}, [
		disableMutation.isPending,
		enableLanMutation.isPending,
		enableLanMutation.mutate,
		statusQuery.data?.running,
		statusQuery.isPending,
	]);
	useEffect(() => {
		if (!connectionUrl || starting || pairingCodeMutation.isPending) return;
		if (pairingIsCurrent) return;
		pairingCodeMutation.mutate({
			replaceDeviceId: replacePendingDeviceId,
		});
	}, [
		connectionUrl,
		starting,
		pairingIsCurrent,
		replacePendingDeviceId,
		pairingCodeMutation.isPending,
		pairingCodeMutation.mutate,
	]);

	const connectDescription = enableLanMutation.isError
		? "Mobile access could not start."
		: disableMutation.isError
			? "Mobile access could not stop."
			: enableTunnelMutation.isError
				? "Cloudflare tunnel could not start."
				: disableTunnelMutation.isError
					? "Cloudflare tunnel could not stop."
					: pairingCodeMutation.isError
						? "Could not create a pairing code."
						: !accessEnabled
							? LAN_COMPANION_ENABLED
								? "Turn on mobile access to create a LAN pairing link."
								: "Turn on Cloudflare tunnel to create a mobile pairing link."
							: !connectionUrl
								? LAN_COMPANION_ENABLED
									? "Could not find a local network address. Check Wi-Fi or network permissions."
									: "Cloudflare tunnel is starting. Pairing will be ready once the public link is available."
								: !pairing
									? "Preparing a private link for your device."
									: cloudflareEnabled && hasFixedLink
										? "Scan with your device's camera. This fixed link survives Helmor restarts."
										: cloudflareEnabled
											? "Scan with your device's camera. The current temporary link changes after Helmor or the tunnel restarts."
											: "Scan with your device's camera while the device is on the same Wi-Fi or LAN.";
	const fixedLinkActionReady =
		accessEnabled && !starting && !enableTunnelMutation.isError;
	const fixedLinkSetupState = stableHost
		? {
				kind: "fixed" as const,
				pending: signOutMutation.isPending,
				stableHost,
			}
		: signedIn
			? {
					canAct: fixedLinkActionReady,
					kind: "ready" as const,
					pending: allocateMutation.isPending,
				}
			: {
					canAct: fixedLinkActionReady,
					kind: "needsSignIn" as const,
					pending: signInMutation.isPending,
				};

	return (
		<SettingsGroup>
			{LAN_COMPANION_ENABLED ? (
				<div className="flex flex-col items-start justify-between gap-3 py-5 sm:flex-row">
					<div className="min-w-0 flex-1">
						<p className="text-ui font-medium text-foreground">Mobile access</p>
						<p className="mt-1 text-small leading-snug text-muted-foreground">
							{accessEnabled
								? "LAN pairing is available. Cloudflare stays off unless you enable the tunnel below."
								: "Starts LAN pairing for devices on the same Wi-Fi or local network."}
						</p>
					</div>
					<Switch
						checked={accessEnabled}
						disabled={statusQuery.isPending || starting || stopping}
						onCheckedChange={(checked) => {
							if (checked) {
								enableLanMutation.mutate();
							} else {
								disableMutation.mutate();
							}
						}}
					/>
				</div>
			) : null}

			<div className="flex flex-col items-start justify-between gap-3 py-5 sm:flex-row">
				<div className="min-w-0 flex-1">
					<p className="text-ui font-medium text-foreground">
						Cloudflare tunnel
					</p>
					<p className="mt-1 text-small leading-snug text-muted-foreground">
						{LAN_COMPANION_ENABLED
							? cloudflareEnabled
								? "Remote access is using Cloudflare. Turn it off to fall back to LAN pairing."
								: "Optional remote access for devices outside your local network."
							: cloudflareEnabled
								? "Remote mobile access is using Cloudflare."
								: "Creates the mobile pairing link through Cloudflare tunnel."}
					</p>
				</div>
				<Switch
					checked={cloudflareEnabled}
					disabled={
						(LAN_COMPANION_ENABLED && !accessEnabled) ||
						statusQuery.isPending ||
						enableTunnelMutation.isPending ||
						disableTunnelMutation.isPending ||
						disableMutation.isPending
					}
					onCheckedChange={(checked) => {
						if (checked) {
							enableTunnelMutation.mutate();
						} else if (LAN_COMPANION_ENABLED) {
							disableTunnelMutation.mutate();
						} else {
							disableMutation.mutate();
						}
					}}
				/>
			</div>

			<ConnectPhoneSection
				canRefresh={Boolean(connectionUrl)}
				connectDescription={connectDescription}
				copied={copied}
				isMobileAccessEnabled={accessEnabled}
				isMobileAccessError={
					(LAN_COMPANION_ENABLED && enableLanMutation.isError) ||
					enableTunnelMutation.isError
				}
				isPreparing={starting}
				isRefreshing={pairingCodeMutation.isPending}
				pairedDevicesList={
					<PairedDevicesSection
						className="h-full"
						devices={devices}
						isDisconnecting={revokeMutation.isPending}
						onDisconnect={(deviceId) => revokeMutation.mutate(deviceId)}
					/>
				}
				pairing={pairing}
				onCopyLink={() => {
					if (!pairing) return;
					void navigator.clipboard?.writeText(pairing.url);
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1500);
				}}
				onRefreshCode={() =>
					pairingCodeMutation.mutate({
						replaceDeviceId: replacePendingDeviceId,
					})
				}
				onRetryMobileAccess={() =>
					LAN_COMPANION_ENABLED
						? enableLanMutation.mutate()
						: enableTunnelMutation.mutate()
				}
			/>

			<FixedLinkSetup
				allocateError={
					allocateMutation.isError ? errorText(allocateMutation.error) : null
				}
				signOutError={
					signOutMutation.isError ? errorText(signOutMutation.error) : null
				}
				signInError={
					signInMutation.isError ? errorText(signInMutation.error) : null
				}
				state={fixedLinkSetupState}
				onCreateFixedLink={() => allocateMutation.mutate()}
				onSignInCloudflare={() => signInMutation.mutate()}
				onSignOutCloudflare={() => signOutMutation.mutate()}
			/>

			{enableLanMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(enableLanMutation.error)}
				</p>
			) : null}
			{disableMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(disableMutation.error)}
				</p>
			) : null}
			{enableTunnelMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(enableTunnelMutation.error)}
				</p>
			) : null}
			{disableTunnelMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(disableTunnelMutation.error)}
				</p>
			) : null}
			{pairingCodeMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(pairingCodeMutation.error)}
				</p>
			) : null}
		</SettingsGroup>
	);
}
