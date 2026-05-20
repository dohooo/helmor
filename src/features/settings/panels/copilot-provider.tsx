import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, RefreshCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	type CopilotModelEntry,
	copilotLogout,
	getAgentLoginStatus,
	getCopilotAccountInfo,
	listCopilotModels,
	openAgentLoginTerminal,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { SettingsRow } from "../components/settings-row";

function formatPlan(plan: string): string {
	switch (plan) {
		case "individual_pro":
			return "Copilot Pro";
		case "individual_pro_plus":
			return "Copilot Pro+";
		case "business":
			return "Copilot Business";
		case "enterprise":
			return "Copilot Enterprise";
		default:
			return plan;
	}
}

function formatResetDate(date: string | null): string {
	if (!date) return "—";
	const d = new Date(date);
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function quotaBarColor(percent: number): string {
	if (percent < 20) return "bg-red-500";
	if (percent < 40) return "bg-yellow-500";
	if (percent < 60) return "bg-lime-500";
	return "bg-green-500";
}

export function CopilotProviderPanel() {
	const queryClient = useQueryClient();

	const statusQuery = useQuery({
		queryKey: ["agentLoginStatus"],
		queryFn: getAgentLoginStatus,
		refetchInterval: 5000,
	});

	const isReady = statusQuery.data?.copilot ?? false;

	const accountQuery = useQuery({
		queryKey: ["copilotAccountInfo"],
		queryFn: getCopilotAccountInfo,
		enabled: isReady,
		staleTime: 60_000,
	});

	const [fetchError, setFetchError] = useState<string | null>(null);
	const [cachedModels, setCachedModels] = useState<CopilotModelEntry[]>([]);

	const fetchMutation = useMutation({
		mutationFn: listCopilotModels,
		onSuccess: (models) => {
			setFetchError(null);
			setCachedModels(models);
		},
		onError: (error) => {
			setFetchError(error instanceof Error ? error.message : String(error));
		},
	});

	const logoutMutation = useMutation({
		mutationFn: copilotLogout,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["agentLoginStatus"] });
			queryClient.invalidateQueries({ queryKey: ["copilotAccountInfo"] });
			setCachedModels([]);
		},
	});

	const handleSignIn = useCallback(() => {
		openAgentLoginTerminal("copilot");
	}, []);

	const account = accountQuery.data;

	return (
		<div className="flex flex-col gap-2">
			<h3 className="mt-4 text-sm font-medium text-app-foreground">
				GitHub Copilot (ACP)
			</h3>

			{/* Authentication — token validity + login/logout */}
			<SettingsRow
				title="Authentication"
				description="Copilot uses your GitHub CLI authentication."
			>
				<div className="flex items-center gap-2">
					{statusQuery.isLoading ? (
						<span className="flex items-center gap-1 text-xs text-app-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" />
							Checking…
						</span>
					) : isReady ? (
						<div className="flex items-center gap-2">
							<span className="text-xs text-green-500">Authenticated</span>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 gap-1 text-xs text-app-muted-foreground"
								disabled={logoutMutation.isPending}
								onClick={() => logoutMutation.mutate()}
							>
								<LogOut className="size-3" />
								Sign out
							</Button>
						</div>
					) : (
						<div className="flex items-center gap-2">
							<span className="text-xs text-orange-400">
								Need Reauthentication
							</span>
							<Button variant="outline" size="sm" onClick={handleSignIn}>
								Sign in
							</Button>
						</div>
					)}
				</div>
			</SettingsRow>

			{/* Account info card */}
			{isReady && accountQuery.isLoading && (
				<div className="flex items-center gap-2 rounded-md border border-border/40 px-3 py-3">
					<Loader2 className="size-4 animate-spin text-app-muted-foreground" />
					<span className="text-xs text-app-muted-foreground">
						Loading account info…
					</span>
				</div>
			)}

			{isReady && accountQuery.isError && (
				<div className="rounded-md border border-border/40 px-3 py-3">
					<span className="text-xs text-orange-400">
						Could not load account info. Check your GitHub authentication.
					</span>
				</div>
			)}

			{isReady && account && (
				<div className="flex flex-col gap-3 rounded-md border border-border/40 px-3 py-3">
					{/* Row 1: Avatar + Identity + Plan */}
					<div className="flex items-center gap-3">
						<img
							src={`https://github.com/${account.login}.png?size=80`}
							alt={account.login}
							className="size-10 shrink-0 rounded-full bg-app-muted"
							onError={(e) => {
								e.currentTarget.style.display = "none";
							}}
						/>
						<div className="flex flex-col gap-0.5">
							<span className="text-[13px] font-medium text-app-foreground">
								{account.login}
							</span>
							<span className="text-[11px] text-app-muted-foreground">
								Plan: {formatPlan(account.copilotPlan)}
							</span>
						</div>
					</div>

					{/* Row 2: Premium Requests */}
					{account.premiumRequestsEntitlement > 0 && (
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center justify-between text-[11px]">
								<span className="text-app-foreground">Premium Requests</span>
								<span className="text-app-muted-foreground">
									{account.premiumRequestsRemaining} /{" "}
									{account.premiumRequestsEntitlement} (
									{Math.round(account.premiumRequestsPercentRemaining)}%) ·
									Resets {formatResetDate(account.quotaResetDate)}
								</span>
							</div>
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-app-muted/50">
								<div
									className={cn(
										"h-full rounded-full transition-all",
										quotaBarColor(account.premiumRequestsPercentRemaining),
									)}
									style={{
										width: `${account.premiumRequestsPercentRemaining}%`,
									}}
								/>
							</div>
						</div>
					)}

					{/* Row 3: Chat */}
					{account.chatUnlimited && (
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center justify-between text-[11px]">
								<span className="text-app-foreground">Chat</span>
								<span className="text-app-muted-foreground">Unlimited</span>
							</div>
							<div className="h-1.5 w-full overflow-hidden rounded-full bg-app-muted/50">
								<div className="h-full w-full rounded-full bg-green-500" />
							</div>
						</div>
					)}
				</div>
			)}

			{/* Models */}
			{isReady && (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between">
						<div className="flex flex-col">
							<span className="text-[13px] font-medium text-app-foreground">
								Models
							</span>
							<span className="text-[11px] text-app-muted-foreground">
								{fetchError
									? `Could not fetch — ${fetchError}`
									: "Available models from Copilot API."}
							</span>
						</div>
						<Button
							variant="outline"
							size="sm"
							disabled={fetchMutation.isPending}
							onClick={() => fetchMutation.mutate()}
						>
							<RefreshCcw
								className={cn(
									"mr-1.5 size-3.5",
									fetchMutation.isPending && "animate-spin",
								)}
							/>
							{fetchMutation.isPending
								? "Loading…"
								: cachedModels.length > 0
									? "Refresh"
									: "Fetch models"}
						</Button>
					</div>

					{cachedModels.length > 0 && (
						<div className="rounded-md border border-border/50">
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-border/50 text-app-muted-foreground">
										<th className="px-3 py-1.5 text-left font-medium">Model</th>
										<th className="px-3 py-1.5 text-left font-medium">
											Effort Levels
										</th>
									</tr>
								</thead>
								<tbody>
									{cachedModels.map((model) => (
										<tr
											key={model.id}
											className="border-b border-border/30 last:border-b-0"
										>
											<td className="px-3 py-1.5 font-medium text-app-foreground">
												{model.label}
											</td>
											<td className="px-3 py-1.5 text-app-muted-foreground">
												{model.effortLevels.length > 0
													? model.effortLevels.join(", ")
													: "—"}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</div>
			)}

			<p className="text-xs text-app-muted-foreground">
				Requires a GitHub Copilot subscription and the{" "}
				<code className="rounded bg-app-muted px-1">copilot</code> CLI.
			</p>
		</div>
	);
}
