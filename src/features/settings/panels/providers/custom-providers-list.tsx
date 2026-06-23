// The custom-providers editor for one family: a card per provider + an "Add" control.

import { ChevronDown, Plus, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import { ProviderBrandIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { I18nText } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { CustomProviderCard } from "./custom-provider-card";
import type { ProviderConfigAdapter, ProviderPreset } from "./provider-config";

function freshId(taken: ReadonlySet<string>): string {
	for (let i = 0; i < 50; i++) {
		const id = crypto.randomUUID().slice(0, 8);
		if (!taken.has(id)) return id;
	}
	return crypto.randomUUID();
}

export function CustomProvidersList({
	adapter,
}: {
	adapter: ProviderConfigAdapter;
}) {
	const { providers, upsert, remove } = adapter.useCustomProviders();
	const presetByKey = useMemo(
		() => new Map(adapter.presets.map((p) => [p.key, p])),
		[adapter.presets],
	);
	const taken = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);

	function addPreset(preset: ProviderPreset) {
		// Preset id IS the preset key — one slot per preset.
		void upsert({
			id: preset.key,
			name: preset.label,
			presetKey: preset.key,
			baseUrl: preset.baseUrl,
			apiKey: providers.find((p) => p.id === preset.key)?.apiKey ?? "",
			...(preset.apiStyle ? { apiStyle: preset.apiStyle } : {}),
			models: [],
			enabledModelIds: null,
		});
	}

	function addCustom() {
		void upsert({
			id: freshId(taken),
			name: "",
			baseUrl: "",
			apiKey: "",
			models: [],
			enabledModelIds: null,
		});
	}

	return (
		<div className="flex flex-col gap-3">
			{providers.map((provider) => (
				<CustomProviderCard
					key={provider.id}
					adapter={adapter}
					provider={provider}
					preset={
						provider.presetKey ? presetByKey.get(provider.presetKey) : undefined
					}
					onCommit={(next) => void upsert(next)}
					onRemove={() => void remove(provider.id)}
				/>
			))}
			<AddProviderMenu
				adapter={adapter}
				configuredKeys={taken}
				onAddPreset={addPreset}
				onAddCustom={addCustom}
			/>
		</div>
	);
}

function AddProviderMenu({
	adapter,
	configuredKeys,
	onAddPreset,
	onAddCustom,
}: {
	adapter: ProviderConfigAdapter;
	configuredKeys: ReadonlySet<string>;
	onAddPreset: (preset: ProviderPreset) => void;
	onAddCustom: () => void;
}) {
	// Claude endpoints speak Anthropic's API; every other family is OpenAI-style.
	const customLabel =
		adapter.family === "claude"
			? "customAnthropicCompatible"
			: "customOpenaiCompatible";
	const customItem = (
		<DropdownMenuItem onClick={onAddCustom} className="flex items-center gap-2">
			<SlidersHorizontal className="size-4 text-muted-foreground" />
			<I18nText source={customLabel} />
		</DropdownMenuItem>
	);

	if (adapter.presets.length === 0) {
		return (
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="h-8 w-fit gap-1.5 text-[13px]"
				onClick={onAddCustom}
			>
				<Plus className="size-3.5" />
				<I18nText source="addProvider" />
			</Button>
		);
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="h-8 w-fit gap-1.5 text-[13px]"
				>
					<Plus className="size-3.5" />
					<I18nText source="addProvider" />
					<ChevronDown className="size-3 opacity-50" />
				</Button>
			</DropdownMenuTrigger>
			{/* Don't refocus the trigger on close — that scroll-jumps the panel. */}
			<DropdownMenuContent
				align="start"
				className="max-h-[320px] w-[300px]"
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				{/* Custom always leads — most prominent, family-agnostic. */}
				{customItem}
				<DropdownMenuSeparator />
				{adapter.presets.map((preset) => (
					<DropdownMenuItem
						key={preset.key}
						onClick={() => onAddPreset(preset)}
						className="flex items-center justify-between gap-2"
					>
						<span className="flex items-center gap-2">
							<ProviderBrandIcon icon={preset.icon} className="size-4" />
							{preset.label}
						</span>
						<span
							className={cn(
								"size-1.5 rounded-full bg-emerald-500",
								!configuredKeys.has(preset.key) && "invisible",
							)}
						/>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
