import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	Box,
	CheckCircle2,
	ChevronDown,
	SquareArrowOutUpRight,
	Trash2,
} from "lucide-react";
import type { SVGProps } from "react";
import { useEffect, useMemo, useState } from "react";
import {
	DeepSeekIcon,
	KimiIcon,
	MinimaxIcon,
	QwenIcon,
	XiaomiMiMoIcon,
	ZhipuIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { helmorQueryKeys } from "@/lib/query-client";
import type { ClaudeCustomProviderSettings } from "@/lib/settings";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { SettingsRow } from "../components/settings-row";
import {
	BUILTIN_CLAUDE_PROVIDERS,
	type BuiltinClaudeProviderKey,
	findBuiltinClaudeProvider,
} from "./builtin-claude-providers";

type ProviderKind = BuiltinClaudeProviderKey | "custom";

type Draft = {
	baseUrl: string;
	apiKey: string;
	models: string;
};

export function ClaudeCustomProvidersPanel() {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const value = settings.claudeCustomProviders;
	const builtinProviderApiKeys = value.builtinProviderApiKeys ?? {};
	const configuredItems = useMemo(() => getConfiguredItems(value), [value]);
	const initialKind = configuredItems[0]?.kind ?? "minimax";
	const [kind, setKind] = useState<ProviderKind>(initialKind);
	const [draft, setDraft] = useState<Draft>(() =>
		draftFromSettings(value, initialKind),
	);

	useEffect(() => {
		setDraft(draftFromSettings(value, kind));
	}, [kind, value]);

	function updateProvider(patch: Partial<ClaudeCustomProviderSettings>) {
		void Promise.resolve(
			updateSettings({
				claudeCustomProviders: {
					...value,
					...patch,
				},
			}),
		).then(() =>
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			}),
		);
	}

	function saveDraftIfComplete() {
		if (!canSave(kind, draft)) return;
		const apiKey = draft.apiKey.trim();
		if (kind === "custom") {
			updateProvider({
				customBaseUrl: draft.baseUrl.trim(),
				customApiKey: apiKey,
				customModels: draft.models.trim(),
			});
			return;
		}

		const nextKeys = { ...builtinProviderApiKeys };
		if (apiKey) {
			nextKeys[kind] = apiKey;
		} else {
			delete nextKeys[kind];
		}
		updateProvider({
			builtinProviderApiKeys: nextKeys,
		});
	}

	function removeProvider(itemKind: ProviderKind) {
		if (itemKind === "custom") {
			updateProvider({
				customBaseUrl: "",
				customApiKey: "",
				customModels: "",
			});
			if (kind === "custom") setKind("minimax");
			return;
		}

		const nextKeys = { ...builtinProviderApiKeys };
		delete nextKeys[itemKind];
		updateProvider({
			builtinProviderApiKeys: nextKeys,
		});
	}

	const builtinProvider =
		kind === "custom" ? null : findBuiltinClaudeProvider(kind);

	return (
		<SettingsRow
			title="Claude Code custom providers"
			description="Enter API keys here to use third-party models. They can be used alongside Claude Code's official models."
			align="start"
			className="gap-8"
		>
			<div className="flex w-[360px] flex-col gap-3">
				<div className="grid gap-2">
					<ProviderPicker
						kind={kind}
						configuredKinds={new Set(configuredItems.map((item) => item.kind))}
						onChange={setKind}
					/>

					{builtinProvider ? (
						<div className="flex items-center gap-2">
							<Input
								type="password"
								value={draft.apiKey}
								onBlur={saveDraftIfComplete}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										apiKey: event.target.value,
									}))
								}
								placeholder={`${builtinProvider.label} API key`}
								className="h-8 min-w-0 flex-1 border-border/50 bg-muted/20 text-[13px]"
							/>
							{!draft.apiKey && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									aria-label={`Get ${builtinProvider.label} API key`}
									onClick={() => void openUrl(builtinProvider.apiKeyUrl)}
								>
									Get your API key
									<SquareArrowOutUpRight className="size-3.5" />
								</Button>
							)}
						</div>
					) : (
						<div className="grid gap-2">
							<Input
								value={draft.baseUrl}
								onBlur={saveDraftIfComplete}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										baseUrl: event.target.value,
									}))
								}
								placeholder="Base URL"
								className="h-8 border-border/50 bg-muted/20 text-[13px]"
							/>
							<Input
								type="password"
								value={draft.apiKey}
								onBlur={saveDraftIfComplete}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										apiKey: event.target.value,
									}))
								}
								placeholder="API key"
								className="h-8 border-border/50 bg-muted/20 text-[13px]"
							/>
							<Textarea
								value={draft.models}
								onBlur={saveDraftIfComplete}
								onChange={(event) =>
									setDraft((current) => ({
										...current,
										models: event.target.value,
									}))
								}
								placeholder={`model-a
model-b
model-c`}
								className="h-20 resize-none overflow-y-auto border-border/50 bg-muted/20 text-[13px]"
							/>
						</div>
					)}
				</div>

				<ConfiguredProvidersList
					items={configuredItems}
					onRemove={removeProvider}
				/>
			</div>
		</SettingsRow>
	);
}
function ProviderPicker({
	kind,
	configuredKinds,
	onChange,
}: {
	kind: ProviderKind;
	configuredKinds: Set<ProviderKind>;
	onChange: (kind: ProviderKind) => void;
}) {
	const builtinProvider =
		kind === "custom" ? null : findBuiltinClaudeProvider(kind);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-[13px] text-foreground hover:bg-muted/50",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					{builtinProvider ? (
						<BuiltinProviderIcon
							icon={builtinProvider.icon}
							className="size-4"
						/>
					) : (
						<Box className="size-4 text-muted-foreground" />
					)}
					<span className="truncate">{builtinProvider?.label ?? "Custom"}</span>
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-40" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-[360px]">
				{BUILTIN_CLAUDE_PROVIDERS.map((provider) => (
					<DropdownMenuItem
						key={provider.key}
						onClick={() => onChange(provider.key)}
						className="flex items-center justify-between gap-3"
					>
						<span className="flex items-center gap-2">
							<BuiltinProviderIcon icon={provider.icon} className="size-4" />
							{provider.label}
						</span>
						{configuredKinds.has(provider.key) ? (
							<CheckCircle2 className="size-3.5 text-emerald-500" />
						) : null}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem
					onClick={() => onChange("custom")}
					className="flex items-center justify-between gap-3"
				>
					<span className="flex items-center gap-2">
						<Box className="size-4 text-muted-foreground" />
						Custom
					</span>
					{configuredKinds.has("custom") ? (
						<CheckCircle2 className="size-3.5 text-emerald-500" />
					) : null}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ConfiguredProvidersList({
	items,
	onRemove,
}: {
	items: ConfiguredItem[];
	onRemove: (kind: ProviderKind) => void;
}) {
	if (items.length === 0) {
		return (
			<div className="pt-1 text-[12px] text-muted-foreground">
				No third-party providers configured.
			</div>
		);
	}

	return (
		<div className="px-3 pt-1">
			{items.map((item, index) => (
				<div
					key={item.kind}
					className={cn(
						"flex min-h-8 items-center gap-2 py-1.5",
						index > 0 ? "border-t border-border/30" : null,
					)}
				>
					<div className="flex size-4 shrink-0 items-center justify-center">
						<ProviderIcon item={item} className="size-4" />
					</div>
					<div className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
						{item.label}
					</div>
					<div className="w-[88px] shrink-0 text-right font-mono text-[11px] text-muted-foreground">
						{item.keyPreview}
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={`Remove ${item.label}`}
						onClick={() => onRemove(item.kind)}
						className="text-muted-foreground hover:text-destructive"
					>
						<Trash2 className="size-3.5" strokeWidth={1.8} />
					</Button>
				</div>
			))}
		</div>
	);
}

type ConfiguredItem = {
	kind: ProviderKind;
	label: string;
	icon?: "minimax" | "moonshot" | "deepseek" | "zhipu" | "qwen" | "xiaomi";
	keyPreview: string;
};

function getConfiguredItems(
	value: ClaudeCustomProviderSettings,
): ConfiguredItem[] {
	const items: ConfiguredItem[] = [];
	const keys = value.builtinProviderApiKeys ?? {};
	for (const provider of BUILTIN_CLAUDE_PROVIDERS) {
		const apiKey = keys[provider.key]?.trim();
		if (!apiKey) continue;
		items.push({
			kind: provider.key,
			label: provider.label,
			icon: provider.icon,
			keyPreview: maskSecret(apiKey),
		});
	}
	if (isCustomConfigured(value)) {
		items.push({
			kind: "custom",
			label: "Custom",
			keyPreview: maskSecret(value.customApiKey),
		});
	}
	return items;
}

function draftFromSettings(
	value: ClaudeCustomProviderSettings,
	kind: ProviderKind,
): Draft {
	if (kind === "custom") {
		return {
			baseUrl: value.customBaseUrl,
			apiKey: value.customApiKey,
			models: value.customModels,
		};
	}
	return {
		baseUrl: "",
		apiKey: value.builtinProviderApiKeys?.[kind] ?? "",
		models: "",
	};
}

function canSave(kind: ProviderKind, draft: Draft): boolean {
	if (kind === "custom") {
		return Boolean(
			draft.baseUrl.trim() &&
				draft.apiKey.trim() &&
				parseModelList(draft.models).length > 0,
		);
	}
	return Boolean(draft.apiKey.trim());
}

function isCustomConfigured(value: ClaudeCustomProviderSettings): boolean {
	return Boolean(
		value.customBaseUrl.trim() &&
			value.customApiKey.trim() &&
			parseModelList(value.customModels).length > 0,
	);
}

function parseModelList(raw: string): string[] {
	return raw
		.split("\n")
		.map((item) => item.trim())
		.filter(Boolean);
}

function maskSecret(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= 8) return "••••";
	return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

function ProviderIcon({
	item,
	className,
}: {
	item: ConfiguredItem;
	className?: string;
}) {
	if (item.icon)
		return <BuiltinProviderIcon icon={item.icon} className={className} />;
	return <Box className={cn("text-muted-foreground", className)} />;
}

function BuiltinProviderIcon({
	icon,
	className,
}: {
	icon: "minimax" | "moonshot" | "deepseek" | "zhipu" | "qwen" | "xiaomi";
	className?: string;
}) {
	const props: SVGProps<SVGSVGElement> = { className };
	switch (icon) {
		case "moonshot":
			return <KimiIcon {...props} />;
		case "deepseek":
			return <DeepSeekIcon {...props} />;
		case "zhipu":
			return <ZhipuIcon {...props} />;
		case "qwen":
			return <QwenIcon {...props} />;
		case "xiaomi":
			return <XiaomiMiMoIcon {...props} />;
		default:
			return <MinimaxIcon {...props} />;
	}
}
