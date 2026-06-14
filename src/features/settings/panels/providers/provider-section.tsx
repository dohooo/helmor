// The "Models" + "Custom Providers" config rows for one family, adapter-driven.

import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CustomProvidersList } from "./custom-providers-list";
import { ModelMultiSelect } from "./model-multi-select";
import type {
	ProviderConfigAdapter,
	SectionModelsController,
} from "./provider-config";
import { ProviderConfigRow } from "./provider-row";

export function ProviderConfigSection({
	adapter,
}: {
	adapter: ProviderConfigAdapter;
}) {
	const useSectionModels = adapter.useSectionModels;
	return (
		<>
			{useSectionModels ? (
				<ProviderConfigRow
					label="Models"
					description="Pick which models appear in the composer's picker."
				>
					<SectionModels useSectionModels={useSectionModels} />
				</ProviderConfigRow>
			) : null}
			<ProviderConfigRow
				label="Custom Providers"
				description={adapter.customProvidersDescription}
			>
				<CustomProvidersList adapter={adapter} />
			</ProviderConfigRow>
		</>
	);
}

function SectionModels({
	useSectionModels,
}: {
	useSectionModels: () => SectionModelsController;
}) {
	const ctrl = useSectionModels();
	const available = ctrl.available.map((m) => ({ id: m.slug, label: m.label }));
	return (
		<div className="flex w-full items-center gap-2">
			<ModelMultiSelect
				enabledIds={ctrl.enabledIds}
				enabledSet={ctrl.enabledSet}
				available={available}
				onToggle={ctrl.toggle}
				onClear={ctrl.clear}
				loading={ctrl.loading}
				grouped={ctrl.grouped}
				triggerClassName="min-w-0 flex-1"
			/>
			{ctrl.refresh ? (
				<Button
					type="button"
					variant="outline"
					size="icon-sm"
					aria-label="Refresh models"
					disabled={ctrl.loading}
					onClick={ctrl.refresh}
				>
					<RefreshCcw
						className={cn("size-3.5", ctrl.loading && "animate-spin")}
					/>
				</Button>
			) : null}
		</div>
	);
}
