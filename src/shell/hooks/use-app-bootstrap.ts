import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hydrateDraftCache } from "@/features/composer/draft-storage";
import type { ContextProviderTab, SettingsSection } from "@/features/settings";
import { exitOnboardingWindowMode } from "@/lib/api";
import { setCurrentLanguage } from "@/lib/i18n";
import { createHelmorQueryClient } from "@/lib/query-client";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	getPreloadedSettings,
	loadSettings,
	saveSettings,
} from "@/lib/settings";
import { useTransportGeneration } from "@/lib/transport-generation";
import { isQuickPanelWindow } from "@/lib/window-role";
import {
	SPLASH_FADE_MS,
	SPLASH_MIN_DURATION_MS,
	SPLASH_POST_ONBOARDING_DELAY_MS,
} from "@/shell/constants";
import { useShellEvent } from "@/shell/event-bus";

export interface AppBootstrap {
	appSettings: AppSettings | null;
	settingsOpen: boolean;
	settingsWorkspaceId: string | null;
	settingsWorkspaceRepoId: string | null;
	settingsInitialSection: SettingsSection | undefined;
	settingsInitialInboxProvider: ContextProviderTab | undefined;
	queryClient: QueryClient;
	/** Transport generation — bumped on an in-place team↔local switch. The
	 *  provider subtree in `AppProviders` keys on it to remount against the new
	 *  transport, and the QueryClient is recreated each generation. */
	transportGeneration: number;
	settingsContextValue: {
		settings: AppSettings;
		isLoaded: boolean;
		updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
	};
	splashVisible: boolean;
	splashMounted: boolean;
	completeOnboarding: () => void;
	setSettingsOpen: (open: boolean) => void;
	setSettingsWorkspaceId: (id: string | null) => void;
	setSettingsWorkspaceRepoId: (id: string | null) => void;
	setSettingsInitialSection: (section: SettingsSection | undefined) => void;
}

export function useAppBootstrap(): AppBootstrap {
	const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [settingsWorkspaceId, setSettingsWorkspaceId] = useState<string | null>(
		null,
	);
	const [settingsWorkspaceRepoId, setSettingsWorkspaceRepoId] = useState<
		string | null
	>(null);
	const [settingsInitialSection, setSettingsInitialSection] =
		useState<SettingsSection>();
	const [settingsInitialInboxProvider, setSettingsInitialInboxProvider] =
		useState<ContextProviderTab | undefined>();
	// Derive the QueryClient from the transport generation: a team↔local switch
	// bumps the generation, and a new backend has a disjoint data namespace
	// (different workspace/session ids). Recreating the client gives a brand-new
	// empty cache — the airtight guarantee against cross-transport data bleed
	// (vs `clear()` + invalidate, which would keep stale rows visible until the
	// ~120s cold-start refetch resolves). A ref keyed on the generation recreates
	// it EXACTLY once per generation, which is StrictMode-safe (unlike
	// `useState(() => create())`, which StrictMode would call twice and discard
	// one of, leaking the discarded client's focus listener).
	const transportGeneration = useTransportGeneration();
	const clientRef = useRef<{ gen: number; client: QueryClient } | null>(null);
	if (
		clientRef.current === null ||
		clientRef.current.gen !== transportGeneration
	) {
		clientRef.current = {
			gen: transportGeneration,
			client: createHelmorQueryClient(),
		};
	}
	const queryClient = clientRef.current.client;
	const preloadSettings = useMemo<AppSettings>(
		() => getPreloadedSettings(),
		[],
	);

	const settingsContextValue = useMemo(
		() => ({
			settings: appSettings ?? preloadSettings,
			isLoaded: appSettings !== null,
			updateSettings: (patch: Partial<AppSettings>) => {
				setAppSettings((previous) => {
					const next = { ...(previous ?? DEFAULT_SETTINGS), ...patch };
					return next;
				});
				return saveSettings(patch);
			},
		}),
		[appSettings, preloadSettings],
	);
	useEffect(() => {
		setCurrentLanguage(settingsContextValue.settings.language);
	}, [settingsContextValue.settings.language]);
	useShellEvent("open-settings", (event) => {
		setSettingsInitialSection(event.section);
		setSettingsInitialInboxProvider(event.inboxProvider);
		setSettingsWorkspaceId(null);
		setSettingsWorkspaceRepoId(null);
		setSettingsOpen(true);
	});
	const [splashVisible, setSplashVisible] = useState(true);
	const [splashMounted, setSplashMounted] = useState(true);

	const hideSplashAfterBoot = useCallback(() => {
		window.setTimeout(() => {
			setSplashVisible(false);
			window.setTimeout(() => setSplashMounted(false), SPLASH_FADE_MS);
		}, SPLASH_POST_ONBOARDING_DELAY_MS);
	}, []);

	const completeOnboarding = useCallback(() => {
		setSplashMounted(true);
		setSplashVisible(true);
		// Land on the start page; even without a repo the user can chat.
		setAppSettings((previous) => ({
			...(previous ?? DEFAULT_SETTINGS),
			onboardingCompleted: true,
			lastSurface: "workspace-start",
		}));
		void saveSettings({
			onboardingCompleted: true,
			lastSurface: "workspace-start",
		});

		requestAnimationFrame(() => {
			requestAnimationFrame(hideSplashAfterBoot);
		});
	}, [hideSplashAfterBoot]);

	useEffect(() => {
		const minDelay = new Promise<void>((r) =>
			setTimeout(r, SPLASH_MIN_DURATION_MS),
		);
		// Pull persisted composer drafts into the in-memory cache before
		// the splash hides — the composer's sync `loadPersistedDraft` then
		// sees DB content on first mount instead of flickering.
		const draftHydration = hydrateDraftCache();
		void Promise.all([
			loadSettings().then(setAppSettings),
			draftHydration,
			minDelay,
		]).then(() => {
			setSplashVisible(false);
			setTimeout(() => setSplashMounted(false), SPLASH_FADE_MS);
		});
	}, []);

	useEffect(() => {
		if (appSettings?.onboardingCompleted !== true) {
			return;
		}
		// The command restores the INVOKING window's size constraints — from
		// the quick panel it would blow the small card up to main-window size.
		if (isQuickPanelWindow) {
			return;
		}

		void exitOnboardingWindowMode().catch((error) => {
			console.error("[app] failed to restore main window mode", error);
		});
	}, [appSettings?.onboardingCompleted]);

	useShellEvent("reload-settings", () => {
		void loadSettings().then(setAppSettings);
	});

	// After an in-place transport switch, settings now resolve from the NEW
	// backend (`loadSettings` routes through `invoke`). Reconcile in the
	// background WITHOUT resetting `appSettings` first — keeping the current
	// settings in state means no splash flash and no theme flicker; the new
	// backend's values fold in once they resolve. Skipped on the initial mount
	// (generation 0) since `loadSettings` already runs in the boot effect above.
	//
	// `onboardingCompleted` is deliberately NOT overwritten from the reconcile: a
	// fresh team backend may report it false (or a default map), which would bounce
	// an already-onboarded user back into the splash. Onboarding is a one-time,
	// device-local milestone for the purpose of this gate — preserve it.
	const prevGenerationRef = useRef(transportGeneration);
	useEffect(() => {
		if (prevGenerationRef.current === transportGeneration) return;
		prevGenerationRef.current = transportGeneration;
		void loadSettings()
			.then((next) => {
				setAppSettings((previous) =>
					previous
						? { ...next, onboardingCompleted: previous.onboardingCompleted }
						: next,
				);
			})
			.catch(() => {
				// A backend without settings IPC keeps the current in-memory
				// settings — harmless; the UI stays on the preserved values.
			});
	}, [transportGeneration]);

	return {
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
	};
}
