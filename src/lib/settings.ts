import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext } from "react";

export type AppSettings = {
	fontSize: number; // px, default 14
};

export const DEFAULT_SETTINGS: AppSettings = {
	fontSize: 14,
};

const SETTINGS_KEY_MAP: Record<keyof AppSettings, string> = {
	fontSize: "app.font_size",
};

export async function loadSettings(): Promise<AppSettings> {
	try {
		const raw = await invoke<Record<string, string>>("get_app_settings");
		return {
			fontSize: raw[SETTINGS_KEY_MAP.fontSize]
				? Number(raw[SETTINGS_KEY_MAP.fontSize])
				: DEFAULT_SETTINGS.fontSize,
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
			settings[dbKey] = String(value);
		}
	}
	try {
		await invoke("update_app_settings", { settings });
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
