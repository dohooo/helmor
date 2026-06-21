import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { getPreloadedLanguage } from "@/lib/settings";
import { defaultNS, resources } from "./resources";
import type { AppLanguage } from "./types";

if (!i18n.isInitialized) {
	void i18n.use(initReactI18next).init({
		resources,
		defaultNS,
		lng: getPreloadedLanguage(),
		fallbackLng: "en",
		// Flat keys: ":" / "." appear inside keys/values, not as separators.
		nsSeparator: false,
		keySeparator: false,
		interpolation: { escapeValue: false },
		returnNull: false,
		returnEmptyString: false,
		react: { useSuspense: false },
	});
}

/** Sync app language into i18next + the document lang attribute. */
export function setAppLanguage(language: AppLanguage): void {
	if (i18n.language !== language) void i18n.changeLanguage(language);
	if (typeof document !== "undefined") {
		document.documentElement.lang = language;
	}
}

export { i18n };
