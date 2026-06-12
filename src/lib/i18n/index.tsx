import {
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useMemo,
} from "react";
import { useSettings } from "@/lib/settings";
import { ZH_CN_MESSAGES } from "./messages";
import { type AppLanguage, DEFAULT_APP_LANGUAGE } from "./types";

const MESSAGE_TABLES: Record<AppLanguage, Record<string, string>> = {
	en: {},
	"zh-CN": ZH_CN_MESSAGES,
};

let currentLanguage: AppLanguage = DEFAULT_APP_LANGUAGE;
type I18nFormatValue = string | number;

function normalizeSource(source: string): string {
	return source.replace(/\s+/g, " ").trim();
}

export function setCurrentLanguage(language: AppLanguage): void {
	currentLanguage = language;
	if (typeof document !== "undefined") {
		document.documentElement.lang = language === "zh-CN" ? "zh-CN" : "en";
	}
}

export function getCurrentLanguage(): AppLanguage {
	return currentLanguage;
}

export function translateSource(
	source: string,
	language = currentLanguage,
): string {
	if (language === "en") return source;
	const table = MESSAGE_TABLES[language];
	return table[source] ?? table[normalizeSource(source)] ?? source;
}

export function formatSource(
	source: string,
	values: Record<string, I18nFormatValue>,
	language = currentLanguage,
): string {
	const template = translateSource(source, language);
	return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
		const value = values[key];
		return value === undefined ? match : String(value);
	});
}

export function translateSourceMaybe(
	source: string | undefined,
	language = currentLanguage,
): string | undefined {
	return source === undefined ? undefined : translateSource(source, language);
}

export function useI18n() {
	const { settings } = useSettings();
	const language = settings.language;
	return useMemo(
		() => ({
			language,
			t: (source: string) => translateSource(source, language),
			f: (source: string, values: Record<string, I18nFormatValue>) =>
				formatSource(source, values, language),
		}),
		[language],
	);
}

function isSkippableElement(element: ReactElement): boolean {
	const props = element.props as { [key: string]: unknown };
	if (props["data-i18n-skip"]) return true;
	const type = element.type;
	return type === "code" || type === "pre" || type === "kbd";
}

export function localizeNode(
	node: ReactNode,
	translate: (source: string) => string,
): ReactNode {
	if (typeof node === "string") return translate(node);
	if (Array.isArray(node)) {
		return node.map((child) => localizeNode(child, translate));
	}
	if (!isValidElement(node) || isSkippableElement(node)) return node;
	const props = node.props as { children?: ReactNode };
	if (props.children === undefined) return node;
	return cloneElement(node, {
		children: localizeNode(props.children, translate),
	} as Partial<typeof props>);
}

export function useLocalizedNode(node: ReactNode): ReactNode {
	const { t } = useI18n();
	return useMemo(() => localizeNode(node, t), [node, t]);
}

export function I18nText({ source }: { source: string }) {
	const { t } = useI18n();
	return <>{t(source)}</>;
}
