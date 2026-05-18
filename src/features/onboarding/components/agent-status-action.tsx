import { Button } from "@/components/ui/button";
import type { AgentLoginProvider } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { AgentLoginStatus } from "../types";
import { ReadyStatus } from "./ready-status";

export function AgentStatusAction({
	provider,
	status,
	waiting = false,
	onPrimeLogin,
	onStartLogin,
}: {
	provider: AgentLoginProvider;
	status: AgentLoginStatus;
	waiting?: boolean;
	onPrimeLogin?: (provider: AgentLoginProvider) => void;
	onStartLogin?: (provider: AgentLoginProvider) => void;
}) {
	if (status === "ready") {
		return <ReadyStatus />;
	}

	return (
		<Button
			type="button"
			size="sm"
			className={cn(
				"group h-7 shrink-0 px-2 text-xs",
				waiting &&
					"bg-muted-foreground/70 text-background hover:bg-primary hover:text-primary-foreground",
			)}
			title={waiting ? "Restart setup" : undefined}
			onMouseEnter={() => {
				onPrimeLogin?.(provider);
			}}
			onFocus={() => {
				onPrimeLogin?.(provider);
			}}
			onClick={() => {
				onStartLogin?.(provider);
			}}
		>
			{waiting ? (
				<>
					<span className="group-hover:hidden">Waiting...</span>
					<span className="hidden group-hover:inline">Restart</span>
				</>
			) : (
				"Log in"
			)}
		</Button>
	);
}
