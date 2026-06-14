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
import { openUrl } from "@/lib/platform-bridge";
import type {
	ApiStyle,
	CustomProvider,
	CustomProviderModel,
} from "@/lib/provider-config";
import { cn } from "@/lib/utils";
import type { ProviderConfigAdapter, ProviderPreset } from "./provider-config";

type FetchState = { loading: boolean; error: string | null };

const API_STYLES: Array<{ value: ApiStyle; label: string; hint: string }> = [
	{
		value: "chat",
		label: "Chat Completions",
		hint: "/v1/chat/completions — widest compatibility.",
	},
	{
		value: "responses",
		label: "Responses API",
		hint: "/v1/responses — advanced reasoning & tools.",
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
		adapter.family === "claude"
			? "Base URL (https://…/anthropic)"
			: "Base URL (https://…/v1)";

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
				error: models.length ? null : "No models returned by the endpoint.",
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
			aria-label="Fetch models"
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
				{fetchState.loading
					? "Fetching models…"
					: hasModels
						? `${draft.models.length} model${draft.models.length === 1 ? "" : "s"}`
						: "Add models manually"}
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
						placeholder="Display name (e.g. My Provider)"
						className="h-8 border-border/50 bg-background/40 text-[13px]"
					/>
				)}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					aria-label="Remove provider"
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
					placeholder="API key"
					className="h-8 min-w-0 flex-1 border-border/50 bg-background/40 text-[13px]"
				/>
				{preset?.apiKeyUrl && !draft.apiKey ? (
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-label="Get API key"
						onClick={() => preset.apiKeyUrl && void openUrl(preset.apiKeyUrl)}
					>
						Get key
						<SquareArrowOutUpRight className="size-3.5" />
					</Button>
				) : null}
			</div>

			{adapter.caps.apiStyleSelectable && isManual ? (
				<ApiStyleSelect
					value={draft.apiStyle ?? "chat"}
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
							Couldn't fetch models ({fetchState.error}). Add them manually
							instead.
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}

function ApiStyleSelect({
	value,
	onChange,
}: {
	value: ApiStyle;
	onChange: (value: ApiStyle) => void;
}) {
	const current = API_STYLES.find((s) => s.value === value) ?? API_STYLES[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-background/40 px-3 text-[13px] text-foreground hover:bg-muted/40">
				<span className="flex min-w-0 items-center gap-2">
					<span className="text-muted-foreground">API style</span>
					<span className="truncate">{current.label}</span>
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-40" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-[320px]">
				{API_STYLES.map((style) => (
					<DropdownMenuItem
						key={style.value}
						onClick={() => onChange(style.value)}
						className="flex flex-col items-start gap-0.5"
					>
						<span className="text-[13px] text-foreground">{style.label}</span>
						<span className="text-[11px] text-muted-foreground">
							{style.hint}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
