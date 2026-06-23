import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
	allocateStableUrl,
	type CompanionPairingPayload,
	type CompanionStatus,
	destroyStableUrl,
	disableCompanion,
	enableCompanion,
	getCompanionStatus,
	listPairedDevices,
	pairCompanionDevice,
	revokePairedDevice,
	signInCloudflare,
} from "@/lib/api";
import { formatSource, I18nText, useI18n } from "@/lib/i18n";
import { helmorQueryKeys } from "@/lib/query-client";
import { SettingsGroup, SettingsRow } from "../components/settings-row";

const COMPANION_STATUS_KEY = ["companionStatus"] as const;

const DISABLED_STATUS: CompanionStatus = {
	running: false,
	addr: null,
	publicUrl: null,
	mode: "none",
	stableHost: null,
	signedIn: false,
};

function deviceLabel(): string {
	const date = new Date().toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
	return formatSource("settingsPhoneDeviceLabel", { date });
}

function formatLastSeen(
	ts: string | null,
	t: (key: string) => string,
	f: (key: string, values: Record<string, string | number>) => string,
): string {
	if (!ts) return t("settingsNeverConnected");
	const parsed = new Date(ts);
	if (Number.isNaN(parsed.getTime())) return t("settingsLastSeenRecently");
	return f("settingsLastSeenAt", { time: parsed.toLocaleString() });
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/// Settings → Experimental panel for the mobile browser companion. Enabling
/// starts the loopback server + a cloudflared tunnel; the "Permanent URL"
/// section upgrades the ephemeral quick tunnel to a stable
/// remote-*.helmor.ai address; pairing mints a per-device token shown as a QR.
export function MobileCompanionPanel() {
	const { t, f } = useI18n();
	const queryClient = useQueryClient();
	const [pairing, setPairing] = useState<CompanionPairingPayload | null>(null);
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

	const running = statusQuery.data?.running ?? false;
	const publicUrl = statusQuery.data?.publicUrl ?? null;
	const signedIn = statusQuery.data?.signedIn ?? false;
	const stableHost = statusQuery.data?.stableHost ?? null;
	const devices = devicesQuery.data ?? [];

	const setStatus = (status: CompanionStatus) =>
		queryClient.setQueryData(COMPANION_STATUS_KEY, status);

	const enableMutation = useMutation({
		mutationFn: enableCompanion,
		onSuccess: setStatus,
	});
	const disableMutation = useMutation({
		mutationFn: disableCompanion,
		onSuccess: () => {
			setPairing(null);
			setStatus(DISABLED_STATUS);
		},
	});
	const signInMutation = useMutation({
		mutationFn: signInCloudflare,
		onSuccess: () => void statusQuery.refetch(),
	});
	const allocateMutation = useMutation({
		mutationFn: allocateStableUrl,
		onSuccess: (status) => {
			setPairing(null);
			setStatus(status);
		},
	});
	const forgetMutation = useMutation({
		mutationFn: destroyStableUrl,
		onSuccess: (status) => {
			setPairing(null);
			setStatus(status);
		},
	});
	const pairMutation = useMutation({
		mutationFn: () => pairCompanionDevice(deviceLabel()),
		onSuccess: (payload) => {
			setPairing(payload);
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.pairedDevices,
			});
		},
	});
	const revokeMutation = useMutation({
		mutationFn: (id: string) => revokePairedDevice(id),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.pairedDevices,
			});
		},
	});

	const toggling = enableMutation.isPending || disableMutation.isPending;

	return (
		<SettingsGroup>
			<SettingsRow
				title="mobileCompanion"
				description="driveHelmorFromPhoneSBrowser"
			>
				<div className="flex items-center gap-2">
					{enableMutation.isPending ? (
						<span className="text-small text-muted-foreground">
							<I18nText source="starting" />
						</span>
					) : null}
					<Switch
						checked={running}
						disabled={toggling}
						onCheckedChange={(checked) => {
							if (checked) enableMutation.mutate();
							else disableMutation.mutate();
						}}
						aria-label="enableMobileCompanion"
					/>
				</div>
			</SettingsRow>

			{enableMutation.isError ? (
				<p className="py-2 text-small text-destructive">
					{errorText(enableMutation.error)}
				</p>
			) : null}

			{running ? (
				<>
					<SettingsRow
						title="permanentUrl"
						align="start"
						description={
							stableHost
								? "phoneConnectsFixedAddressSurvivesDesktop"
								: signedIn
									? "allocatePermanentRemoteHelmorAiAddress"
									: "quickLinkChangesWhenRestartSign"
						}
					>
						{stableHost ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="cursor-pointer text-destructive hover:text-destructive"
								disabled={forgetMutation.isPending}
								onClick={() => forgetMutation.mutate()}
							>
								<I18nText
									source={
										forgetMutation.isPending ? "forgetting" : "settingsForget"
									}
								/>
							</Button>
						) : signedIn ? (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="cursor-pointer"
								disabled={allocateMutation.isPending}
								onClick={() => allocateMutation.mutate()}
							>
								<I18nText
									source={
										allocateMutation.isPending
											? "allocating"
											: "settingsAllocatePermanentUrl"
									}
								/>
							</Button>
						) : (
							<Button
								type="button"
								variant="secondary"
								size="sm"
								className="cursor-pointer"
								disabled={signInMutation.isPending}
								onClick={() => signInMutation.mutate()}
							>
								<I18nText
									source={
										signInMutation.isPending
											? "waitingBrowser"
											: "settingsSignInToCloudflare"
									}
								/>
							</Button>
						)}
					</SettingsRow>

					{stableHost ? (
						<p className="text-small text-muted-foreground">
							<I18nText source="permanentAddress" />{" "}
							<span className="font-mono text-foreground">{stableHost}</span>
						</p>
					) : null}
					{signInMutation.isError ? (
						<p className="py-1 text-small text-destructive">
							{errorText(signInMutation.error)}
						</p>
					) : null}
					{allocateMutation.isError ? (
						<p className="py-1 text-small text-destructive">
							{errorText(allocateMutation.error)}
						</p>
					) : null}

					<SettingsRow
						title="pairPhone"
						align="start"
						description={
							publicUrl
								? "generateQrCodeThenScanPhone"
								: "waitingPublicUrlComeUp"
						}
					>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="cursor-pointer"
							disabled={!publicUrl || pairMutation.isPending}
							onClick={() => pairMutation.mutate()}
						>
							<I18nText
								source={pairMutation.isPending ? "generating" : "pairPhone"}
							/>
						</Button>
					</SettingsRow>

					{pairMutation.isError ? (
						<p className="py-2 text-small text-destructive">
							{errorText(pairMutation.error)}
						</p>
					) : null}

					{pairing ? (
						<div className="flex flex-col items-center gap-3 py-5">
							<div className="rounded-lg bg-white p-3">
								<QRCodeSVG value={pairing.url} size={184} />
							</div>
							<p className="max-w-[340px] text-center text-small leading-snug text-muted-foreground">
								<I18nText source="scanPhoneSCameraCodeCarries" />
							</p>
							{/* Also expose the link as copyable text: phones that can't
							    scan can paste it into the browser, and it's the address to
							    add to the home screen. */}
							<div className="flex w-full max-w-[340px] items-start gap-2">
								<code className="min-w-0 flex-1 select-all break-all rounded-md border border-border/40 bg-muted/40 px-2 py-1.5 text-nano leading-snug text-muted-foreground">
									{pairing.url}
								</code>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="shrink-0 cursor-pointer"
									onClick={() => {
										void navigator.clipboard?.writeText(pairing.url);
										setCopied(true);
										window.setTimeout(() => setCopied(false), 1500);
									}}
								>
									<I18nText source={copied ? "copied" : "settingsCopy"} />
								</Button>
							</div>
						</div>
					) : null}

					<div className="flex flex-col gap-2 py-5">
						<p className="text-ui font-medium text-foreground">
							<I18nText source="pairedDevices" />
						</p>
						{devices.length === 0 ? (
							<p className="text-small text-muted-foreground">
								<I18nText source="noPhonesPairedYet" />
							</p>
						) : (
							devices.map((device) => (
								<div
									key={device.id}
									className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2"
								>
									<div className="flex min-w-0 flex-col">
										<span className="truncate text-ui text-foreground">
											{device.label}
										</span>
										<span className="text-nano text-muted-foreground">
											{formatLastSeen(device.lastSeenAt, t, f)}
										</span>
									</div>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="cursor-pointer text-destructive hover:text-destructive"
										disabled={revokeMutation.isPending}
										onClick={() => revokeMutation.mutate(device.id)}
									>
										<I18nText source="revoke" />
									</Button>
								</div>
							))
						)}
					</div>
				</>
			) : null}
		</SettingsGroup>
	);
}
