import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext } from "react";

export type ThemeMode = "system" | "light" | "dark";

export type AppSettings = {
	fontSize: number;
	branchPrefixType: "github" | "custom" | "none";
	branchPrefixCustom: string;
	theme: ThemeMode;
	notifications: boolean;
	lastWorkspaceId: string | null;
	lastSessionId: string | null;
	defaultModelId: string | null;
	defaultEffort: string | null;
};

export const DEFAULT_SETTINGS: AppSettings = {
	fontSize: 14,
	branchPrefixType: "github",
	branchPrefixCustom: "",
	theme: "system",
	notifications: true,
	lastWorkspaceId: null,
	lastSessionId: null,
	defaultModelId: "default",
	defaultEffort: "high",
};

export const THEME_STORAGE_KEY = "helmor-theme";

// theme is stored in localStorage (sync read for flash-free boot), not SQLite
const SETTINGS_KEY_MAP: Record<Exclude<keyof AppSettings, "theme">, string> = {
	fontSize: "app.font_size",
	branchPrefixType: "branch_prefix_type",
	branchPrefixCustom: "branch_prefix_custom",
	notifications: "app.notifications",
	lastWorkspaceId: "app.last_workspace_id",
	lastSessionId: "app.last_session_id",
	defaultModelId: "app.default_model_id",
	defaultEffort: "app.default_effort",
};

export async function loadSettings(): Promise<AppSettings> {
	try {
		const raw = await invoke<Record<string, string>>("get_app_settings");
		return {
			fontSize: raw[SETTINGS_KEY_MAP.fontSize]
				? Number(raw[SETTINGS_KEY_MAP.fontSize])
				: DEFAULT_SETTINGS.fontSize,
			branchPrefixType:
				(raw[
					SETTINGS_KEY_MAP.branchPrefixType
				] as AppSettings["branchPrefixType"]) ??
				DEFAULT_SETTINGS.branchPrefixType,
			branchPrefixCustom:
				raw[SETTINGS_KEY_MAP.branchPrefixCustom] ??
				DEFAULT_SETTINGS.branchPrefixCustom,
			theme:
				(localStorage.getItem(THEME_STORAGE_KEY) as AppSettings["theme"]) ??
				DEFAULT_SETTINGS.theme,
			notifications:
				raw[SETTINGS_KEY_MAP.notifications] !== undefined
					? raw[SETTINGS_KEY_MAP.notifications] === "true"
					: DEFAULT_SETTINGS.notifications,
			lastWorkspaceId: raw[SETTINGS_KEY_MAP.lastWorkspaceId] || null,
			lastSessionId: raw[SETTINGS_KEY_MAP.lastSessionId] || null,
			defaultModelId:
				raw[SETTINGS_KEY_MAP.defaultModelId] || DEFAULT_SETTINGS.defaultModelId,
			defaultEffort:
				raw[SETTINGS_KEY_MAP.defaultEffort] || DEFAULT_SETTINGS.defaultEffort,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
	if (patch.theme !== undefined) {
		try {
			localStorage.setItem(THEME_STORAGE_KEY, patch.theme);
		} catch {
			// ignore
		}
	}

	const settings: Record<string, string> = {};
	for (const [key, dbKey] of Object.entries(SETTINGS_KEY_MAP)) {
		const value = patch[key as keyof Omit<AppSettings, "theme">];
		if (value !== undefined) {
			settings[dbKey] = value === null ? "" : String(value);
		}
	}
	if (Object.keys(settings).length === 0) return;
	try {
		await invoke("update_app_settings", { settingsMap: settings });
	} catch {
		// ignore — non-Tauri env
	}
}

export type SettingsContextValue = {
	settings: AppSettings;
	updateSettings: (patch: Partial<AppSettings>) => void;
};

export const SettingsContext = createContext<SettingsContextValue>({
	settings: DEFAULT_SETTINGS,
	updateSettings: () => {},
});

export function useSettings(): SettingsContextValue {
	return useContext(SettingsContext);
}

/** Resolve the effective theme ("light" | "dark") from a ThemeMode setting. */
export function resolveTheme(mode: ThemeMode): "light" | "dark" {
	if (mode === "system") {
		if (
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function"
		) {
			return window.matchMedia("(prefers-color-scheme: dark)").matches
				? "dark"
				: "light";
		}
		return "dark";
	}
	return mode;
}
