export type AppLanguage = "en" | "zh-CN" | "pt-BR";

export const DEFAULT_APP_LANGUAGE: AppLanguage = "en";

export const VALID_APP_LANGUAGES: readonly AppLanguage[] = [
	"en",
	"zh-CN",
	"pt-BR",
];

export const APP_LANGUAGE_OPTIONS: readonly {
	value: AppLanguage;
	label: string;
}[] = [
	{ value: "en", label: "English" },
	{ value: "zh-CN", label: "简体中文" },
	{ value: "pt-BR", label: "Português (Brasil)" },
];

export function isAppLanguage(value: unknown): value is AppLanguage {
	return (
		typeof value === "string" &&
		VALID_APP_LANGUAGES.includes(value as AppLanguage)
	);
}
