import { QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterProvider } from "@tanstack/react-router";
import {
	type ComponentType,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { QuitConfirmDialog } from "@/components/quit-confirm-dialog";
import { SplashScreen } from "@/components/splash-screen";
import { resetStreamingStore } from "@/features/conversation/state/streaming-store";
import { AppOnboarding } from "@/features/onboarding";
import type { SettingsSection } from "@/features/settings";
import { SettingsDialog } from "@/features/settings";
import { InviteAcceptHost } from "@/features/team/invite-accept-host";
import { I18nText } from "@/lib/i18n";
import { getPendingPairingToken, isRemoteTransport } from "@/lib/ipc";
import { helmorQueryPersister, QUERY_CACHE_BUSTER } from "@/lib/query-client";
import { resetSessionThreadPagination } from "@/lib/session-thread-pagination";
import { SettingsContext } from "@/lib/settings";
import { resetSubmitQueue } from "@/lib/use-submit-queue";
import { isQuickPanelWindow } from "@/lib/window-role";
import { router } from "@/router";
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
	transportGeneration,
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

	// On an in-place transport switch (the generation bumped), reset the state
	// that SURVIVES the keyed remount below and would otherwise bleed the old
	// backend into the new transport (plan §6.6 / §6.7):
	//   - the module-scoped memory-history ROUTER — its last location references
	//     a workspace/session id from the previous backend; navigate to "/" so the
	//     remounted tree's startup auto-select picks a valid one from the new
	//     backend instead of rendering a dangling selection.
	//   - the module-singleton stores keyed by backend session/workspace ids: the
	//     STREAMING store (per-context "a stream is live" gating + stop-session
	//     ids), the SUBMIT QUEUE (queued follow-ups bound to old sessions — must
	//     not drain into the new transport), and the thread PAGINATION hints.
	// (The selection controller's `displayed*` store is instance-level — created
	// via `useRef` in `useSelectionController`, inside the keyed subtree — so it
	// resets for free on the remount; only these module-scoped survivors need an
	// explicit reset.) Skipped on the initial mount (generation 0).
	const prevGenerationRef = useRef(transportGeneration);
	useEffect(() => {
		if (prevGenerationRef.current === transportGeneration) return;
		prevGenerationRef.current = transportGeneration;
		resetStreamingStore();
		resetSubmitQueue();
		resetSessionThreadPagination();
		void router.navigate({ to: "/" });
	}, [transportGeneration]);
	const onOpenSettings = useCallback(
		(
			workspaceId: string | null,
			workspaceRepoId: string | null,
			initialSection?: SettingsSection,
		) => {
			setSettingsInitialSection(initialSection);
			setSettingsWorkspaceId(workspaceId);
			setSettingsWorkspaceRepoId(workspaceRepoId);
			setSettingsOpen(true);
		},
		[
			setSettingsInitialSection,
			setSettingsWorkspaceId,
			setSettingsWorkspaceRepoId,
			setSettingsOpen,
		],
	);
	const routerContext = useMemo(
		() => ({ queryClient, onOpenSettings, appShell: AppShell }),
		[queryClient, onOpenSettings, AppShell],
	);
	const providerChildren = (
		<>
			{pendingPairing !== null ? (
				<CompanionPairingConfirm />
			) : companionAuth === "unauthed" ? (
				<CompanionPairingScreen />
			) : appSettings === null ? null : !appSettings.onboardingCompleted ? (
				isQuickPanelWindow ? (
					// The onboarding flow belongs to the main window; the panel
					// summoned mid-onboarding just points the user there.
					<div className="flex h-dvh items-center justify-center bg-background p-6 text-center text-ui text-muted-foreground">
						<I18nText source="finishSettingUpHelmorMainWindow" />
					</div>
				) : (
					<>
						<AppOnboarding onComplete={completeOnboarding} />
						<QuitConfirmDialog sessionRunStates={EMPTY_SESSION_RUN_STATES} />
					</>
				)
			) : (
				<RouterProvider router={router} context={routerContext} />
			)}
			{splashMounted && !isQuickPanelWindow && (
				<SplashScreen visible={splashVisible} />
			)}
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
			{/* Raises the team invite-accept prompt when the app was opened
			    with `?invite=<token>`. Renders nothing otherwise. Gated to
			    the main window post-onboarding. */}
			{appSettings?.onboardingCompleted === true && !isQuickPanelWindow ? (
				<InviteAcceptHost />
			) : null}
		</>
	);
	return (
		<SettingsContext.Provider value={settingsContextValue}>
			{/* Keyed on the transport generation so an in-place team↔local switch
			    fully remounts the QueryClient + router subtree against the new
			    transport. Persistence is gated off for remote transports (team /
			    companion): the persister calls local Tauri commands that remote
			    backends do not implement. */}
			{isRemoteTransport() ? (
				<QueryClientProvider key={transportGeneration} client={queryClient}>
					{providerChildren}
				</QueryClientProvider>
			) : (
				<PersistQueryClientProvider
					key={transportGeneration}
					client={queryClient}
					persistOptions={{
						persister: helmorQueryPersister,
						buster: QUERY_CACHE_BUSTER,
					}}
				>
					{providerChildren}
				</PersistQueryClientProvider>
			)}
		</SettingsContext.Provider>
	);
}
