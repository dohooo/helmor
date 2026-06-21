// Thin, key-based i18n API backed by react-i18next.
// Call sites pass catalog KEYS (see locales/en.json, zh-CN.json), never raw English.
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { i18n, setAppLanguage } from "./runtime";
import { type AppLanguage, DEFAULT_APP_LANGUAGE } from "./types";

export { setAppLanguage };
/** @deprecated use setAppLanguage */
export const setCurrentLanguage = setAppLanguage;

export function getCurrentLanguage(): AppLanguage {
	return (i18n.language as AppLanguage) ?? DEFAULT_APP_LANGUAGE;
}

type I18nFormatValue = string | number;

// Catalog values use {name} placeholders (single brace); i18next's own
// interpolation is {{name}}, so we resolve {name} ourselves.
function interpolate(
	template: string,
	values: Record<string, I18nFormatValue>,
): string {
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
		const value = values[key];
		return value === undefined ? match : String(value);
	});
}

// i18next's TFunction returns a wide type for non-literal keys; our app passes
// keys around as plain strings, so we normalize the result to string here.
// The typed `t` only accepts literal catalog keys; these wrappers accept any
// runtime key string, so they go through a loosely-typed view of `t`.
type LooseT = (
	key: string,
	options?: Record<string, I18nFormatValue>,
) => string;

/** Translate a key outside React. */
export function translateSource(key: string): string {
	return (i18n.t as unknown as LooseT)(key);
}

export function formatSource(
	key: string,
	values: Record<string, I18nFormatValue>,
): string {
	return interpolate((i18n.t as unknown as LooseT)(key, values), values);
}

export function translateSourceMaybe(
	key: string | undefined,
): string | undefined {
	return key === undefined ? undefined : (i18n.t as unknown as LooseT)(key);
}

export function useI18n() {
	const { t, i18n: instance } = useTranslation();
	const language = instance.language as AppLanguage;
	return useMemo(() => {
		const tt = t as unknown as LooseT;
		return {
			language,
			t: (key: string): string => tt(key),
			f: (key: string, values: Record<string, I18nFormatValue>): string =>
				interpolate(tt(key, values), values),
		};
	}, [t, language]);
}

/** Renders a translated catalog key as text. */
export function I18nText({ source }: { source: string }) {
	const { t } = useTranslation();
	return <>{(t as unknown as LooseT)(source)}</>;
}

/** Translate a node when it is a string catalog key; pass through otherwise.
 *  Used by wrapper components (SettingsRow, etc.) whose title/description props
 *  accept either a key string or already-localized JSX. */
export function useLocalizedNode(node: ReactNode): ReactNode {
	const { t } = useTranslation();
	return typeof node === "string" ? (t as unknown as LooseT)(node) : node;
}
