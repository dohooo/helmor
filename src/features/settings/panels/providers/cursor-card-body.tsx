import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw, SquareArrowOutUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { listCursorModels } from "@/lib/api";
import { I18nText } from "@/lib/i18n";
import { openUrl } from "@/lib/platform-bridge";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	type CursorCachedModel,
	type CursorProviderSettings,
	useSettings,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { pickDefaultCursorModelIds } from "../cursor-models";
import { ModelMultiSelect } from "./model-multi-select";

const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/integrations";

export function CursorCardBody() {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const cursor = settings.cursorProvider;
	const [keyDraft, setKeyDraft] = useState(cursor.apiKey);
	const [fetchError, setFetchError] = useState<string | null>(null);

	useEffect(() => {
		setKeyDraft(cursor.apiKey);
	}, [cursor.apiKey]);

	const persist = useCallback(
		async (patch: Partial<CursorProviderSettings>) => {
			await Promise.resolve(
				updateSettings({ cursorProvider: { ...cursor, ...patch } }),
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
				...(m.parameters ? { parameters: m.parameters } : {}),
			}));
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
	const available = useMemo(
		() => cached.map((m) => ({ id: m.id, label: m.label })),
		[cached],
	);
	const enabledIds = cursor.enabledModelIds ?? [];
	const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);

	function toggle(id: string) {
		void persist({
			enabledModelIds: enabledSet.has(id)
				? enabledIds.filter((v) => v !== id)
				: [...enabledIds, id],
		});
	}

	function clearAll() {
		void persist({ enabledModelIds: [] });
	}

	return (
		<div className="flex w-full flex-col gap-2">
			<div className="flex w-full items-center gap-2">
				<Input
					type="password"
					value={keyDraft}
					onBlur={commitKey}
					onChange={(event) => setKeyDraft(event.target.value)}
					placeholder="cursorApiKey"
					className="h-8 min-w-0 flex-1 border-border/50 bg-muted/20 text-ui"
				/>
				{!keyDraft && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						aria-label="getCursorApiKey"
						onClick={() => void openUrl(CURSOR_DASHBOARD_URL)}
					>
						<I18nText source="getApiKey2" />
						<SquareArrowOutUpRight className="size-3.5" />
					</Button>
				)}
			</div>

			{cursor.apiKey ? (
				<>
					<div className="flex w-full items-center gap-2">
						<ModelMultiSelect
							enabledIds={enabledIds}
							enabledSet={enabledSet}
							available={available}
							onToggle={toggle}
							onClear={clearAll}
							loading={fetchMutation.isPending}
							grouped={false}
							triggerClassName="min-w-0 flex-1"
						/>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									type="button"
									variant="outline"
									size="icon-sm"
									aria-label="refreshModelList"
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
							<TooltipContent>
								<I18nText source="refreshModels" />
							</TooltipContent>
						</Tooltip>
					</div>
					{fetchError ? (
						<p className="text-small leading-snug text-destructive">
							<I18nText source="couldNotFetchModels" /> {fetchError}
							<I18nText source="composerWillFallBackAuto" />
						</p>
					) : null}
				</>
			) : null}
		</div>
	);
}
