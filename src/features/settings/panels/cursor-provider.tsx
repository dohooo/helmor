import { useMutation, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
	ChevronDown,
	RefreshCcw,
	SquareArrowOutUpRight,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { listCursorModels } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type CursorCachedModel,
	type CursorProviderSettings,
	useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { SettingsRow } from "../components/settings-row";
import { pickDefaultCursorModelIds } from "./cursor-models";

const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/integrations";

export function CursorProviderPanel() {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const cursor = settings.cursorProvider;
	const [keyDraft, setKeyDraft] = useState(cursor.apiKey);
	const [fetchError, setFetchError] = useState<string | null>(null);

	useEffect(() => {
		setKeyDraft(cursor.apiKey);
	}, [cursor.apiKey]);

	// Patch + invalidate picker so composer reflects the change.
	const persist = useCallback(
		async (patch: Partial<CursorProviderSettings>) => {
			await Promise.resolve(
				updateSettings({
					cursorProvider: { ...cursor, ...patch },
				}),
			);
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.agentModelSections,
			});
		},
		[cursor, queryClient, updateSettings],
	);

	const fetchMutation = useMutation({
		mutationFn: () => listCursorModels(),
		onSuccess: async (models) => {
			setFetchError(null);
			const cached: CursorCachedModel[] = models.map((m) => ({
				id: m.id,
				label: m.label,
				// Forward parameters[] so Rust catalog derives toolbar caps.
				...(m.parameters ? { parameters: m.parameters } : {}),
			}));
			// Auto-pick only when null (first time); user picks are sticky.
			const shouldAutoPick = cursor.enabledModelIds === null;
			const enabledModelIds = shouldAutoPick
				? pickDefaultCursorModelIds(models)
				: cursor.enabledModelIds;
			await persist({ cachedModels: cached, enabledModelIds });
		},
		onError: (error) => {
			setFetchError(error instanceof Error ? error.message : String(error));
		},
	});

	// Save on blur; first-time saves trigger an immediate catalog fetch.
	const lastKickedRef = useRef<string | null>(null);
	function commitKey() {
		const next = keyDraft.trim();
		if (next === cursor.apiKey) return;
		void persist({ apiKey: next }).then(() => {
			if (next && lastKickedRef.current !== next) {
				lastKickedRef.current = next;
				fetchMutation.mutate();
			}
		});
	}

	// First-mount fetch when key is saved but no catalog yet (idempotent).
	useEffect(() => {
		if (
			cursor.apiKey &&
			cursor.cachedModels === null &&
			!fetchMutation.isPending &&
			lastKickedRef.current !== cursor.apiKey
		) {
			lastKickedRef.current = cursor.apiKey;
			fetchMutation.mutate();
		}
	}, [cursor.apiKey, cursor.cachedModels, fetchMutation]);

	const cached = cursor.cachedModels ?? [];
	const enabledIds = cursor.enabledModelIds ?? [];
	const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

	function setEnabled(next: string[]) {
		void persist({ enabledModelIds: next });
	}

	function toggle(id: string) {
		setEnabled(
			enabledSet.has(id)
				? enabledIds.filter((v) => v !== id)
				: [...enabledIds, id],
		);
	}

	const showPicker = Boolean(cursor.apiKey);

	return (
		<>
			<SettingsRow
				title="Cursor"
				description="Add a Cursor API key to use Cursor models in Helmor."
				align="start"
				className="gap-8"
			>
				<div className="flex w-[360px] items-center gap-2">
					<Input
						type="password"
						value={keyDraft}
						onBlur={commitKey}
						onChange={(event) => setKeyDraft(event.target.value)}
						placeholder="Cursor API key"
						className="h-8 min-w-0 flex-1 border-border/50 bg-muted/20 text-[13px]"
					/>
					{!keyDraft && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							aria-label="Get Cursor API key"
							onClick={() => void openUrl(CURSOR_DASHBOARD_URL)}
						>
							Get your API key
							<SquareArrowOutUpRight className="size-3.5" />
						</Button>
					)}
				</div>
			</SettingsRow>

			{showPicker ? (
				<SettingsRow
					title="Cursor models"
					description={
						fetchError
							? `Could not fetch models — ${fetchError}. The composer will fall back to Auto.`
							: "Pick which appear in the composer's model picker. Refresh to fetch new ones."
					}
					align="start"
					className="gap-8"
				>
					<div className="flex w-[360px] flex-col gap-2">
						<div className="flex items-center gap-2">
							<ModelMultiSelect
								enabledIds={enabledIds}
								enabledSet={enabledSet}
								available={cached}
								onToggle={toggle}
								loading={fetchMutation.isPending}
							/>
							<TooltipProvider>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="outline"
											size="icon-sm"
											aria-label="Refresh model list"
											disabled={fetchMutation.isPending}
											onClick={() => fetchMutation.mutate()}
										>
											<RefreshCcw
												className={cn(
													"size-3.5",
													fetchMutation.isPending && "animate-spin",
												)}
											/>
										</Button>
									</TooltipTrigger>
									<TooltipContent>Refresh</TooltipContent>
								</Tooltip>
							</TooltipProvider>
						</div>
					</div>
				</SettingsRow>
			) : null}
		</>
	);
}

function ModelMultiSelect({
	enabledIds,
	enabledSet,
	available,
	onToggle,
	loading,
}: {
	enabledIds: string[];
	enabledSet: Set<string>;
	available: CursorCachedModel[];
	onToggle: (id: string) => void;
	loading: boolean;
}) {
	// Render picks in user-saved order; popup list keeps API order.
	const enabled = enabledIds
		.map((id) => available.find((m) => m.id === id) ?? { id, label: id })
		.filter(Boolean);

	return (
		<Popover>
			<PopoverTrigger asChild>
				<div
					role="button"
					tabIndex={0}
					className={cn(
						"flex min-h-9 w-[280px] cursor-interactive items-center justify-between gap-2 rounded-lg border border-input bg-muted/20 px-2 py-1 text-left transition-colors",
						"hover:bg-muted/30 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
					)}
				>
					<span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
						{enabled.length === 0 ? (
							<span className="px-1 text-[12px] text-muted-foreground">
								{loading ? "Loading…" : "No models picked"}
							</span>
						) : (
							enabled.map((model) => (
								<Badge
									key={model.id}
									variant="outline"
									className="h-6 gap-1 rounded-md pr-1 text-[11px]"
									onClick={(event) => event.stopPropagation()}
								>
									{model.label}
									<button
										type="button"
										aria-label={`Remove ${model.label}`}
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											onToggle(model.id);
										}}
										className="inline-flex size-4 cursor-interactive items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
									>
										<X className="size-3" strokeWidth={2} />
									</button>
								</Badge>
							))
						)}
					</span>
					<ChevronDown
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.8}
					/>
				</div>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-[280px] p-1.5">
				<Command>
					<CommandInput placeholder="Search models" />
					<CommandList>
						<CommandEmpty>
							{available.length === 0
								? loading
									? "Loading models…"
									: "No cached models yet — click Refresh."
								: "No models found."}
						</CommandEmpty>
						<CommandGroup>
							{available.map((model) => {
								const checked = enabledSet.has(model.id);
								return (
									<CommandItem
										key={model.id}
										value={`${model.label} ${model.id}`}
										data-checked={checked}
										onSelect={() => onToggle(model.id)}
										className="items-start"
									>
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="truncate text-[13px] leading-tight">
												{model.label}
											</span>
											<span className="truncate font-mono text-[10px] leading-tight text-muted-foreground">
												{model.id}
											</span>
										</div>
									</CommandItem>
								);
							})}
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
