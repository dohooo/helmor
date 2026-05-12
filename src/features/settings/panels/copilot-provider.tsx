import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCcw } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { listCopilotModels } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { type CopilotProviderSettings, useSettings } from "@/lib/settings";
import { SettingsRow } from "../components/settings-row";

export function CopilotProviderPanel() {
	const queryClient = useQueryClient();
	const { settings, updateSettings } = useSettings();
	const copilot = settings.copilotProvider;

	const persist = async (patch: Partial<CopilotProviderSettings>) => {
		await Promise.resolve(
			updateSettings({ copilotProvider: { ...copilot, ...patch } }),
		);
		queryClient.invalidateQueries({
			queryKey: helmorQueryKeys.agentModelSections,
		});
	};

	const fetchMutation = useMutation({
		mutationFn: () => listCopilotModels(),
		onSuccess: async (models) => {
			await persist({
				cachedModels: models.map((m) => ({ id: m.id, label: m.label })),
			});
		},
	});

	// Auto-fetch once on mount if no catalog yet.
	const fetchedOnceRef = useRef(false);
	useEffect(() => {
		if (
			copilot.cachedModels === null &&
			!fetchMutation.isPending &&
			!fetchedOnceRef.current
		) {
			fetchedOnceRef.current = true;
			fetchMutation.mutate();
		}
	}, [copilot.cachedModels, fetchMutation]);

	const models = copilot.cachedModels ?? [];
	const isPending = fetchMutation.isPending;
	const error = fetchMutation.isError
		? fetchMutation.error instanceof Error
			? fetchMutation.error.message
			: String(fetchMutation.error)
		: null;

	return (
		<SettingsRow
			title="GitHub Copilot"
			description="Models are fetched from the Copilot ACP server. Requires the Copilot CLI to be installed and signed in."
			align="start"
			className="gap-8"
		>
			<div className="flex w-[360px] flex-col gap-3">
				<div className="flex items-center justify-between">
					<span className="text-[13px] text-muted-foreground">
						{isPending
							? "Fetching models…"
							: models.length > 0
								? `${models.length} model${models.length === 1 ? "" : "s"} available`
								: "No models cached yet"}
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => fetchMutation.mutate()}
						disabled={isPending}
						aria-label="Refresh Copilot models"
					>
						<RefreshCcw
							className={`size-3.5 ${isPending ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>
				</div>

				{error && <p className="text-[12px] text-destructive">{error}</p>}

				{models.length > 0 && (
					<ul className="rounded-lg border border-border/40 bg-muted/10 px-3 py-2">
						{models.map((m) => (
							<li
								key={m.id}
								className="flex items-center justify-between py-1 text-[13px]"
							>
								<span className="font-medium text-foreground">{m.label}</span>
								<span className="font-mono text-[11px] text-muted-foreground">
									{m.id}
								</span>
							</li>
						))}
					</ul>
				)}
			</div>
		</SettingsRow>
	);
}
