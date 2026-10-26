import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";
import ptBR from "./locales/pt-BR.json";

export const defaultNS = "translation" as const;

export const resources = {
	en: { translation: en },
	"zh-CN": { translation: zhCN },
	"pt-BR": { translation: ptBR },
} as const;
