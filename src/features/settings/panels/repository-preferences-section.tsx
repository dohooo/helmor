import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { LazyStreamdown } from "@/components/streamdown-loader";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
	loadRepoPreferences,
	type RepoPreferences,
	updateRepoPreferences,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	REPO_PREFERENCE_DESCRIPTIONS,
	REPO_PREFERENCE_LABELS,
	type RepoPreferenceKey,
	resolveRepoPreferencePreview,
} from "@/lib/repo-preferences-prompts";

const PREFERENCE_KEYS: RepoPreferenceKey[] = [
	"createPr",
	"reviewPr",
	"fixErrors",
	"resolveConflicts",
	"branchRename",
	"general",
];

export function RepositoryPreferencesSection({ repoId }: { repoId: string }) {
	const queryClient = useQueryClient();
	const preferencesQuery = useQuery({
		queryKey: helmorQueryKeys.repoPreferences(repoId),
		queryFn: () => loadRepoPreferences(repoId),
		staleTime: 0,
	});
	const preferences = preferencesQuery.data ?? {};
	const [drafts, setDrafts] = useState<RepoPreferences>({});
	const [openKey, setOpenKey] = useState<RepoPreferenceKey | null>(null);
	const [savingKey, setSavingKey] = useState<RepoPreferenceKey | null>(null);
	const [previewKey, setPreviewKey] = useState<RepoPreferenceKey | null>(null);

	useEffect(() => {
		setDrafts(preferences);
	}, [preferences]);

	const previewMarkdown = useMemo(() => {
		if (!previewKey) {
			return "";
		}
		return resolveRepoPreferencePreview(previewKey, drafts);
	}, [drafts, previewKey]);

	return (
		<>
			<div className="py-5">
				<div className="text-[13px] font-medium leading-snug text-foreground">
					Preferences
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Repo-level built-in prompts used by Helmor actions and new chats.
				</div>
				<div className="mt-4 divide-y divide-app-border/20">
					{PREFERENCE_KEYS.map((key) => {
						const isOpen = openKey === key;
						const value = drafts[key] ?? "";
						return (
							<Collapsible
								key={key}
								open={isOpen}
								onOpenChange={(next) => setOpenKey(next ? key : null)}
							>
								<div className="py-4">
									<CollapsibleTrigger asChild>
										<button
											type="button"
											className="flex w-full cursor-pointer items-start justify-between gap-4 text-left"
										>
											<div>
												<div className="text-[13px] font-medium text-app-foreground">
													{REPO_PREFERENCE_LABELS[key]}
												</div>
												<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
													{REPO_PREFERENCE_DESCRIPTIONS[key]}
												</div>
											</div>
											<ChevronDown
												className={`mt-0.5 size-4 shrink-0 text-app-muted transition-transform ${
													isOpen ? "rotate-180" : ""
												}`}
												strokeWidth={1.8}
											/>
										</button>
									</CollapsibleTrigger>
									<CollapsibleContent className="pt-4">
										<Textarea
											className="min-h-[140px] resize-y bg-app-base/30 font-mono text-[12px] placeholder:text-[12px]"
											placeholder={
												key === "general"
													? "Add custom instructions for all agents working in this repo."
													: "Add your preferences here. The agent will be told to prioritize these instructions over its default instructions."
											}
											value={value}
											onChange={(event) =>
												setDrafts((current) => ({
													...current,
													[key]: event.target.value,
												}))
											}
										/>
										<div className="mt-3 flex items-center justify-between gap-3">
											<button
												type="button"
												className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-app-muted transition-colors hover:text-app-foreground"
												onClick={() => setPreviewKey(key)}
											>
												<Eye className="size-3.5" strokeWidth={1.8} />
												<span>Preview</span>
											</button>
											<Button
												size="sm"
												disabled={savingKey === key}
												onClick={() => {
													setSavingKey(key);
													void updateRepoPreferences(repoId, {
														...preferences,
														[key]: value,
													})
														.then(async () => {
															await queryClient.invalidateQueries({
																queryKey:
																	helmorQueryKeys.repoPreferences(repoId),
															});
														})
														.finally(() => setSavingKey(null));
												}}
											>
												{savingKey === key ? "Saving..." : "Save"}
											</Button>
										</div>
									</CollapsibleContent>
								</div>
							</Collapsible>
						);
					})}
				</div>
			</div>

			<Dialog
				open={previewKey !== null}
				onOpenChange={(open) => !open && setPreviewKey(null)}
			>
				<DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] sm:w-[min(76vw,760px)] sm:max-w-[760px] rounded-2xl border-border/60 bg-background p-0 shadow-2xl">
					<div className="px-6 pt-4">
						<DialogTitle className="text-[18px] font-semibold text-foreground">
							{previewKey
								? `${REPO_PREFERENCE_LABELS[previewKey]} prompt`
								: "Prompt preview"}
						</DialogTitle>
					</div>
					<div className="max-h-[78vh] overflow-y-auto px-6 pb-5 pt-1">
						<div className="conversation-markdown max-w-none break-words text-[13px] leading-6 text-foreground">
							<Suspense
								fallback={
									<pre className="whitespace-pre-wrap break-words">
										{previewMarkdown}
									</pre>
								}
							>
								<LazyStreamdown
									className="conversation-streamdown"
									mode="static"
								>
									{previewMarkdown}
								</LazyStreamdown>
							</Suspense>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
