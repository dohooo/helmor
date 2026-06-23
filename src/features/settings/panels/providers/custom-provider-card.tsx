// One custom-provider card, shared by every family.

import {
	ChevronDown,
	Pencil,
	Plus,
	RefreshCcw,
	SquareArrowOutUpRight,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ProviderBrandIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { I18nText, useI18n } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import type {
	CustomProvider,
	CustomProviderModel,
} from "@/lib/provider-config";
import { cn } from "@/lib/utils";
import type {
	ProviderConfigAdapter,
	ProviderPreset,
	StyleOption,
} from "./provider-config";

type FetchState = { loading: boolean; error: string | null };

// Default wire-protocol options (OpenCode/MiMo). Adapters override via
// `styleOptions` — e.g. Kimi supplies openai/anthropic/… .
const DEFAULT_STYLE_OPTIONS: StyleOption[] = [
	{
		value: "chat",
		label: "chatCompletions",
		hint: "v1ChatCompletionsWidestCompatibility",
	},
	{
		value: "responses",
		label: "responsesApi",
		hint: "v1ResponsesAdvancedReasoningTools",
	},
];

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function CustomProviderCard({
	adapter,
	provider,
	preset,
	onCommit,
	onRemove,
}: {
	adapter: ProviderConfigAdapter;
	provider: CustomProvider;
	preset: ProviderPreset | undefined;
	onCommit: (provider: CustomProvider) => void;
	onRemove: () => void;
}) {
	const { t, f } = useI18n();
	const [draft, setDraft] = useState(provider);
	const [fetchState, setFetchState] = useState<FetchState>({
		loading: false,
		error: null,
	});
	// Manual-edit mode: a textarea of model slugs, one per line.
	const [editing, setEditing] = useState(false);
	const [manualText, setManualText] = useState("");

	// Re-sync when the persisted provider changes from elsewhere.
	const providerKey = JSON.stringify(provider);
	useEffect(() => {
		setDraft(provider);
	}, [providerKey]);

	const isManual = !provider.presetKey;
	// Registry presets: API key only, models come from the server.
	const apiKeyOnly = Boolean(preset?.apiKeyOnly);
	const hasModels = draft.models.length > 0;
	const canFetch = draft.baseUrl.trim().length > 0;
	// Claude endpoints are Anthropic-style (base must NOT end in /v1 — the SDK
	// appends /v1/messages and fetch appends /v1/models). Others are /v1.
	const baseUrlPlaceholder =
		adapter.family === "claude" ? "baseUrlHttpsAnthropic" : "baseUrlHttpsV1";

	function patch(next: Partial<CustomProvider>) {
		setDraft((current) => ({ ...current, ...next }));
	}
	function commitText() {
		onCommit(draft);
	}
	function commit(next: Partial<CustomProvider>) {
		const merged = { ...draft, ...next };
		setDraft(merged);
		onCommit(merged);
	}

	async function refresh() {
		if (!canFetch) return;
		setFetchState({ loading: true, error: null });
		try {
			const models = await adapter.fetchModels(draft);
			setFetchState({
				loading: false,
				error: models.length ? null : t("noModelsReturnedByEndpoint"),
			});
			commit({ models });
		} catch (error) {
			setFetchState({ loading: false, error: errorMessage(error) });
		}
	}

	function openManual() {
		setManualText(draft.models.map((m) => m.slug).join("\n"));
		setEditing(true);
	}

	// Parse the textarea on blur; preserve fetched names for surviving slugs.
	function closeManual() {
		const bySlug = new Map(draft.models.map((m) => [m.slug, m]));
		const seen = new Set<string>();
		const models: CustomProviderModel[] = [];
		for (const line of manualText.split("\n")) {
			const slug = line.trim();
			if (slug && !seen.has(slug)) {
				seen.add(slug);
				models.push(bySlug.get(slug) ?? { slug, label: "" });
			}
		}
		commit({ models });
		setEditing(false);
	}

	const fetchButton = (
		<Button
			type="button"
			variant="outline"
			size="icon-sm"
			aria-label="fetchModels"
			disabled={!canFetch || fetchState.loading}
			onClick={refresh}
		>
			<RefreshCcw
				className={cn("size-3.5", fetchState.loading && "animate-spin")}
			/>
		</Button>
	);

	const summaryRow = (
		<button
			type="button"
			onClick={openManual}
			className="flex h-8 min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 rounded-lg border border-border/50 bg-background/40 px-3 text-left text-[13px] text-foreground hover:bg-muted/40"
		>
			<span className={cn("truncate", !hasModels && "text-muted-foreground")}>
				{fetchState.loading ? (
					<I18nText source="fetchingModels" />
				) : hasModels ? (
					draft.models.length === 1 ? (
						<I18nText source="1Model" />
					) : (
						f("countModels", { count: draft.models.length })
					)
				) : (
					<I18nText source="addModelsManually" />
				)}
			</span>
			{hasModels ? (
				<Pencil className="size-3.5 shrink-0 opacity-50" />
			) : (
				<Plus className="size-3.5 shrink-0 opacity-50" />
			)}
		</button>
	);

	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/20 p-3">
			<div className="flex items-center gap-2">
				{preset ? (
					<span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-medium text-foreground">
						<ProviderBrandIcon icon={preset.icon} className="size-4 shrink-0" />
						<span className="truncate">{preset.label}</span>
					</span>
				) : (
					<Input
						value={draft.name}
						onChange={(e) => patch({ name: e.target.value })}
						onBlur={commitText}
						placeholder="displayNameEGMyProvider"
						className="h-8 border-border/50 bg-background/40 text-[13px]"
					/>
				)}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label="removeProvider"
					className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
					onClick={onRemove}
				>
					<Trash2 className="size-3.5" />
				</Button>
			</div>

			{isManual ? (
				<Input
					value={draft.baseUrl}
					onChange={(e) => patch({ baseUrl: e.target.value })}
					onBlur={commitText}
					placeholder={baseUrlPlaceholder}
					className="h-8 border-border/50 bg-background/40 text-[13px]"
				/>
			) : null}

			<div className="flex items-center gap-2">
				<Input
					type="password"
					value={draft.apiKey}
					onChange={(e) => patch({ apiKey: e.target.value })}
					onBlur={commitText}
					placeholder="apiKey"
					className="h-8 min-w-0 flex-1 border-border/50 bg-background/40 text-[13px]"
				/>
				{preset?.apiKeyUrl && !draft.apiKey ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-label="getApiKey"
						onClick={() => preset.apiKeyUrl && void openUrl(preset.apiKeyUrl)}
					>
						<I18nText source="getKey" />
						<SquareArrowOutUpRight className="size-3.5" />
					</Button>
				) : null}
			</div>

			{adapter.caps.apiStyleSelectable && isManual ? (
				<StyleSelect
					label={adapter.styleLabel ?? "apiStyle"}
					options={adapter.styleOptions ?? DEFAULT_STYLE_OPTIONS}
					value={
						draft.apiStyle ??
						(adapter.styleOptions ?? DEFAULT_STYLE_OPTIONS)[0]?.value ??
						"chat"
					}
					onChange={(apiStyle) => commit({ apiStyle })}
				/>
			) : null}

			{apiKeyOnly ? null : (
				<div className="flex flex-col gap-2">
					{editing ? (
						<Textarea
							autoFocus
							value={manualText}
							onChange={(e) => setManualText(e.target.value)}
							onBlur={closeManual}
							placeholder={"model-a\nmodel-b"}
							className="h-20 resize-none overflow-y-auto border-border/50 bg-background/40 font-mono text-[12px]"
						/>
					) : (
						<div className="flex items-center gap-2">
							{summaryRow}
							{fetchButton}
						</div>
					)}

					{fetchState.error ? (
						<p className="text-[12px] text-amber-600 dark:text-amber-400">
							{f("couldnTFetchModelsErrorAdd", {
								error: fetchState.error,
							})}
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}

function StyleSelect({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly StyleOption[];
	value: string;
	onChange: (value: string) => void;
}) {
	const current = options.find((s) => s.value === value) ?? options[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 text-[13px] text-foreground hover:bg-muted/40">
				<span className="flex min-w-0 items-center gap-2">
					<span className="text-muted-foreground">
						<I18nText source={label} />
					</span>
					<span className="truncate">
						{current?.label ? <I18nText source={current.label} /> : null}
					</span>
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-40" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-[320px]">
				{options.map((style) => (
					<DropdownMenuItem
						key={style.value}
						onClick={() => onChange(style.value)}
						className="flex flex-col items-start gap-0.5"
					>
						<span className="text-[13px] text-foreground">
							<I18nText source={style.label} />
						</span>
						{style.hint ? (
							<span className="text-[11px] text-muted-foreground">
								<I18nText source={style.hint} />
							</span>
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
