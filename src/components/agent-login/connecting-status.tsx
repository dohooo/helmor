import { I18nText } from "@/lib/i18n";
export function ConnectingStatus() {
	return (
		<div className="flex shrink-0 items-center gap-2 text-small font-medium text-muted-foreground">
			<span className="size-2 animate-pulse rounded-full bg-muted-foreground/60" />
			<I18nText source={"Connecting"} />
		</div>
	);
}
