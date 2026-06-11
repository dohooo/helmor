import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, SquareArrowOutUpRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { pickDefaultCursorModelIds } from "@/features/settings/panels/cursor-models";
import { type CursorModelEntry, listCursorModels } from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import {
	type CursorCachedModel,
	type CursorProviderSettings,
	useSettings,
} from "@/lib/settings";

const CURSOR_DASHBOARD_URL = "https://cursor.com/dashboard/integrations";

// On blur: probe with the entered key; persist only on success.
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
		if (!next) {
			inflightKeyRef.current = null;
			void Promise.resolve(
				updateSettings({ cursorProvider: { ...cursor, apiKey: "" } }),
			).then(() => onSaved?.());
			return;
		}
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
				className="h-8 w-[180px] border-border/50 bg-muted/20 text-small"
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
					Get your API key
					<SquareArrowOutUpRight className="size-3.5" />
				</Button>
			) : null}
		</div>
	);
}
