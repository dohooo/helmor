import { Box } from "lucide-react";
import {
	ClaudeColorIcon,
	CursorIcon,
	DeepSeekIcon,
	KimiIcon,
	MinimaxIcon,
	OpenAIColorIcon,
	OpenCodeIcon,
	ProviderBrandIcon,
	type ProviderBrandIconKey,
	QwenIcon,
	XiaomiMiMoIcon,
	ZhipuIcon,
} from "@/components/icons";
import { type AgentModelOption, isCodexProvider } from "@/lib/api";
import catalog from "@/shared/provider-catalog.json";

/// opencode-protocol slug `<providerID>/<modelID>`: map providerID via the
/// shared catalog (same as Settings). One map serves opencode AND mimo — the
/// fork supports the same provider ids plus its own (`xiaomi`, `mimo`).
const OPENCODE_ICON_BY_ID = new Map(
	[
		...(catalog.mimo as Array<{ key: string; icon: ProviderBrandIconKey }>),
		...(catalog.opencode as Array<{ key: string; icon: ProviderBrandIconKey }>),
	].map((p) => [p.key, p.icon]),
);

export function ModelIcon({
	model,
	className,
}: {
	model?: AgentModelOption | null;
	className?: string;
}) {
	if (model?.provider === "cursor") return <CursorIcon className={className} />;
	if (isCodexProvider(model?.provider))
		return <OpenAIColorIcon className={className} />;
	if (model?.provider === "opencode" || model?.provider === "mimo") {
		const providerId = model.cliModel.split("/")[0] ?? "";
		if (providerId === "anthropic")
			return <ClaudeColorIcon className={className} />;
		if (providerId === "openai")
			return <OpenAIColorIcon className={className} />;
		if (providerId === "opencode")
			return <OpenCodeIcon className={className} />;
		// mimo's bundled meta-provider (`mimo/mimo-auto`) + the official
		// `xiaomi` platform both brand as Xiaomi MiMo.
		if (providerId === "mimo") return <XiaomiMiMoIcon className={className} />;
		const icon = OPENCODE_ICON_BY_ID.get(providerId);
		if (icon) return <ProviderBrandIcon icon={icon} className={className} />;
		return <Box className={className} strokeWidth={1.8} />;
	}
	if (model?.providerKey === "custom")
		return <Box className={className} strokeWidth={1.8} />;
	if (model?.providerKey === "minimax" || model?.providerKey === "minimax-cn")
		return <MinimaxIcon className={className} />;
	if (model?.providerKey === "moonshot" || model?.providerKey === "moonshot-cn")
		return <KimiIcon className={className} />;
	if (model?.providerKey === "deepseek")
		return <DeepSeekIcon className={className} />;
	if (model?.providerKey === "zai" || model?.providerKey === "zai-cn")
		return <ZhipuIcon className={className} />;
	if (model?.providerKey === "qwen" || model?.providerKey === "qwen-intl")
		return <QwenIcon className={className} />;
	if (model?.providerKey === "xiaomi")
		return <XiaomiMiMoIcon className={className} />;
	return <ClaudeColorIcon className={className} />;
}
