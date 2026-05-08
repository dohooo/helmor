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

/// Inline API-key input + dashboard link, shown in the onboarding
/// agent-login tile for Cursor.
///
/// Behavior on blur:
///   1. Save the key to settings so the Rust login-status check flips
///      `cursor: true` and the tile turns "ready" immediately. UI is
///      never blocked on the network.
///   2. Kick off a SILENT background fetch via `listCursorModels()` —
///      doubles as a "this key is real" probe. On success we also write
///      `cachedModels` + auto-pick `enabledModelIds` so the composer's
///      Cursor section shows the full picker the moment the user reaches
///      it (no need to detour through Settings just to see the list).
///   3. On fetch failure the tile stays "ready" (don't fight optimism),
///      but we show a small inline error below the input so the user
///      knows the key didn't validate. Editing + re-blurring retries.
///
/// Stale-response guard: we stamp the key being validated into a ref;
/// onSuccess / onError only commit results when the stamp still matches
/// the current settings value. Otherwise a fast-typing user can race
/// the network and end up with cachedModels for an old key.
export function CursorApiKeyAction({ onSaved }: { onSaved?: () => void }) {
	const { settings, updateSettings } = useSettings();
	const cursor = settings.cursorProvider;
	const [draft, setDraft] = useState(cursor.apiKey);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const inflightKeyRef = useRef<string | null>(null);

	useEffect(() => {
		setDraft(cursor.apiKey);
	}, [cursor.apiKey]);

	const fetchMutation = useMutation({
		mutationFn: () => listCursorModels(),
		onSuccess: async (models: CursorModelEntry[]) => {
			// Drop stale responses — user may have already typed a new key.
			if (inflightKeyRef.current !== cursor.apiKey || !cursor.apiKey) {
				return;
			}
			setFetchError(null);
			const cached: CursorCachedModel[] = models.map((m) => ({
				id: m.id,
				label: m.label,
				...(m.parameters ? { parameters: m.parameters } : {}),
			}));
			const enabledModelIds =
				cursor.enabledModelIds === null
					? pickDefaultCursorModelIds(models)
					: cursor.enabledModelIds;
			const patch: Partial<CursorProviderSettings> = {
				cachedModels: cached,
				enabledModelIds,
			};
			await Promise.resolve(
				updateSettings({ cursorProvider: { ...cursor, ...patch } }),
			);
			onSaved?.();
		},
		onError: (error: unknown) => {
			if (inflightKeyRef.current !== cursor.apiKey) return;
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
			// Tile flips to "ready" immediately — UX never waits on the
			// network. The fetch below validates + populates the catalog
			// behind the user's back.
			onSaved?.();
			if (next) {
				inflightKeyRef.current = next;
				fetchMutation.mutate();
			} else {
				// Cleared the key — drop any leaked validation state.
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
