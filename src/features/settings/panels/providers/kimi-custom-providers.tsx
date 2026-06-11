import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SquareArrowOutUpRight } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	addKimiCatalogProvider,
	addKimiCustomProvider,
	addKimiRegistry,
	getKimiProviderConfig,
	removeKimiProvider,
} from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import { helmorQueryKeys } from "@/lib/query-client";
import { findKimiPreset } from "./builtin-kimi-providers";
import { KimiConfiguredList } from "./kimi-configured-list";
import { deriveProviderId } from "./kimi-provider-id";
import {
	KIMI_KIND_CUSTOM,
	KIMI_KIND_REGISTRY,
	KimiProviderPicker,
} from "./kimi-provider-picker";
import { KimiWireTypeSelect } from "./kimi-wire-type-select";
import { useKimiModelSync } from "./use-kimi-model-sync";

/** Add/remove Kimi providers. Three shapes, all ending up in `~/.kimi-code`:
 *  a models.dev catalog id (`kimi provider catalog add`), a raw
 *  OpenAI/Anthropic-compatible endpoint (base URL + key + model, written to
 *  `config.toml`), or a custom `api.json` registry (`kimi provider add`). */
export function KimiCustomProvidersPanel() {
	const queryClient = useQueryClient();
	const { sync } = useKimiModelSync();

	const configQuery = useQuery({
		queryKey: helmorQueryKeys.kimiProviderConfig,
		queryFn: getKimiProviderConfig,
	});
	const providers = useMemo(
		() => configQuery.data?.providers ?? [],
		[configQuery.data],
	);
	// Surface a broken `kimi provider list` (e.g. an invalid config.toml) instead
	// of silently showing an empty list — otherwise a bad provider just "vanishes".
	const listError =
		configQuery.error instanceof Error ? configQuery.error.message : null;

	const [kind, setKind] = useState<string>(KIMI_KIND_CUSTOM);
	const [providerId, setProviderId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [modelIds, setModelIds] = useState("");
	const [contextSize, setContextSize] = useState("128000");
	const [wireType, setWireType] = useState<"openai" | "anthropic">("openai");
	const [url, setUrl] = useState("");
	const [error, setError] = useState<string | null>(null);

	const preset = useMemo(
		() =>
			kind === KIMI_KIND_CUSTOM || kind === KIMI_KIND_REGISTRY
				? undefined
				: findKimiPreset(kind),
		[kind],
	);

	const refresh = async () => {
		await queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.kimiProviderConfig,
		});
		await sync().catch(() => {});
	};

	const addMutation = useMutation({
		mutationFn: async () => {
			if (kind === KIMI_KIND_REGISTRY) {
				const trimmed = url.trim();
				if (!trimmed) throw new Error("Enter the registry api.json URL.");
				if (!apiKey.trim()) throw new Error("Enter the registry API key.");
				await addKimiRegistry(trimmed, apiKey.trim());
				return;
			}
			if (kind === KIMI_KIND_CUSTOM) {
				if (!baseUrl.trim()) throw new Error("Enter the endpoint base URL.");
				// Empty = let the backend default it; anything typed must be a
				// positive integer (`Number`, not `parseInt` — parseInt("1e6") === 1).
				const ctxRaw = contextSize.trim();
				const ctx = ctxRaw === "" ? undefined : Number(ctxRaw);
				if (ctx !== undefined && (!Number.isInteger(ctx) || ctx < 1)) {
					throw new Error(
						"Context window must be a positive whole number of tokens.",
					);
				}
				const models = modelIds
					.split(",")
					.map((m) => m.trim())
					.filter(Boolean)
					.map((id) => ({
						id,
						...(ctx !== undefined ? { maxContextSize: ctx } : {}),
					}));
				if (models.length === 0) {
					throw new Error("Enter at least one model id.");
				}
				const id = deriveProviderId(
					name,
					baseUrl,
					new Set(providers.map((p) => p.id)),
				);
				await addKimiCustomProvider({
					id,
					baseUrl: baseUrl.trim(),
					apiKey: apiKey.trim(),
					wireType,
					models,
				});
				return;
			}
			// Catalog preset / hand-typed catalog id.
			const id = providerId.trim();
			if (!id) throw new Error("Enter a models.dev provider id.");
			if (!apiKey.trim()) throw new Error("Enter an API key.");
			await addKimiCatalogProvider(id, apiKey.trim());
		},
		onSuccess: () => {
			setError(null);
			setApiKey("");
			setUrl("");
			setName("");
			setBaseUrl("");
			setModelIds("");
			void refresh();
		},
		onError: (e) => setError(e instanceof Error ? e.message : String(e)),
	});

	const removeMutation = useMutation({
		mutationFn: (id: string) => removeKimiProvider(id),
		onSuccess: () => {
			setError(null);
			void refresh();
		},
		onError: (e) => setError(e instanceof Error ? e.message : String(e)),
	});

	const busy = addMutation.isPending || removeMutation.isPending;

	function pickKind(next: string) {
		setError(null);
		setKind(next);
		setApiKey("");
		if (next !== KIMI_KIND_CUSTOM && next !== KIMI_KIND_REGISTRY)
			setProviderId(next);
	}

	return (
		<div className="flex w-full flex-col gap-3">
			<div className="grid gap-2">
				<KimiProviderPicker kind={kind} onChange={pickKind} />

				{kind === KIMI_KIND_REGISTRY ? (
					<>
						<Input
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="Registry URL (https://…/api.json)"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
						<Input
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="Registry API key"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
					</>
				) : kind === KIMI_KIND_CUSTOM ? (
					<>
						<Input
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Name (optional, e.g. Hundun)"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
						<Input
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
							placeholder="Base URL (https://…/v1)"
							className="h-8 border-border/50 bg-muted/20 font-mono text-ui"
						/>
						<Input
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="API key"
							className="h-8 border-border/50 bg-muted/20 text-ui"
						/>
						<Input
							value={modelIds}
							onChange={(e) => setModelIds(e.target.value)}
							placeholder="Model id(s), comma-separated (e.g. deepseek-v4-pro)"
							className="h-8 border-border/50 bg-muted/20 font-mono text-ui"
						/>
						<Input
							type="number"
							value={contextSize}
							onChange={(e) => setContextSize(e.target.value)}
							placeholder="Context window (tokens, e.g. 128000)"
							className="h-8 border-border/50 bg-muted/20 font-mono text-ui"
						/>
						<KimiWireTypeSelect value={wireType} onChange={setWireType} />
					</>
				) : (
					<>
						<Input
							value={providerId}
							onChange={(e) => setProviderId(e.target.value)}
							placeholder="models.dev provider id (e.g. anthropic)"
							className="h-8 border-border/50 bg-muted/20 font-mono text-ui"
						/>
						<div className="flex items-center gap-2">
							<Input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder={`${preset?.label ?? (providerId || "Provider")} API key`}
								className="h-8 min-w-0 flex-1 border-border/50 bg-muted/20 text-ui"
							/>
							{preset?.apiKeyUrl && !apiKey ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void openUrl(preset.apiKeyUrl ?? "")}
								>
									Get your API key
									<SquareArrowOutUpRight className="size-3.5" />
								</Button>
							) : null}
						</div>
					</>
				)}

				{/* When the provider list is broken, `deriveProviderId` can't see
				    existing ids and an add could silently overwrite one — block it;
				    the destructive text below explains why. */}
				<Button
					type="button"
					size="sm"
					disabled={busy || configQuery.isError}
					onClick={() => addMutation.mutate()}
					className="justify-self-start"
				>
					{busy ? "Adding…" : "Add provider"}
				</Button>

				{error || listError ? (
					<p className="text-small leading-snug text-destructive">
						{error ?? listError}
					</p>
				) : null}
			</div>

			<KimiConfiguredList
				providers={providers}
				onDelete={(id) => removeMutation.mutate(id)}
				busy={busy}
			/>
		</div>
	);
}
