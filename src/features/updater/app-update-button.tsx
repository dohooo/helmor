import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppUpdateStatus } from "@/lib/api";
import { installDownloadedAppUpdate } from "@/lib/api";
import { openUrl } from "@/lib/platform-bridge";
import { cn } from "@/lib/utils";

type AppUpdateButtonProps = {
	status: AppUpdateStatus | null;
	className?: string;
};

export function AppUpdateButton({ status, className }: AppUpdateButtonProps) {
	const [installing, setInstalling] = useState(false);

	if (status?.stage !== "downloaded" || !status.update) {
		return null;
	}

	const update = status.update;

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="default"
					size="xs"
					aria-label={`Update Helmor to ${update.version}`}
					className={cn(
						"h-6 gap-1 rounded-sm px-1.5 text-mini font-medium tracking-[0.01em] transition-[background-color,color,border-color,box-shadow] duration-200 hover:bg-primary/90",
						className,
					)}
					onClick={() => {
						setInstalling(true);
						void installDownloadedAppUpdate()
							.catch((error: unknown) => {
								toast.error("Install failed", {
									description:
										error instanceof Error
											? error.message
											: "Unable to install the downloaded update.",
									action: update.releaseUrl
										? {
												label: "Change log",
												onClick: () => void openUrl(update.releaseUrl),
											}
										: undefined,
								});
							})
							.finally(() => setInstalling(false));
					}}
					disabled={installing}
				>
					{installing ? (
						<Loader2 className="size-3 animate-spin" />
					) : (
						<Download className="size-3" />
					)}
					<span>Update</span>
				</Button>
			</TooltipTrigger>
			<TooltipContent
				side="top"
				sideOffset={4}
				className="flex h-[22px] items-center gap-1 rounded-md px-1.5 text-mini leading-none"
			>
				{update.currentVersion} {"->"} {update.version}
			</TooltipContent>
		</Tooltip>
	);
}
