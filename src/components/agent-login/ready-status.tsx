import { I18nText } from "@/lib/i18n";
export function ReadyStatus() {
	return (
		<div className="flex shrink-0 items-center gap-2 text-small font-medium text-emerald-500">
			<span className="size-2 rounded-full bg-emerald-500" />
			<I18nText source="ready" />
		</div>
	);
}
