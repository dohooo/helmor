import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import type { AgentModelSection } from "@/lib/api";
import { agentModelSectionsQueryOptions } from "@/lib/query-client";
import { type AppSettings, useSettings } from "@/lib/settings";
import { findModelOption } from "@/lib/workspace-helpers";

const KNOWN_MODEL_PROVIDERS = ["claude", "codex"] as const;

function isModelCatalogSettled(sections: AgentModelSection[]) {
	if (sections.length === 0) return false;
	const sectionsById = new Map(
		sections.map((section) => [section.id, section]),
	);
	return KNOWN_MODEL_PROVIDERS.every((provider) => {
		const section = sectionsById.get(provider);
		if (!section) return false;
		return (section.status ?? "ready") !== "error";
	});
}

/**
 * Invariant: once the model catalog has settled, every stored model id must
 * point to a model that still exists. `defaultModelId` is repaired to a
 * sensible default; stale `review`/`pr` picks (e.g. a delisted model) are
 * unset so they fall back to the default. No per-model migration needed —
 * this self-heals on cold-start for any future delist.
 */
export function useEnsureDefaultModel() {
	const { settings, isLoaded, updateSettings } = useSettings();
	const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
	const sections = modelSectionsQuery.data;

	useEffect(() => {
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
				settings.reviewModelId &&
				!findModelOption(sections, settings.reviewModelId)
			) {
				patch.reviewModelId = null;
			}
			if (
				settings.prModelId &&
				!findModelOption(sections, settings.prModelId)
			) {
				patch.prModelId = null;
			}
		}

		const defaultValid =
			!!settings.defaultModelId &&
			!!findModelOption(sections, settings.defaultModelId);

		// Repair the default when it's never been set, or was set but is now
		// definitively gone (wait for every provider to settle first).
		if (!defaultValid && (settled || !settings.defaultModelId)) {
			// Prefer the Claude `default` entry (auto-latest Opus) over the
			// first listed option — pricier models (Fable 5) sit above it in
			// the picker but must not become the app default.
			const claudeOptions =
				sections.find((s) => s.id === "claude")?.options ?? [];
			const pick =
				claudeOptions.find((o) => o.id === "default")?.id ??
				claudeOptions[0]?.id ??
				allOptions[0]?.id ??
				null;
			if (pick) {
				patch.defaultModelId = pick;
				// Materialize null review/pr fields alongside the default so a
				// fresh install doesn't depend on the next cold-start migration.
				if (settings.reviewModelId === null) patch.reviewModelId = pick;
				if (settings.prModelId === null) patch.prModelId = pick;
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
		settings.defaultModelId,
		settings.reviewModelId,
		settings.prModelId,
		settings.reviewEffort,
		settings.prEffort,
		settings.reviewFastMode,
		settings.prFastMode,
		settings.defaultEffort,
		settings.defaultFastMode,
		updateSettings,
	]);
}
