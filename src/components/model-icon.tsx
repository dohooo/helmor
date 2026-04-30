import { Box } from "lucide-react";
import {
	ClaudeColorIcon,
	DeepSeekIcon,
	KimiIcon,
	MinimaxIcon,
	OpenAIColorIcon,
	QwenIcon,
	XiaomiMiMoIcon,
	ZhipuIcon,
} from "@/components/icons";
import type { AgentModelOption } from "@/lib/api";

export function ModelIcon({
	model,
	className,
}: {
	model?: AgentModelOption | null;
	className?: string;
}) {
	if (model?.provider === "codex")
		return <OpenAIColorIcon className={className} />;
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
