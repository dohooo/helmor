import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AgentModelSection } from "@/lib/api";
import { agentModelSectionsQueryOptions } from "@/lib/query-client";
import { type AppSettings, type ModelRef, useSettings } from "@/lib/settings";
import { isQuickPanelWindow } from "@/lib/window-role";
import { findModelOption } from "@/lib/workspace-helpers";

function isModelCatalogSettled(sections: AgentModelSection[]) {
	// Don't require any specific provider: users can hide a provider entirely.
	if (sections.length === 0) return false;
	return sections.every((section) => (section.status ?? "ready") !== "error");
}

/**
 * Invariant: once the model catalog has settled, every stored model id must
 * point to a model that still exists. `defaultModel` is repaired to a
 * sensible default; stale `review`/`pr` picks (e.g. a delisted model) are
 * unset so they fall back to the default. No per-model migration needed —
 * this self-heals on cold-start for any future delist.
 */
export function useEnsureDefaultModel() {
	const { settings, isLoaded, updateSettings } = useSettings();
	const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
	const sections = modelSectionsQuery.data;

	useEffect(() => {
		// Settings self-repair runs from one window only to avoid racing
		// concurrent `updateSettings` patches across webviews.
		if (isQuickPanelWindow) return;
		if (!isLoaded) return;
		if (!sections || sections.length === 0) return;
		const settled = isModelCatalogSettled(sections);
		const allOptions = sections.flatMap((s) => s.options);
		const patch: Partial<AppSettings> = {};

		// Unset stale review/pr picks (non-null but gone from the catalog) so
		// they fall back to the default. Only act once settled, so we don't
		// confuse "delisted" with "still loading".
		if (settled) {
			if (
				settings.reviewModel &&
				!findModelOption(sections, settings.reviewModel.modelId)
			) {
				patch.reviewModel = null;
			}
			if (
				settings.prModel &&
				!findModelOption(sections, settings.prModel.modelId)
			) {
				patch.prModel = null;
			}
		}

		const defaultOption = settings.defaultModel
			? findModelOption(sections, settings.defaultModel.modelId)
			: null;

		// Repair the default when it's never been set, or was set but is now
		// definitively gone (wait for every provider to settle first).
		if (!defaultOption && (settled || !settings.defaultModel)) {
			// Prefer the Claude `default` entry (auto-latest Opus) over the
			// first listed option — pricier models (Fable 5) sit above it in
			// the picker but must not become the app default.
			const claudeOptions =
				sections.find((s) => s.id === "claude")?.options ?? [];
			const pickOption =
				claudeOptions.find((o) => o.id === "default") ??
				claudeOptions[0] ??
				allOptions[0] ??
				null;
			if (pickOption) {
				const pick: ModelRef = {
					provider: pickOption.provider,
					modelId: pickOption.id,
				};
				patch.defaultModel = pick;
				// Materialize null review/pr fields alongside the default so a
				// fresh install doesn't depend on the next cold-start migration.
				if (settings.reviewModel === null) patch.reviewModel = pick;
				if (settings.prModel === null) patch.prModel = pick;
				if (settings.reviewEffort === null) {
					patch.reviewEffort = settings.defaultEffort;
				}
				if (settings.prEffort === null) patch.prEffort = settings.defaultEffort;
				if (settings.reviewFastMode === null) {
					patch.reviewFastMode = settings.defaultFastMode;
				}
				if (settings.prFastMode === null) {
					patch.prFastMode = settings.defaultFastMode;
				}
			}
		}

		if (Object.keys(patch).length > 0) updateSettings(patch);
	}, [
		isLoaded,
		sections,
		settings.defaultModel,
		settings.reviewModel,
		settings.prModel,
		settings.reviewEffort,
		settings.prEffort,
		settings.reviewFastMode,
		settings.prFastMode,
		settings.defaultEffort,
		settings.defaultFastMode,
		updateSettings,
	]);
}
