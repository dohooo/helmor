import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ScriptStatus } from "../script-store";

type ScriptPanelFrameProps = {
	title: string;
	subtitle?: string;
	status?: ScriptStatus | "ready";
	command?: string | null;
	children: ReactNode;
};

const STATUS_LABELS: Record<ScriptStatus | "ready", string> = {
	idle: "Idle",
	running: "Running",
	exited: "Finished",
	ready: "Ready",
};

function statusClass(status: ScriptStatus | "ready") {
	switch (status) {
		case "running":
			return "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]";
		case "exited":
		case "ready":
			return "bg-muted-foreground/55";
		default:
			return "bg-muted-foreground/35";
	}
}

export function ScriptPanelFrame({
	title,
	subtitle,
	status = "idle",
	command,
	children,
}: ScriptPanelFrameProps) {
	const trimmedCommand = command?.trim();

	return (
		<div className="flex h-full min-h-0 flex-col bg-[color-mix(in_oklch,var(--sidebar)_94%,var(--foreground)_6%)]">
			<div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-border/50 px-3">
				<div className="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						className={cn(
							"size-1.5 shrink-0 rounded-full",
							statusClass(status),
						)}
					/>
					<div className="min-w-0">
						<div className="truncate text-[12px] font-medium leading-4 text-foreground">
							{title}
						</div>
						{subtitle ? (
							<div className="truncate text-[10.5px] leading-3 text-muted-foreground">
								{subtitle}
							</div>
						) : null}
					</div>
				</div>
				<div className="flex min-w-0 shrink items-center gap-2">
					{trimmedCommand ? (
						<code className="max-w-[11rem] truncate rounded-[4px] border border-border/50 bg-background/45 px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
							{trimmedCommand}
						</code>
					) : null}
					<span className="shrink-0 text-[10.5px] font-medium text-muted-foreground">
						{STATUS_LABELS[status]}
					</span>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">{children}</div>
		</div>
	);
}

type ScriptEmptyStateProps = {
	icon: LucideIcon;
	title: string;
	description: string;
	action: ReactNode;
	eyebrow?: string;
};

export function ScriptEmptyState({
	icon: Icon,
	title,
	description,
	action,
	eyebrow,
}: ScriptEmptyStateProps) {
	return (
		<div className="flex h-full flex-col justify-center px-5 py-6">
			<div className="mx-auto flex w-full max-w-[19rem] flex-col items-start gap-4">
				<div className="flex items-center gap-3">
					<div className="flex size-9 items-center justify-center rounded-md border border-border/60 bg-background/45 text-muted-foreground shadow-sm">
						<Icon className="size-4" strokeWidth={1.8} />
					</div>
					<div className="min-w-0">
						{eyebrow ? (
							<div className="mb-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
								{eyebrow}
							</div>
						) : null}
						<p className="text-[13px] font-medium leading-5 text-foreground">
							{title}
						</p>
					</div>
				</div>
				<p className="max-w-[17rem] text-[12px] leading-5 text-muted-foreground">
					{description}
				</p>
				{action}
			</div>
		</div>
	);
}
