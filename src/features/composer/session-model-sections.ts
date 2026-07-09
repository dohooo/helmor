import type {
	AgentModelOption,
	AgentModelSection,
	WorkspaceSessionSummary,
} from "@/lib/api";

const LEGACY_CODEX_MODELS: Record<string, AgentModelOption> = {
	"gpt-5.5": {
		id: "gpt-5.5",
		provider: "codex",
		label: "GPT-5.5",
		cliModel: "gpt-5.5",
		effortLevels: ["none", "low", "medium", "high", "xhigh"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		provider: "codex",
		label: "GPT-5.4",
		cliModel: "gpt-5.4",
		effortLevels: ["none", "low", "medium", "high", "xhigh"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		provider: "codex",
		label: "GPT-5.4 Mini",
		cliModel: "gpt-5.4-mini",
		effortLevels: ["none", "low", "medium", "high", "xhigh"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
};

export function includePinnedLegacyCodexModel(
	sections: AgentModelSection[],
	session: Pick<WorkspaceSessionSummary, "agentType" | "model"> | null,
): AgentModelSection[] {
	if (session?.agentType !== "codex" || !session.model) return sections;
	const legacyModel = LEGACY_CODEX_MODELS[session.model];
	if (!legacyModel) return sections;
	if (
		sections.some((section) =>
			section.options.some((o) => o.id === session.model),
		)
	) {
		return sections;
	}

	const codexIndex = sections.findIndex((section) => section.id === "codex");
	if (codexIndex === -1) {
		return [
			...sections,
			{ id: "codex", label: "Codex", status: "ready", options: [legacyModel] },
		];
	}

	return sections.map((section, index) =>
		index === codexIndex
			? { ...section, options: [...section.options, legacyModel] }
			: section,
	);
}
