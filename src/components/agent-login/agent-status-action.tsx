import { Button } from "@/components/ui/button";
import type { AgentLoginProvider } from "@/lib/api";
import { I18nText } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ConnectingStatus } from "./connecting-status";
import { ReadyStatus } from "./ready-status";
import type { AgentLoginStatus } from "./types";

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
	if (status === "checking") {
		return <ConnectingStatus />;
	}

	if (status === "ready") {
		return <ReadyStatus />;
	}

	return (
		<Button
			type="button"
			size="sm"
			className={cn(
				"group h-7 shrink-0 px-2 text-small",
				waiting &&
					"bg-muted-foreground/70 text-background hover:bg-primary hover:text-primary-foreground",
			)}
			title={waiting ? "miscRestartSetup" : undefined}
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
					<span className="group-hover:hidden">
						<I18nText source="waiting" />
					</span>
					<span className="hidden group-hover:inline">
						<I18nText source="restart" />
					</span>
				</>
			) : (
				<I18nText source="log" />
			)}
		</Button>
	);
}
