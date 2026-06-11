import { Box, ChevronDown } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { findKimiPreset, KIMI_CATALOG_PRESETS } from "./builtin-kimi-providers";

/** Sentinel `kind` values for the two non-catalog shapes. */
export const KIMI_KIND_CUSTOM = "__custom__";
export const KIMI_KIND_REGISTRY = "__registry__";

export function KimiProviderPicker({
	kind,
	onChange,
}: {
	kind: string;
	onChange: (key: string) => void;
}) {
	const preset =
		kind === KIMI_KIND_CUSTOM || kind === KIMI_KIND_REGISTRY
			? undefined
			: findKimiPreset(kind);
	const label = preset
		? preset.label
		: kind === KIMI_KIND_CUSTOM
			? "Custom (OpenAI-compatible)"
			: kind === KIMI_KIND_REGISTRY
				? "Custom registry (api.json URL)"
				: kind;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					"flex h-8 cursor-interactive items-center justify-between rounded-lg border border-border/50 bg-muted/30 px-3 text-ui text-foreground hover:bg-muted/50",
				)}
			>
				<span className="flex min-w-0 items-center gap-2">
					<Box className="size-4 text-muted-foreground" />
					<span className="truncate">{label}</span>
				</span>
				<ChevronDown className="size-3 shrink-0 opacity-40" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-h-[340px] w-[300px]">
				<DropdownMenuItem onClick={() => onChange(KIMI_KIND_CUSTOM)}>
					Custom (OpenAI-compatible)
				</DropdownMenuItem>
				<DropdownMenuItem onClick={() => onChange(KIMI_KIND_REGISTRY)}>
					Custom registry (api.json URL)
				</DropdownMenuItem>
				{KIMI_CATALOG_PRESETS.map((p) => (
					<DropdownMenuItem key={p.id} onClick={() => onChange(p.id)}>
						{p.label}
						<span className="ml-auto font-mono text-mini text-muted-foreground">
							{p.id}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
