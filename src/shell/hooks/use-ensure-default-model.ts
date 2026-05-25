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
 * Invariant: once the model catalog is ready, `settings.defaultModelId` must
 * point to a model that exists in the catalog. If it doesn't (never set, or
 * the previously-picked model is gone), pick a reasonable default and write
 * it back. This is the single place that decides the initial default — every
 * other consumer reads `settings.defaultModelId` directly.
 */
export function useEnsureDefaultModel() {
	const { settings, isLoaded, updateSettings } = useSettings();
	const modelSectionsQuery = useQuery(agentModelSectionsQueryOptions());
	const sections = modelSectionsQuery.data;

	useEffect(() => {
		if (!isLoaded) return;
		if (!sections || sections.length === 0) return;
		const allOptions = sections.flatMap((s) => s.options);

		// Already valid — nothing to do.
		if (
			settings.defaultModelId &&
			findModelOption(sections, settings.defaultModelId)
		) {
			return;
		}

		// User previously saved a model but it's not in the catalog. Only
		// repair it once every provider has reached a terminal state.
		if (settings.defaultModelId && !isModelCatalogSettled(sections)) return;

		// Never been set (null), or a previously-saved value is now definitively
		// unavailable — pick a sensible available default.
		const pick =
			sections.find((s) => s.id === "claude")?.options[0]?.id ??
			allOptions[0]?.id ??
			null;
		if (!pick) return;

		// Materialize null review/pr fields alongside the default so a fresh
		// install doesn't depend on the next cold-start migration.
		const patch: Partial<AppSettings> = { defaultModelId: pick };
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
		updateSettings(patch);
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
