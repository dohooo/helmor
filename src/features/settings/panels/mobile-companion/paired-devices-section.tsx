import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { PairedDevice } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatLastSeen(ts: string | null): string {
	if (!ts) return "Never connected";
	const parsed = new Date(ts);
	if (Number.isNaN(parsed.getTime())) return "Last connected recently";
	return `Last connected ${parsed.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	})}`;
}

export function PairedDevicesSection({
	className,
	devices,
	isDisconnecting,
	onDisconnect,
}: {
	className?: string;
	devices: PairedDevice[];
	isDisconnecting: boolean;
	onDisconnect: (deviceId: string) => void;
}) {
	return (
		<div className={cn("flex min-h-0 flex-col gap-2", className)}>
			{devices.length === 0 ? (
				<div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border/40 px-3 py-2 text-center">
					<p className="text-small text-muted-foreground">
						No devices paired yet.
					</p>
				</div>
			) : (
				<TooltipProvider delayDuration={150}>
					<div className="min-h-0 flex-1 overflow-y-auto pr-1">
						<div className="flex flex-col">
							{devices.map((device) => (
								<div
									key={device.id}
									className="flex min-h-10 items-center justify-between border-b border-border/40 py-2 last:border-b-0"
								>
									<div className="min-w-0 flex-1 truncate text-small">
										<span className="text-foreground">{device.label}</span>
										<span className="text-muted-foreground">
											{" - "}
											{formatLastSeen(device.lastSeenAt)}
										</span>
									</div>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon-xs"
												className="shrink-0 cursor-pointer text-muted-foreground/70 hover:bg-muted hover:text-muted-foreground"
												aria-label={`Remove ${device.label}`}
												disabled={isDisconnecting}
												onClick={() => onDisconnect(device.id)}
											>
												<X className="size-3.5" strokeWidth={1.9} />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="top">Remove device</TooltipContent>
									</Tooltip>
								</div>
							))}
						</div>
					</div>
				</TooltipProvider>
			)}
		</div>
	);
}
