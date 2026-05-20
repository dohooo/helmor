import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CheckCircle2,
	Loader2,
	LogOut,
	RefreshCcw,
	XCircle,
} from "lucide-react";
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
		<div className="flex flex-col gap-3">
			<h3 className="text-sm font-medium text-app-foreground">
				GitHub Copilot (ACP)
			</h3>

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
							{account?.avatarUrl && (
								<img
									src={account.avatarUrl}
									alt={account.login}
									className="size-5 rounded-full"
								/>
							)}
							<span className="flex items-center gap-1 text-xs text-green-500">
								<CheckCircle2 className="size-3.5" />
								{account?.login ?? "Authenticated"}
							</span>
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
						<>
							<span className="flex items-center gap-1 text-xs text-app-muted-foreground">
								<XCircle className="size-3.5" />
								Not signed in
							</span>
							<Button variant="outline" size="sm" onClick={handleSignIn}>
								Sign in
							</Button>
						</>
					)}
				</div>
			</SettingsRow>

			{isReady && (
				<SettingsRow
					title="Models"
					description={
						fetchError
							? `Could not fetch models — ${fetchError}`
							: "Available models from Copilot CLI. Click Refresh to update."
					}
					align="start"
				>
					<div className="flex w-[400px] flex-col gap-2">
						<div className="flex items-center gap-2">
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
								{cachedModels.length > 0 ? "Refresh" : "Fetch models"}
							</Button>
							{fetchMutation.isPending && (
								<span className="text-xs text-app-muted-foreground">
									Loading…
								</span>
							)}
						</div>

						{cachedModels.length > 0 && (
							<div className="rounded-md border border-border/50">
								<table className="w-full text-xs">
									<thead>
										<tr className="border-b border-border/50 text-app-muted-foreground">
											<th className="px-3 py-1.5 text-left font-medium">
												Model
											</th>
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
				</SettingsRow>
			)}

			<p className="text-xs text-app-muted-foreground">
				Requires a GitHub Copilot subscription and the{" "}
				<code className="rounded bg-app-muted px-1">copilot</code> CLI.
			</p>
		</div>
	);
}
