import { Pickaxe } from "lucide-react";
import { SourceIcon } from "@/features/inbox/source-icon";
import type { SourceDetailProps } from "./common";

export function UnsupportedSourceView({ card }: SourceDetailProps) {
	return (
		<div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center gap-3 text-center">
			<div className="flex size-10 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				<SourceIcon source={card.source} size={16} />
			</div>
			<div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
				<Pickaxe className="size-3.5 text-muted-foreground" strokeWidth={2} />
				Coming Soon
			</div>
			<p className="max-w-sm text-[12px] leading-5 text-muted-foreground">
				This provider is not enabled in the first GitHub-focused inbox release.
			</p>
		</div>
	);
}
