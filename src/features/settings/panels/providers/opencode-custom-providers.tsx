import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Box,
	ChevronDown,
	Pencil,
	Plus,
	SquareArrowOutUpRight,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ProviderBrandIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
	deleteOpencodeCustomProvider,
	getOpencodeCustomProviders,
	type OpencodeCustomModel,
	type OpencodeCustomProvider,
	upsertOpencodeCustomProvider,
} from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import { helmorQueryKeys } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import {
	findOpencodePreset,
	OPENCODE_API_STYLES,
	OPENCODE_PROVIDER_NPM,
	OPENCODE_PROVIDER_PRESETS,
} from "./builtin-opencode-providers";

const CUSTOM = "custom";

type CustomDraft = {
	/** Original id when editing; a rename deletes the old block. */
	originalId: string | null;
	id: string;
	name: string;
	npm: string;
	baseUrl: string;
	apiKey: string;
	headers: Record<string, string>;
	models: OpencodeCustomModel[];
};

const EMPTY_CUSTOM: CustomDraft = {
	originalId: null,
	id: "",
	name: "",
	npm: OPENCODE_PROVIDER_NPM,
	baseUrl: "",
	apiKey: "",
	headers: {},
	models: [],
};

// Signature of user-editable fields, for skipping no-op saves.
export function customSig(p: {
	id: string;
	name: string;
	npm?: string;
	baseUrl: string;
	apiKey: string;
	headers: Record<string, string>;
	models: OpencodeCustomModel[];
}): string {
	return JSON.stringify({
		id: p.id.trim(),
		name: p.name.trim(),
		npm: p.npm ?? "",
		baseUrl: p.baseUrl.trim(),
		apiKey: p.apiKey.trim(),
		headers: p.headers,
		models: p.models
			.filter((m) => m.id.trim())
			.map((m) => ({ id: m.id.trim(), name: m.name.trim(), r: m.reasoning })),
	});
}

function slugifyId(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
}

function hostFromUrl(url: string): string {
	const trimmed = url.trim();
	try {
		return new URL(trimmed).hostname;
	} catch {
		// retry assuming a missing scheme
	}
	try {
		return new URL(`https://${trimmed}`).hostname;
	} catch {
		return "";
	}
}

// Auto-derive a provider id (config key + model-slug prefix). Numeric suffix must avoid existing custom blocks AND catalog presets.
export function generateProviderId(
	name: string,
	baseUrl: string,
	taken: ReadonlySet<string>,
): string {
	const base = slugifyId(name) || slugifyId(hostFromUrl(baseUrl)) || "custom";
	if (!taken.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
	}
	return `${base}-${taken.size + 1}`;
}

// Saves on blur. Presets need only an API key; "Custom" asks for base URL + models. Writes to the user's global opencode config.
export function OpencodeCustomProvidersPanel({
	onChanged,
}: {
	onChanged?: () => void;
}) {
	const queryClient = useQueryClient();
	const providersQuery = useQuery({
		queryKey: helmorQueryKeys.opencodeCustomProviders,
		queryFn: getOpencodeCustomProviders,
	});
	const providers = useMemo(
		() => providersQuery.data ?? [],
		[providersQuery.data],
	);
	const configuredById = useMemo(
		() => new Map(providers.map((p) => [p.id, p])),
		[providers],
	);

	// Selected dropdown kind: a preset key or CUSTOM.
	const [kind, setKind] = useState<string>(
		OPENCODE_PROVIDER_PRESETS[0]?.key ?? CUSTOM,
	);
	const [presetKey, setPresetKey] = useState("");
	const [custom, setCustom] = useState<CustomDraft>(EMPTY_CUSTOM);
	const [error, setError] = useState<string | null>(null);

	// Debounce the model-catalog refresh: each config write restarts the opencode server.
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (refreshTimer.current) clearTimeout(refreshTimer.current);
		},
		[],
	);
	const afterWrite = () => {
		void queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.opencodeCustomProviders,
		});
		if (refreshTimer.current) clearTimeout(refreshTimer.current);
		refreshTimer.current = setTimeout(() => onChanged?.(), 1500);
	};

	const saveMutation = useMutation({
		mutationFn: async (input: {
			provider: OpencodeCustomProvider;
			preset: boolean;
			originalId: string | null;
		}) => {
			if (input.originalId && input.originalId !== input.provider.id) {
				await deleteOpencodeCustomProvider(input.originalId);
			}
			await upsertOpencodeCustomProvider(input.provider, input.preset);
		},
		onSuccess: (_data, input) => {
			setError(null);
			if (!input.preset) {
				setCustom((c) => ({ ...c, originalId: input.provider.id }));
			}
			afterWrite();
		},
		onError: (e) => setError(e instanceof Error ? e.message : String(e)),
	});

	const deleteMutation = useMutation({
		mutationFn: (id: string) => deleteOpencodeCustomProvider(id),
		onSuccess: () => {
			setError(null);
			afterWrite();
		},
		onError: (e) => setError(e instanceof Error ? e.message : String(e)),
	});

	useEffect(() => {
		if (kind === CUSTOM) return;
		setPresetKey(configuredById.get(kind)?.apiKey ?? "");
	}, [kind, configuredById]);

	function pickKind(next: string) {
		setError(null);
		setKind(next);
		if (next === CUSTOM) setCustom(EMPTY_CUSTOM);
	}

	function editProvider(provider: OpencodeCustomProvider) {
		setError(null);
		if (provider.baseUrl) {
			setCustom({
				originalId: provider.id,
				id: provider.id,
				name: provider.name,
				npm: provider.npm || OPENCODE_PROVIDER_NPM,
				baseUrl: provider.baseUrl,
				apiKey: provider.apiKey,
				headers: provider.headers ?? {},
				models: provider.models.map((m) => ({ ...m })),
			});
			setKind(CUSTOM);
		} else {
			setKind(provider.id);
		}
	}

	function commitPreset() {
		if (kind === CUSTOM) return;
		const key = presetKey.trim();
		if (!key || key === configuredById.get(kind)?.apiKey) return;
		saveMutation.mutate({
			preset: true,
			originalId: null,
			provider: {
				id: kind,
				name: "",
				npm: OPENCODE_PROVIDER_NPM,
				baseUrl: "",
				apiKey: key,
				headers: {},
				models: [],
			},
		});
	}

	function commitDraft(draft: CustomDraft) {
		if (!draft.baseUrl.trim()) return;
		// id is auto-derived; collision set must include custom blocks AND preset keys.
		const taken = new Set<string>([
			...providers.map((p) => p.id),
			...OPENCODE_PROVIDER_PRESETS.map((p) => p.key),
		]);
		const id =
			draft.originalId ?? generateProviderId(draft.name, draft.baseUrl, taken);
		const existing = configuredById.get(id);
		if (
			existing &&
			draft.originalId === existing.id &&
			customSig({ ...draft, id }) === customSig(existing)
		) {
			return;
		}
		saveMutation.mutate({
			preset: false,
			originalId: draft.originalId,
			provider: {
				id,
				name: draft.name.trim() || hostFromUrl(draft.baseUrl) || id,
				npm: draft.npm || OPENCODE_PROVIDER_NPM,
				baseUrl: draft.baseUrl.trim(),
				apiKey: draft.apiKey.trim(),
				headers: draft.headers,
				models: draft.models
					.filter((m) => m.id.trim())
					.map((m) => ({
						id: m.id.trim(),
						name: m.name.trim() || m.id.trim(),
						reasoning: m.reasoning,
					})),
			},
		});
	}

	function commitCustom() {
		commitDraft(custom);
	}

	function pickApiStyle(npm: string) {
		setCustom((c) => ({ ...c, npm }));
		commitDraft({ ...custom, npm });
	}

	const isCustom = kind === CUSTOM;
	const preset = isCustom ? null : findOpencodePreset(kind);
	const presetApiKeyUrl = preset?.apiKeyUrl;

	return (
		<div className="flex w-full flex-col gap-3">
			<div className="grid gap-2">
				<ProviderPicker
					kind={kind}
					configuredIds={new Set(providers.map((p) => p.id))}
					onChange={pickKind}
				/>

				{isCustom ? (
					<div className="grid gap-2">
						<Input
							value={custom.name}
							onChange={(e) =>
								setCustom((c) => ({ ...c, name: e.target.value }))
							}
							onBlur={commitCustom}
							placeholder="Display name (e.g. My Proxy)"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
						<Input
							value={custom.baseUrl}
							onChange={(e) =>
								setCustom((c) => ({ ...c, baseUrl: e.target.value }))
							}
							onBlur={commitCustom}
							placeholder="Base URL (https://…/v1)"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
						<Input
							type="password"
							value={custom.apiKey}
							onChange={(e) =>
								setCustom((c) => ({ ...c, apiKey: e.target.value }))
							}
							onBlur={commitCustom}
							placeholder="API key"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
						<ApiStyleSelect npm={custom.npm} onChange={pickApiStyle} />
						<ModelsEditor
							models={custom.models}
							onChange={(models) => setCustom((c) => ({ ...c, models }))}
							onCommit={commitCustom}
						/>
					</div>
				) : (
					<div className="flex items-center gap-2">
						<Input
							type="password"
							value={presetKey}
							onChange={(e) => setPresetKey(e.target.value)}
							onBlur={commitPreset}
							placeholder={`${preset?.label ?? kind} API key`}
							className="h-8 min-w-0 flex-1 border-border/50 bg-muted/20 text-ui"
						/>
						{presetApiKeyUrl && !presetKey ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								aria-label="Get API key"
								onClick={() => void openUrl(presetApiKeyUrl)}
							>
								Get your API key
								<SquareArrowOutUpRight className="size-3.5" />
							</Button>
						) : null}
					</div>
				)}

				{error ? (
					<p className="text-small leading-snug text-destructive">{error}</p>
				) : null}
			</div>

			<ConfiguredList
				providers={providers}
				editingId={isCustom ? custom.originalId : kind}
				onEdit={editProvider}
				onDelete={(id) => deleteMutation.mutate(id)}
			/>
		</div>
	);
}

function ProviderPicker({
	kind,
	configuredIds,
	onChange,
}: {
	kind: string;
	configuredIds: Set<string>;
	onChange: (key: string) => void;
}) {
	const preset = kind === CUSTOM ? null : findOpencodePreset(kind);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-ui text-foreground hover:bg-muted/50",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					{preset ? (
						<ProviderBrandIcon icon={preset.icon} className="size-4" />
					) : (
						<Box className="size-4 text-muted-foreground" />
					)}
					<span className="truncate">
						{preset?.label ?? "Custom (OpenAI-compatible)"}
					</span>
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-40" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-[320px] w-[320px]">
				{OPENCODE_PROVIDER_PRESETS.map((p) => (
					<DropdownMenuItem
						key={p.key}
						onClick={() => onChange(p.key)}
						className="flex items-center justify-between gap-2"
					>
						<span className="flex items-center gap-2">
							<ProviderBrandIcon icon={p.icon} className="size-4" />
							{p.label}
						</span>
						{configuredIds.has(p.key) ? (
							<span className="size-1.5 rounded-full bg-emerald-500" />
						) : null}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem
					onClick={() => onChange(CUSTOM)}
					className="flex items-center gap-2"
				>
					<Box className="size-4 text-muted-foreground" />
					Custom (OpenAI-compatible)
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ApiStyleSelect({
	npm,
	onChange,
}: {
	npm: string;
	onChange: (npm: string) => void;
}) {
	const current =
		OPENCODE_API_STYLES.find((s) => s.npm === npm) ?? OPENCODE_API_STYLES[0];
	return (
		<div className="grid gap-1">
			<DropdownMenu>
				<DropdownMenuTrigger className="flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 text-ui text-foreground hover:bg-muted/40">
					<span className="flex min-w-0 items-center gap-2">
						<span className="text-muted-foreground">API style</span>
						<span className="truncate">{current.label}</span>
					</span>
					<ChevronDown className="size-3 shrink-0 opacity-40" />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-[340px]">
					{OPENCODE_API_STYLES.map((style) => (
						<DropdownMenuItem
							key={style.npm}
							onClick={() => onChange(style.npm)}
							className="flex flex-col items-start gap-0.5"
						>
							<span className="text-ui text-foreground">{style.label}</span>
							<span className="text-mini text-muted-foreground">
								{style.hint}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<p className="px-1 text-mini leading-snug text-muted-foreground">
				{current.hint}
			</p>
		</div>
	);
}

function ModelsEditor({
	models,
	onChange,
	onCommit,
}: {
	models: OpencodeCustomModel[];
	onChange: (models: OpencodeCustomModel[]) => void;
	onCommit: () => void;
}) {
	const reasoningId = useId();
	function update(index: number, patch: Partial<OpencodeCustomModel>) {
		onChange(models.map((m, i) => (i === index ? { ...m, ...patch } : m)));
	}
	return (
		<div className="flex flex-col gap-2 rounded-lg border border-border/40 p-2">
			<div className="px-1 text-mini font-medium text-muted-foreground">
				Models
			</div>
			{models.length === 0 ? (
				<div className="px-1 pb-1 text-small text-muted-foreground">
					No models yet — add the model ids your endpoint serves.
				</div>
			) : null}
			{models.map((model, index) => (
				<div
					key={index}
					className="flex flex-col gap-1.5 rounded-md bg-muted/20 p-2"
				>
					<div className="flex items-center gap-2">
						<Input
							value={model.id}
							onChange={(e) => update(index, { id: e.target.value })}
							onBlur={onCommit}
							placeholder="model-id"
							className="h-7 min-w-0 flex-1 border-border/50 bg-background/40 font-mono text-mini"
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label="Remove model"
							onClick={() => {
								onChange(models.filter((_, i) => i !== index));
								onCommit();
							}}
							className="text-muted-foreground hover:text-destructive"
						>
							<X className="size-3.5" />
						</Button>
					</div>
					<Input
						value={model.name}
						onChange={(e) => update(index, { name: e.target.value })}
						onBlur={onCommit}
						placeholder="Display name (optional)"
						className="h-7 border-border/50 bg-background/40 text-mini"
					/>
					<div className="flex items-center justify-between gap-2 px-0.5">
						<Label
							htmlFor={`${reasoningId}-${index}`}
							className="text-mini text-muted-foreground"
						>
							Reasoning (effort) — only if the model supports it
						</Label>
						<Switch
							id={`${reasoningId}-${index}`}
							checked={model.reasoning}
							onCheckedChange={(checked) => {
								update(index, { reasoning: checked });
								setTimeout(onCommit, 0);
							}}
						/>
					</div>
				</div>
			))}
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() =>
					onChange([...models, { id: "", name: "", reasoning: false }])
				}
			>
				<Plus className="size-3.5" />
				Add model
			</Button>
		</div>
	);
}

function ConfiguredList({
	providers,
	editingId,
	onEdit,
	onDelete,
}: {
	providers: OpencodeCustomProvider[];
	editingId: string | null;
	onEdit: (provider: OpencodeCustomProvider) => void;
	onDelete: (id: string) => void;
}) {
	if (providers.length === 0) {
		return (
			<div className="text-small text-muted-foreground">
				No custom providers configured.
			</div>
		);
	}
	return (
		<div className="flex flex-col divide-y divide-border/30 rounded-lg border border-border/40">
			{providers.map((provider) => {
				const preset = provider.baseUrl
					? null
					: findOpencodePreset(provider.id);
				const label = preset?.label ?? (provider.name || provider.id);
				const detail = provider.baseUrl
					? `${provider.baseUrl} · ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`
					: "API key configured";
				return (
					<div
						key={provider.id}
						className={cn(
							"flex items-center gap-2 px-2.5 py-2",
							editingId === provider.id && "bg-muted/30",
						)}
					>
						<div className="flex size-4 shrink-0 items-center justify-center">
							{preset ? (
								<ProviderBrandIcon icon={preset.icon} className="size-4" />
							) : (
								<Box className="size-4 text-muted-foreground" />
							)}
						</div>
						<div className="min-w-0 flex-1">
							<div className="truncate text-ui font-medium text-foreground">
								{label}
							</div>
							<div className="truncate font-mono text-mini text-muted-foreground">
								{detail}
							</div>
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={`Edit ${provider.id}`}
							onClick={() => onEdit(provider)}
							className="text-muted-foreground hover:text-foreground"
						>
							<Pencil className="size-3.5" strokeWidth={1.8} />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={`Delete ${provider.id}`}
							onClick={() => onDelete(provider.id)}
							className="text-muted-foreground hover:text-destructive"
						>
							<Trash2 className="size-3.5" strokeWidth={1.8} />
						</Button>
					</div>
				);
			})}
		</div>
	);
}
