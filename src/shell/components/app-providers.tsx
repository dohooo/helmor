import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { type ComponentType, useState } from "react";
import { ForgeAccountsHealthSentinel } from "@/components/forge-accounts-health-sentinel";
import { QuitConfirmDialog } from "@/components/quit-confirm-dialog";
import { SplashScreen } from "@/components/splash-screen";
import { AppOnboarding } from "@/features/onboarding";
import type { SettingsSection } from "@/features/settings";
import { SettingsDialog } from "@/features/settings";
import { getPendingPairingToken } from "@/lib/ipc";
import { helmorQueryPersister, QUERY_CACHE_BUSTER } from "@/lib/query-client";
import { SettingsContext } from "@/lib/settings";
import { EMPTY_SESSION_RUN_STATES } from "@/shell/constants";
import type { AppBootstrap } from "@/shell/hooks/use-app-bootstrap";
import { useCompanionAuthState } from "@/shell/hooks/use-companion-auth";
import { CompanionPairingConfirm } from "./companion-pairing-confirm";
import { CompanionPairingScreen } from "./companion-pairing-screen";

interface AppProvidersProps extends AppBootstrap {
	AppShell: ComponentType<{
		onOpenSettings: (
			workspaceId: string | null,
			workspaceRepoId: string | null,
			initialSection?: SettingsSection,
		) => void;
	}>;
}

export function AppProviders({
	appSettings,
	settingsOpen,
	settingsWorkspaceId,
	settingsWorkspaceRepoId,
	settingsInitialSection,
	settingsInitialInboxProvider,
	queryClient,
	settingsContextValue,
	splashVisible,
	splashMounted,
	completeOnboarding,
	setSettingsOpen,
	setSettingsWorkspaceId,
	setSettingsWorkspaceRepoId,
	setSettingsInitialSection,
	AppShell,
}: AppProvidersProps) {
	const companionAuth = useCompanionAuthState();
	// Read once at mount: a scanned `#pair=` token is staged but not yet active.
	// Cleared by `confirmCompanionPairing`, which reloads (remounting this).
	const [pendingPairing] = useState(() => getPendingPairingToken());
	return (
		<SettingsContext.Provider value={settingsContextValue}>
			<PersistQueryClientProvider
				client={queryClient}
				persistOptions={{
					persister: helmorQueryPersister,
					buster: QUERY_CACHE_BUSTER,
				}}
			>
				{pendingPairing !== null ? (
					<CompanionPairingConfirm />
				) : companionAuth === "unauthed" ? (
					<CompanionPairingScreen />
				) : appSettings === null ? null : !appSettings.onboardingCompleted ? (
					<>
						<AppOnboarding onComplete={completeOnboarding} />
						<QuitConfirmDialog sessionRunStates={EMPTY_SESSION_RUN_STATES} />
					</>
				) : (
					<>
						{/* Renderless: focus-driven health probes for every
						 *  (provider, host) we know about. Without this the
						 *  reconciliation only ran while Settings → Accounts
						 *  was open, so a `gh auth login` outside Helmor
						 *  wouldn't trigger a re-bind until the user opened
						 *  that panel — leaving every workspace's chip
						 *  stuck on "Connect" indefinitely. */}
						<ForgeAccountsHealthSentinel />
						<AppShell
							onOpenSettings={(
								workspaceId,
								workspaceRepoId,
								initialSection,
							) => {
								setSettingsInitialSection(initialSection);
								setSettingsWorkspaceId(workspaceId);
								setSettingsWorkspaceRepoId(workspaceRepoId);
								setSettingsOpen(true);
							}}
						/>
					</>
				)}
				{splashMounted && <SplashScreen visible={splashVisible} />}
				<SettingsDialog
					open={settingsOpen}
					workspaceId={settingsWorkspaceId}
					workspaceRepoId={settingsWorkspaceRepoId}
					initialSection={settingsInitialSection}
					initialInboxProvider={settingsInitialInboxProvider}
					onClose={() => {
						setSettingsOpen(false);
						void queryClient.invalidateQueries({
							queryKey: ["repoScripts"],
						});
					}}
				/>
			</PersistQueryClientProvider>
		</SettingsContext.Provider>
	);
}
