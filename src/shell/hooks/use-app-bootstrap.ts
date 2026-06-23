import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
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
	const [queryClient] = useState(() => createHelmorQueryClient());
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

	return {
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
	};
}
