// Layout primitives shared between every kind-section (issues / PRs /
// discussions). The toggle on the section header drives `enabled`; the
// `<ContextConfigRow>` is a label + control row used inside the section
// body.
import type { ReactNode } from "react";
import { Switch } from "@/components/ui/switch";

export function ContextKindSection({
	title,
	icon,
	description,
	enabled,
	onEnabledChange,
	children,
}: {
	title: string;
	icon: ReactNode;
	description: string;
	enabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
	children: ReactNode;
}) {
	return (
		<div className="py-5">
			<div className="flex items-center justify-between gap-4">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5 text-[13px] font-medium leading-snug text-foreground">
						<span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
							{icon}
						</span>
						{title}
					</div>
					<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
						{description}
					</div>
				</div>
				<Switch checked={enabled} onCheckedChange={onEnabledChange} />
			</div>
			{enabled ? (
				<div className="mt-4 divide-y divide-border/25 border-border/30 border-t">
					{children}
				</div>
			) : null}
		</div>
	);
}

export function ContextConfigRow({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="text-[12px] font-medium leading-snug text-foreground">
					{title}
				</div>
				<div className="mt-1 text-[11px] leading-snug text-muted-foreground">
					{description}
				</div>
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}
