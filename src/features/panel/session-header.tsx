import { ChevronDown, Columns2, X } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { WorkspaceSessionSummary } from "@/lib/api";
import { cn } from "@/lib/utils";
import { displaySessionTitle } from "./header";

export function WorkspaceSessionSurfaceHeader({
	session,
}: {
	session: WorkspaceSessionSummary | null;
}) {
	const title = session ? displaySessionTitle(session) : null;

	return (
		<div
			className="flex h-7 items-center border-y border-border/60 bg-foreground/[0.025] px-4"
			data-tauri-drag-region
		>
			<div className="flex min-w-0 items-center">
				{title ? (
					<DropdownMenu>
						<Tooltip>
							<TooltipTrigger asChild>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label="Session presets"
										className={cn(
											"group/title inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-[4px] px-1 py-0.5 font-mono text-[11px] italic text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
											"data-[state=open]:bg-foreground/[0.10] data-[state=open]:text-foreground",
										)}
									>
										<span className="truncate">{title}</span>
										<ChevronDown
											className="size-3 shrink-0 opacity-60 transition-opacity group-hover/title:opacity-100"
											strokeWidth={1.8}
										/>
									</button>
								</DropdownMenuTrigger>
							</TooltipTrigger>
							<TooltipContent side="bottom" sideOffset={4}>
								Session presets
							</TooltipContent>
						</Tooltip>
						<DropdownMenuContent
							align="start"
							className="w-56 overscroll-contain"
						>
							<div className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
								Session presets coming soon
							</div>
						</DropdownMenuContent>
					</DropdownMenu>
				) : null}
			</div>

			<div className="min-w-0 flex-1" data-tauri-drag-region />

			<div className="flex shrink-0 items-center gap-0.5">
				<SessionWindowAction label="Split panel" icon={Columns2} />
				<SessionWindowAction label="Close" icon={X} />
			</div>
		</div>
	);
}

function SessionWindowAction({
	label,
	icon: Icon,
}: {
	label: string;
	icon: typeof X;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
				>
					<Icon strokeWidth={1.8} className="size-3" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom" sideOffset={4}>
				{label}
			</TooltipContent>
		</Tooltip>
	);
}
