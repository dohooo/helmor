import { ChevronDown, ChevronRight, Package, RotateCw } from "lucide-react";
import { useState } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Lightweight pill in the left sidebar's window-safe top row that opens
 * a translucent process-tree readout showing Helmor's own renderer
 * processes and the per-workspace children spawned underneath.
 *
 * **Currently a visual stub** — the metrics + tree are wired to a
 * static placeholder dataset so the design can be iterated on without
 * blocking on the backend `sysinfo`-based collector. Real data lands in
 * a follow-up that walks Helmor's process tree and groups child PIDs
 * (sidecar / agent CLI / script process manager / terminal PTYs) back
 * to their owning workspace.
 */
export function ResourceUsagePill() {
	const [open, setOpen] = useState(false);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Open resource usage panel"
					className={cn(
						"group/resource flex h-6 cursor-pointer items-center gap-1.5 rounded-md border border-transparent px-1.5 text-[11.5px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
						"data-[state=open]:border-border/60 data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground",
					)}
				>
					<span className="relative flex size-2 items-center justify-center">
						<span className="size-1.5 rounded-full bg-emerald-500" />
						<span className="absolute size-2 animate-ping rounded-full bg-emerald-500/50" />
					</span>
					<span className="tabular-nums">— GB</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				sideOffset={6}
				className="w-[392px] border-white/10 bg-popover/70 p-0 backdrop-blur-xl"
			>
				<ResourcePlaceholder onClose={() => setOpen(false)} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function ResourcePlaceholder({ onClose: _onClose }: { onClose: () => void }) {
	return (
		<div className="flex flex-col">
			<header className="flex items-center justify-between px-4 pb-2 pt-3">
				<span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
					Resource usage
				</span>
				<div className="flex items-center gap-1 text-muted-foreground/80">
					<button
						type="button"
						className="flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] font-medium hover:bg-foreground/[0.06] hover:text-foreground"
					>
						<span>Memory</span>
						<ChevronDown className="size-3" strokeWidth={2} />
					</button>
					<button
						type="button"
						aria-label="Refresh resource usage"
						className="flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-foreground/[0.06] hover:text-foreground"
					>
						<RotateCw className="size-3.5" strokeWidth={1.8} />
					</button>
				</div>
			</header>

			<div className="grid grid-cols-3 gap-2 px-4 pb-3 pt-1">
				<MetricColumn label="CPU" value="—" />
				<MetricColumn label="Memory" value="— GB" />
				<MetricColumn label="RAM share" value="—%" />
			</div>

			<div className="border-t border-white/5">
				<ProcessRow
					indent={0}
					expandable
					expanded
					name="Helmor App"
					cpu="—"
					memory="— MB"
					emphasis
				/>
				<ProcessRow indent={1} name="Main" cpu="—" memory="— MB" muted />
				<ProcessRow indent={1} name="Renderer" cpu="—" memory="— MB" muted />
				<ProcessRow indent={1} name="Other" cpu="—" memory="— MB" muted />
				<ProcessRow
					indent={0}
					expandable
					expanded={false}
					name="Sample workspace"
					cpu="—"
					memory="— MB"
					emphasis
				/>
			</div>

			<footer className="px-4 py-2 text-[10.5px] text-muted-foreground/60">
				Live data lands once the backend collector is wired — see TODO in{" "}
				<code className="rounded bg-foreground/[0.06] px-1 py-px font-mono text-[10px]">
					resource-usage-pill.tsx
				</code>
				.
			</footer>
		</div>
	);
}

function MetricColumn({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col">
			<span className="text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground/80">
				{label}
			</span>
			<span className="text-[15px] font-semibold tabular-nums text-foreground/95">
				{value}
			</span>
		</div>
	);
}

function ProcessRow({
	indent,
	expandable = false,
	expanded = false,
	name,
	cpu,
	memory,
	emphasis = false,
	muted = false,
}: {
	indent: number;
	expandable?: boolean;
	expanded?: boolean;
	name: string;
	cpu: string;
	memory: string;
	emphasis?: boolean;
	muted?: boolean;
}) {
	return (
		<div
			className="flex items-center gap-2 px-4 py-1.5 text-[11.5px]"
			style={{ paddingLeft: 16 + indent * 14 }}
		>
			{expandable ? (
				expanded ? (
					<ChevronDown
						className="size-3 shrink-0 text-muted-foreground/70"
						strokeWidth={2}
					/>
				) : (
					<ChevronRight
						className="size-3 shrink-0 text-muted-foreground/70"
						strokeWidth={2}
					/>
				)
			) : (
				<Package
					className="size-3 shrink-0 text-muted-foreground/40"
					strokeWidth={2}
				/>
			)}
			<span
				className={cn(
					"flex-1 truncate",
					emphasis && "font-medium text-foreground/90",
					muted && "text-muted-foreground/80",
				)}
			>
				{name}
			</span>
			<span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground/85">
				{cpu}
			</span>
			<span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground/85">
				{memory}
			</span>
		</div>
	);
}
