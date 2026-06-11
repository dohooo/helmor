import { Box, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { KimiProviderInfo } from "@/lib/api";

export function KimiConfiguredList({
	providers,
	onDelete,
	busy,
}: {
	providers: KimiProviderInfo[];
	onDelete: (id: string) => void;
	busy: boolean;
}) {
	if (providers.length === 0) {
		return (
			<div className="text-small text-muted-foreground">
				No providers configured. The built-in Kimi default works without one.
			</div>
		);
	}
	return (
		<div className="flex flex-col divide-y divide-border/30 rounded-lg border border-border/40">
			{providers.map((provider) => (
				<div key={provider.id} className="flex items-center gap-2 px-2.5 py-2">
					<Box className="size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<div className="truncate text-ui font-medium text-foreground">
							{provider.label}
						</div>
						<div className="truncate font-mono text-mini text-muted-foreground">
							{provider.id} ·{" "}
							{`${provider.modelCount} model${provider.modelCount === 1 ? "" : "s"}`}
						</div>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						aria-label={`Remove ${provider.id}`}
						disabled={busy}
						onClick={() => onDelete(provider.id)}
						className="text-muted-foreground hover:text-destructive"
					>
						<Trash2 className="size-3.5" strokeWidth={1.8} />
					</Button>
				</div>
			))}
		</div>
	);
}
