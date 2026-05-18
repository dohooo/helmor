import { LoaderCircle } from "lucide-react";

export function StepIssueSending() {
	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center gap-2 text-[12px] leading-snug text-muted-foreground">
				<LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.1} />
				<span>Opening an issue on Dohoo/helmor…</span>
			</div>
		</div>
	);
}
