import { useMutation } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { pickDefaultCursorModelIds } from "@/features/settings/panels/cursor-models";
import { type CursorModelEntry, listCursorModels } from "@/lib/api";
import {
	type CursorCachedModel,
	type CursorProviderSettings,
	useSettings,
} from "@/lib/settings";

const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/integrations";

/// API-key tile for the onboarding Cursor row. On blur: save key
/// (tile flips ready) + silently `listCursorModels()` to validate &
/// populate `cachedModels`. Stale-response guard via in-flight key ref.
export function CursorApiKeyAction({ onSaved }: { onSaved?: () => void }) {
	const { settings, updateSettings } = useSettings();
	const cursor = settings.cursorProvider;
	const [draft, setDraft] = useState(cursor.apiKey);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const inflightKeyRef = useRef<string | null>(null);
	// Refs to dodge useMutation closure staleness during key races.
	const settingsRef = useRef(settings);
	const updateSettingsRef = useRef(updateSettings);
	useEffect(() => {
		settingsRef.current = settings;
		updateSettingsRef.current = updateSettings;
	}, [settings, updateSettings]);

	useEffect(() => {
		setDraft(cursor.apiKey);
	}, [cursor.apiKey]);

	const fetchMutation = useMutation({
		// `key` arg is this call's in-flight key — compared against
		// `inflightKeyRef.current` to drop stale results on key races.
		mutationFn: (_key: string) => listCursorModels(),
		onSuccess: async (models: CursorModelEntry[], key: string) => {
			if (inflightKeyRef.current !== key || !key) return;
			const currentCursor = settingsRef.current.cursorProvider;
			if (currentCursor.apiKey !== key) return;
			setFetchError(null);
			const cached: CursorCachedModel[] = models.map((m) => ({
				id: m.id,
				label: m.label,
				...(m.parameters ? { parameters: m.parameters } : {}),
			}));
			const enabledModelIds =
				currentCursor.enabledModelIds === null
					? pickDefaultCursorModelIds(models)
					: currentCursor.enabledModelIds;
			const patch: Partial<CursorProviderSettings> = {
				cachedModels: cached,
				enabledModelIds,
			};
			await Promise.resolve(
				updateSettingsRef.current({
					cursorProvider: { ...currentCursor, ...patch },
				}),
			);
			onSaved?.();
		},
		onError: (error: unknown, key: string) => {
			if (inflightKeyRef.current !== key) return;
			setFetchError(error instanceof Error ? error.message : String(error));
		},
	});

	function commit() {
		const next = draft.trim();
		if (next === cursor.apiKey) return;
		setFetchError(null);
		void Promise.resolve(
			updateSettings({
				cursorProvider: { ...cursor, apiKey: next },
			}),
		).then(() => {
			// Tile flips ready immediately; fetch validates async.
			onSaved?.();
			if (next) {
				inflightKeyRef.current = next;
				fetchMutation.mutate(next);
			} else {
				inflightKeyRef.current = null;
			}
		});
	}

	return (
		<div className="flex shrink-0 flex-col items-end gap-1">
			<div className="flex items-center gap-2">
				<Input
					type="password"
					value={draft}
					onBlur={commit}
					onChange={(event) => setDraft(event.target.value)}
					placeholder="API key"
					className="h-8 w-[180px] border-border/50 bg-muted/20 text-[12px]"
				/>
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="outline"
								size="icon-sm"
								aria-label="Get Cursor API key"
								onClick={() => void openUrl(CURSOR_DASHBOARD_URL)}
							>
								<ExternalLink className="size-3.5" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Get API key</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			</div>
			{fetchError ? (
				<span className="max-w-[220px] text-right text-[10px] leading-tight text-destructive/90">
					Couldn't validate key: {fetchError}
				</span>
			) : null}
		</div>
	);
}
