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
	EMPTY_INHERIT_FLAGS,
	type InheritFlags,
	loadRepoPreferences,
	type RepoPreferences,
	type RepoPreferencesResolved,
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
	"review",
	"fixErrors",
	"resolveConflicts",
	"branchRename",
	"general",
];

const EMPTY_RESOLVED: RepoPreferencesResolved = {
	overrides: {},
	inherit: { ...EMPTY_INHERIT_FLAGS },
	global: {},
	effective: {},
};

function placeholderFor(
	key: RepoPreferenceKey,
	globalText: string | null | undefined,
): string {
	if (globalText?.trim()) {
		const truncated =
			globalText.length > 140 ? `${globalText.slice(0, 140)}…` : globalText;
		return `Following global: ${truncated}`;
	}
	if (key === "general") {
		return "Add custom instructions for all agents working in this repo.";
	}
	return "Add your preferences here. The agent will be told to prioritize these instructions over its default instructions.";
}

export function RepositoryPreferencesSection({ repoId }: { repoId: string }) {
	const queryClient = useQueryClient();
	const preferencesQuery = useQuery({
		queryKey: helmorQueryKeys.repoPreferences(repoId),
		queryFn: () => loadRepoPreferences(repoId),
		staleTime: 0,
	});
	const resolved: RepoPreferencesResolved =
		preferencesQuery.data ?? EMPTY_RESOLVED;

	const [draftOverrides, setDraftOverrides] = useState<RepoPreferences>({});
	const [draftInherit, setDraftInherit] =
		useState<InheritFlags>(EMPTY_INHERIT_FLAGS);
	const [openKey, setOpenKey] = useState<RepoPreferenceKey | null>(null);
	const [savingKey, setSavingKey] = useState<RepoPreferenceKey | null>(null);
	const [previewKey, setPreviewKey] = useState<RepoPreferenceKey | null>(null);

	useEffect(() => {
		setDraftOverrides(resolved.overrides);
		setDraftInherit(resolved.inherit);
	}, [resolved]);

	const previewMarkdown = useMemo(() => {
		if (!previewKey) return "";
		// Preview the value the agent would actually see.
		const previewSource: RepoPreferences = { ...draftOverrides };
		for (const k of PREFERENCE_KEYS) {
			if (draftInherit[k]) {
				previewSource[k] = resolved.global[k] ?? null;
			}
		}
		return resolveRepoPreferencePreview(previewKey, previewSource);
	}, [draftOverrides, draftInherit, resolved.global, previewKey]);

	return (
		<>
			<div className="py-5">
				<div className="text-[13px] font-medium leading-snug text-foreground">
					Preferences
				</div>
				<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
					Repo-level prompts. Each field can follow the global template or be
					overridden per repo.
				</div>
				<div className="mt-4 divide-y divide-app-border/20">
					{PREFERENCE_KEYS.map((key) => {
						const isOpen = openKey === key;
						const isInherit = draftInherit[key];
						const editorValue = isInherit ? "" : (draftOverrides[key] ?? "");
						const placeholder = placeholderFor(key, resolved.global[key]);
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
											<div className="flex-1">
												<div className="flex items-center gap-2">
													<div className="text-[13px] font-medium text-app-foreground">
														{REPO_PREFERENCE_LABELS[key]}
													</div>
													<span
														className={
															isInherit
																? "rounded-full bg-app-base/40 px-2 py-[2px] text-[10px] font-medium uppercase tracking-wide text-app-muted"
																: "rounded-full bg-accent/15 px-2 py-[2px] text-[10px] font-medium uppercase tracking-wide text-accent-foreground"
														}
													>
														{isInherit ? "Following global" : "Overridden"}
													</span>
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
											placeholder={placeholder}
											value={editorValue}
											onChange={(event) => {
												const next = event.target.value;
												setDraftOverrides((current) => ({
													...current,
													[key]: next,
												}));
												// Auto-detach on edit.
												setDraftInherit((current) => ({
													...current,
													[key]: false,
												}));
											}}
										/>
										<div className="mt-3 flex items-center justify-between gap-3">
											<div className="flex items-center gap-3">
												<button
													type="button"
													className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-app-muted transition-colors hover:text-app-foreground"
													onClick={() => setPreviewKey(key)}
												>
													<Eye className="size-3.5" strokeWidth={1.8} />
													<span>Preview</span>
												</button>
												{!isInherit && (
													<button
														type="button"
														className="cursor-pointer text-[12px] text-app-muted underline-offset-4 hover:text-app-foreground hover:underline"
														onClick={() =>
															setDraftInherit((current) => ({
																...current,
																[key]: true,
															}))
														}
													>
														Reset to global
													</button>
												)}
											</div>
											<Button
												size="sm"
												disabled={savingKey === key}
												onClick={() => {
													setSavingKey(key);
													void updateRepoPreferences(
														repoId,
														draftOverrides,
														draftInherit,
													)
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
