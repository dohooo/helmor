import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n, useLocalizedNode } from "@/lib/i18n";
import { ReadyStatus } from "./ready-status";

export function SetupItem({
	icon,
	label,
	description,
	actionLabel = "miscSetUp",
	onAction,
	disabled = false,
	busy = false,
	ready = false,
	error,
}: {
	icon: ReactNode;
	label: string;
	description: ReactNode;
	actionLabel?: string;
	onAction?: () => void;
	disabled?: boolean;
	busy?: boolean;
	ready?: boolean;
	error?: ReactNode;
}) {
	const { t } = useI18n();
	const localizedDescription = useLocalizedNode(description);
	const localizedError = useLocalizedNode(error);
	const hasError = Boolean(error);
	return (
		<div
			role="group"
			aria-label={t(label)}
			className="flex items-center gap-3 rounded-lg border border-border/55 bg-card px-4 py-3"
		>
			<div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-foreground">
				{icon}
			</div>
			<div className="min-w-0 flex-1">
				<div className="text-body font-medium text-foreground">{t(label)}</div>
				<p className="mt-0.5 text-small leading-5 text-muted-foreground">
					{localizedDescription}
				</p>
				<div
					aria-hidden={!hasError}
					className={`grid transition-[grid-template-rows,opacity,margin] duration-500 ease-[cubic-bezier(.22,.82,.2,1)] ${
						hasError
							? "mt-1 grid-rows-[1fr] opacity-100"
							: "mt-0 grid-rows-[0fr] opacity-0"
					}`}
				>
					<div className="overflow-hidden">
						<p className="text-mini leading-4 text-destructive">
							{localizedError}
						</p>
					</div>
				</div>
			</div>
			{ready ? (
				<ReadyStatus />
			) : (
				<Button
					type="button"
					size="sm"
					className="h-7 shrink-0 px-2 text-small"
					onClick={onAction}
					disabled={disabled || busy}
				>
					{busy ? <Loader2 className="size-3 animate-spin" /> : null}
					{t(actionLabel)}
				</Button>
			)}
		</div>
	);
}
