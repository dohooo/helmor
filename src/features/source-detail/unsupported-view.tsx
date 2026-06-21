import { Pickaxe } from "lucide-react";
import { SourceIcon } from "@/features/inbox/source-icon";
import { I18nText } from "@/lib/i18n";
import type { SourceDetailProps } from "./common";

export function UnsupportedSourceView({ card }: SourceDetailProps) {
	return (
		<div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center justify-center gap-3 text-center">
			<div className="flex size-10 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground">
				<SourceIcon source={card.source} size={16} />
			</div>
			<div className="flex items-center gap-2 text-ui font-medium text-foreground">
				<Pickaxe className="size-3.5 text-muted-foreground" strokeWidth={2} />
				<I18nText source="comingSoon" />
			</div>
			<p className="max-w-sm text-small leading-5 text-muted-foreground">
				<I18nText source="providerNotEnabledFirstGithubFocused" />
			</p>
		</div>
	);
}
