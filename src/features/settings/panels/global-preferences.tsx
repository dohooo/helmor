import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import {
	loadGlobalPreferences,
	type RepoPreferences,
	updateGlobalPreferences,
} from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import {
	REPO_PREFERENCE_DESCRIPTIONS,
	REPO_PREFERENCE_LABELS,
	type RepoPreferenceKey,
} from "@/lib/repo-preferences-prompts";

const PREFERENCE_KEYS: RepoPreferenceKey[] = [
	"createPr",
	"review",
	"fixErrors",
	"resolveConflicts",
	"branchRename",
	"general",
];

export function GlobalPreferencesPanel() {
	const queryClient = useQueryClient();
	const query = useQuery({
		queryKey: helmorQueryKeys.globalPreferences(),
		queryFn: loadGlobalPreferences,
		staleTime: 0,
	});
	const preferences: RepoPreferences = query.data ?? {};
	const [drafts, setDrafts] = useState<RepoPreferences>({});
	const [openKey, setOpenKey] = useState<RepoPreferenceKey | null>(null);
	const [savingKey, setSavingKey] = useState<RepoPreferenceKey | null>(null);

	useEffect(() => {
		setDrafts(preferences);
	}, [preferences]);

	return (
		<div className="py-5">
			<div className="text-[13px] font-medium leading-snug text-foreground">
				Global preferences
			</div>
			<div className="mt-1 text-[12px] leading-snug text-muted-foreground">
				Template prompts inherited by every repo. Edits propagate to repos that
				follow each field.
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
										placeholder="Default prompt used by every repo unless overridden."
										value={value}
										onChange={(event) =>
											setDrafts((current) => ({
												...current,
												[key]: event.target.value,
											}))
										}
									/>
									<div className="mt-3 flex justify-end">
										<Button
											size="sm"
											disabled={savingKey === key}
											onClick={() => {
												setSavingKey(key);
												void updateGlobalPreferences({
													...preferences,
													[key]: value,
												})
													.then(async (summary) => {
														await queryClient.invalidateQueries({
															queryKey: helmorQueryKeys.globalPreferences(),
														});
														await queryClient.invalidateQueries({
															// Invalidate all open repo preferences views so they
															// re-resolve against the updated global template.
															predicate: (q) =>
																Array.isArray(q.queryKey) &&
																q.queryKey[0] === "repoPreferences",
														});
														if (summary.reposAffected > 0) {
															toast(
																`Updated global preferences · ${summary.reposAffected} repositor${
																	summary.reposAffected === 1
																		? "y follows"
																		: "ies follow"
																} these changes`,
															);
														}
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
	);
}
