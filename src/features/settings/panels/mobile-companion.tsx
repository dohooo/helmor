import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	allocateStableUrl,
	type CompanionPairingPayload,
	type CompanionStatus,
	enableCompanion,
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

	const publicUrl = statusQuery.data?.publicUrl ?? null;
	const signedIn = statusQuery.data?.signedIn ?? false;
	const stableHost = statusQuery.data?.stableHost ?? null;
	const hasFixedLink = stableHost !== null;
	const devices = devicesQuery.data ?? [];
	const pairing = pairingQuery.data ?? null;
	const pairingIsCurrent = pairingMatchesPublicUrl(pairing, publicUrl);
	const replacePendingDeviceId = pairing?.deviceId;

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

	// Gate on the public URL, not `running`: the server can be up loopback-only
	// (HELMOR_COMPANION auto-start, or a stable-URL tunnel that failed at launch)
	// with no tunnel, and pairing needs a public origin. `companion_enable` is
	// idempotent on the server and just brings the missing tunnel up.
	useEffect(() => {
		if (!statusQuery.isSuccess) return;
		if (publicUrl || enableMutation.isPending || enableMutation.isError) return;
		enableMutation.mutate();
	}, [
		statusQuery.isSuccess,
		publicUrl,
		enableMutation.isPending,
		enableMutation.isError,
		enableMutation.mutate,
	]);

	const starting = statusQuery.isPending || enableMutation.isPending;
	useEffect(() => {
		if (!publicUrl || starting || pairingCodeMutation.isPending) return;
		if (pairingIsCurrent) return;
		pairingCodeMutation.mutate({
			replaceDeviceId: replacePendingDeviceId,
		});
	}, [
		publicUrl,
		starting,
		pairingIsCurrent,
		replacePendingDeviceId,
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
	const fixedLinkActionReady = !starting && !enableMutation.isError;
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
						replaceDeviceId: replacePendingDeviceId,
					})
				}
				onRetryMobileAccess={() => enableMutation.mutate()}
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
