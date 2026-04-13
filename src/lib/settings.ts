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
};

export const DEFAULT_SETTINGS: AppSettings = {
	fontSize: 14,
	branchPrefixType: "github",
	branchPrefixCustom: "",
	theme: "system",
	notifications: true,
	lastWorkspaceId: null,
	lastSessionId: null,
};

const SETTINGS_KEY_MAP: Record<keyof AppSettings, string> = {
	fontSize: "app.font_size",
	branchPrefixType: "branch_prefix_type",
	branchPrefixCustom: "branch_prefix_custom",
	theme: "app.theme",
	notifications: "app.notifications",
	lastWorkspaceId: "app.last_workspace_id",
	lastSessionId: "app.last_session_id",
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
				(raw[SETTINGS_KEY_MAP.theme] as AppSettings["theme"]) ??
				DEFAULT_SETTINGS.theme,
			notifications:
				raw[SETTINGS_KEY_MAP.notifications] !== undefined
					? raw[SETTINGS_KEY_MAP.notifications] === "true"
					: DEFAULT_SETTINGS.notifications,
			lastWorkspaceId: raw[SETTINGS_KEY_MAP.lastWorkspaceId] || null,
			lastSessionId: raw[SETTINGS_KEY_MAP.lastSessionId] || null,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<void> {
	const settings: Record<string, string> = {};
	for (const [key, dbKey] of Object.entries(SETTINGS_KEY_MAP)) {
		const value = patch[key as keyof AppSettings];
		if (value !== undefined) {
			settings[dbKey] = value === null ? "" : String(value);
		}
	}
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
