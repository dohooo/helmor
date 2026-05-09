import { useMutation } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickDefaultCursorModelIds } from "@/features/settings/panels/cursor-models";
import { type CursorModelEntry, listCursorModels } from "@/lib/api";
import {
	type CursorCachedModel,
	type CursorProviderSettings,
	useSettings,
} from "@/lib/settings";

const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/integrations";

/// Onboarding Cursor key tile. On blur: probe `Cursor.models.list` with
/// the entered key; only persist apiKey + cachedModels on success. Bad
/// keys keep the tile in needsSetup; error is surfaced via `onError` so
/// the parent can replace the row's description with it.
export function CursorApiKeyAction({
	onSaved,
	onError,
}: {
	onSaved?: () => void;
	onError?: (message: string | null) => void;
}) {
	const { settings, updateSettings } = useSettings();
	const cursor = settings.cursorProvider;
	const [draft, setDraft] = useState(cursor.apiKey);
	const inflightKeyRef = useRef<string | null>(null);
	// Refs to dodge useMutation closure staleness during key races.
	const settingsRef = useRef(settings);
	const updateSettingsRef = useRef(updateSettings);
	const onErrorRef = useRef(onError);
	useEffect(() => {
		settingsRef.current = settings;
		updateSettingsRef.current = updateSettings;
		onErrorRef.current = onError;
	}, [settings, updateSettings, onError]);

	useEffect(() => {
		setDraft(cursor.apiKey);
	}, [cursor.apiKey]);

	const validateMutation = useMutation({
		// Probe `Cursor.models.list` with the *entered* key (not the
		// stored one). Failure here = invalid key; we don't persist it.
		mutationFn: (key: string) => listCursorModels(key),
		onSuccess: async (models: CursorModelEntry[], key: string) => {
			if (inflightKeyRef.current !== key) return;
			onErrorRef.current?.(null);
			const currentCursor = settingsRef.current.cursorProvider;
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
				apiKey: key,
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
			onErrorRef.current?.(
				error instanceof Error ? error.message : String(error),
			);
		},
	});

	function commit() {
		const next = draft.trim();
		if (next === cursor.apiKey) return;
		onErrorRef.current?.(null);
		// Empty key — clear stored settings without a probe.
		if (!next) {
			inflightKeyRef.current = null;
			void Promise.resolve(
				updateSettings({ cursorProvider: { ...cursor, apiKey: "" } }),
			).then(() => onSaved?.());
			return;
		}
		// Validate first; persist only on success.
		inflightKeyRef.current = next;
		validateMutation.mutate(next);
	}

	const isValidating = validateMutation.isPending;

	return (
		<div className="flex shrink-0 items-center gap-2">
			<Input
				type="password"
				value={draft}
				onBlur={commit}
				onChange={(event) => setDraft(event.target.value)}
				placeholder="API key"
				disabled={isValidating}
				className="h-8 w-[180px] border-border/50 bg-muted/20 text-[12px]"
			/>
			{isValidating ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					aria-label="Validating API key"
					disabled
				>
					<LoaderCircle className="size-3.5 animate-spin" />
					Validating…
				</Button>
			) : !draft ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					aria-label="Get Cursor API key"
					onClick={() => void openUrl(CURSOR_DASHBOARD_URL)}
				>
					<ExternalLink className="size-3.5" />
					Get your API key
				</Button>
			) : null}
		</div>
	);
}
