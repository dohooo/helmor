import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	allocateStableUrl,
	type CompanionPairingPayload,
	type CompanionStatus,
	destroyStableUrl,
	enableCompanion,
	getCompanionStatus,
	listPairedDevices,
	type PairedDevice,
	pairCompanionDevice,
	revokePairedDevice,
	signInCloudflare,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { SettingsGroup } from "../components/settings-row";
import { ConnectPhoneSection } from "./mobile-companion/connect-phone-section";
import { FixedLinkSetup } from "./mobile-companion/fixed-link-setup";
import { PairedDevicesSection } from "./mobile-companion/paired-devices-section";

const COMPANION_STATUS_KEY = ["companionStatus"] as const;
const COMPANION_PAIRING_KEY = ["companionPairingCode"] as const;

function deviceLabel(): string {
	const date = new Date().toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	return `Phone · ${date}`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pairingMatchesPublicUrl(
	pairing: CompanionPairingPayload | null,
	publicUrl: string | null,
): boolean {
	if (!pairing || !publicUrl) return false;
	try {
		return new URL(pairing.url).origin === new URL(publicUrl).origin;
	} catch {
		return false;
	}
}

function unconnectedPairingDeviceId(
	pairing: CompanionPairingPayload | null,
	devices: PairedDevice[],
): string | undefined {
	if (!pairing) return undefined;
	const device = devices.find((item) => item.id === pairing.deviceId);
	if (!device || device.lastSeenAt) return undefined;
	return pairing.deviceId;
}

/// Settings → Mobile panel for the mobile browser companion. Opening this
/// panel starts the loopback server + a cloudflared tunnel; the advanced
/// "Keep the same link" section upgrades the ephemeral quick tunnel to a stable
/// remote-*.helmor.ai address; pairing mints a per-device token shown as a QR.
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

	const running = statusQuery.data?.running ?? false;
	const publicUrl = statusQuery.data?.publicUrl ?? null;
	const signedIn = statusQuery.data?.signedIn ?? false;
	const stableHost = statusQuery.data?.stableHost ?? null;
	const hasFixedLink = stableHost !== null;
	const devices = devicesQuery.data ?? [];
	const pairing = pairingQuery.data ?? null;
	const pairingIsCurrent = pairingMatchesPublicUrl(pairing, publicUrl);
	const replacePairingDeviceId = unconnectedPairingDeviceId(pairing, devices);

	const setStatus = (status: CompanionStatus) =>
		queryClient.setQueryData(COMPANION_STATUS_KEY, status);
	const setPairingCode = (payload: CompanionPairingPayload | null) =>
		queryClient.setQueryData(COMPANION_PAIRING_KEY, payload);

	const enableMutation = useMutation({
		mutationFn: enableCompanion,
		onSuccess: (status) => {
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
	const disconnectFixedLinkMutation = useMutation({
		mutationFn: destroyStableUrl,
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
			if (replaceDeviceId) {
				await revokePairedDevice(replaceDeviceId);
			}
			return pairCompanionDevice(deviceLabel());
		},
		onSuccess: (payload) => {
			setCopied(false);
			setPairingCode(payload);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.pairedDevices,
			});
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

	useEffect(() => {
		if (!statusQuery.isSuccess) return;
		if (running || enableMutation.isPending || enableMutation.isError) return;
		enableMutation.mutate();
	}, [
		statusQuery.isSuccess,
		running,
		enableMutation.isPending,
		enableMutation.isError,
		enableMutation.mutate,
	]);

	const starting = statusQuery.isPending || enableMutation.isPending;
	useEffect(() => {
		if (!publicUrl || starting || pairingCodeMutation.isPending) return;
		if (pairingIsCurrent) return;
		pairingCodeMutation.mutate({
			replaceDeviceId: replacePairingDeviceId,
		});
	}, [
		publicUrl,
		starting,
		pairingIsCurrent,
		replacePairingDeviceId,
		pairingCodeMutation.isPending,
		pairingCodeMutation.mutate,
	]);

	const connectDescription = enableMutation.isError
		? "Mobile access could not start."
		: pairingCodeMutation.isError
			? "Could not create a pairing code."
			: !pairing
				? "Preparing a private link for your phone."
				: hasFixedLink
					? "Scan with your phone's camera. This fixed link survives Helmor restarts."
					: "Scan with your phone's camera. The current temporary link changes after Helmor or the tunnel restarts.";
	const fixedLinkStatus = hasFixedLink
		? "Fixed link active"
		: signedIn
			? "Cloudflare connected"
			: "Not set up";
	const fixedLinkStep = hasFixedLink ? 3 : signedIn ? 2 : 1;
	const fixedLinkActionReady = !starting && !enableMutation.isError;

	return (
		<SettingsGroup>
			<ConnectPhoneSection
				canRefresh={Boolean(publicUrl)}
				connectDescription={connectDescription}
				copied={copied}
				isMobileAccessError={enableMutation.isError}
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
						replaceDeviceId: replacePairingDeviceId,
					})
				}
				onRetryMobileAccess={() => enableMutation.mutate()}
			/>

			<FixedLinkSetup
				allocateError={
					allocateMutation.isError ? errorText(allocateMutation.error) : null
				}
				canAct={fixedLinkActionReady}
				disconnectError={
					disconnectFixedLinkMutation.isError
						? errorText(disconnectFixedLinkMutation.error)
						: null
				}
				fixedLinkStatus={fixedLinkStatus}
				hasFixedLink={hasFixedLink}
				isAllocating={allocateMutation.isPending}
				isDisconnecting={disconnectFixedLinkMutation.isPending}
				isSigningIn={signInMutation.isPending}
				signedIn={signedIn}
				signInError={
					signInMutation.isError ? errorText(signInMutation.error) : null
				}
				stableHost={stableHost}
				step={fixedLinkStep}
				onCreateFixedLink={() => allocateMutation.mutate()}
				onDisconnectFixedLink={() => disconnectFixedLinkMutation.mutate()}
				onSignInCloudflare={() => signInMutation.mutate()}
			/>

			{enableMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(enableMutation.error)}
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
