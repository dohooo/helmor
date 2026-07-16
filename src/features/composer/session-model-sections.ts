import type {
	AgentModelOption,
	AgentModelSection,
	WorkspaceSessionSummary,
} from "@/lib/api";

const HIDDEN_MODELS: Record<string, AgentModelOption> = {
	"claude-opus-4-7[1m]": {
		id: "claude-opus-4-7[1m]",
		provider: "claude",
		label: "Opus 4.7 1M",
		cliModel: "claude-opus-4-7[1m]",
		effortLevels: ["low", "medium", "high", "xhigh", "max"],
		supportsContextUsage: true,
	},
	"claude-opus-4-6[1m]": {
		id: "claude-opus-4-6[1m]",
		provider: "claude",
		label: "Opus 4.6 1M",
		cliModel: "claude-opus-4-6[1m]",
		effortLevels: ["low", "medium", "high", "max"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
	"gpt-5.5": {
		id: "gpt-5.5",
		provider: "codex",
		label: "GPT-5.5",
		cliModel: "gpt-5.5",
		effortLevels: ["low", "medium", "high", "xhigh"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
	"gpt-5.4": {
		id: "gpt-5.4",
		provider: "codex",
		label: "GPT-5.4",
		cliModel: "gpt-5.4",
		effortLevels: ["low", "medium", "high", "xhigh"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
	"gpt-5.4-mini": {
		id: "gpt-5.4-mini",
		provider: "codex",
		label: "GPT-5.4 Mini",
		cliModel: "gpt-5.4-mini",
		effortLevels: ["low", "medium", "high", "xhigh"],
		supportsFastMode: true,
		supportsContextUsage: true,
	},
};

export function includePinnedHiddenModel(
	sections: AgentModelSection[],
	session: Pick<WorkspaceSessionSummary, "agentType" | "model"> | null,
): AgentModelSection[] {
	if (!session?.agentType || !session.model) return sections;
	const hiddenModel = HIDDEN_MODELS[session.model];
	if (!hiddenModel || hiddenModel.provider !== session.agentType)
		return sections;
	if (
		sections.some((section) =>
			section.options.some((o) => o.id === session.model),
		)
	) {
		return sections;
	}

	const sectionIndex = sections.findIndex(
		(section) => section.id === hiddenModel.provider,
	);
	if (sectionIndex === -1) {
		return [
			...sections,
			{
				id: hiddenModel.provider,
				label: hiddenModel.provider === "codex" ? "Codex" : "Claude Code",
				status: "ready",
				options: [hiddenModel],
			},
		];
	}

	return sections.map((section, index) =>
		index === sectionIndex
			? { ...section, options: [...section.options, hiddenModel] }
			: section,
	);
}
