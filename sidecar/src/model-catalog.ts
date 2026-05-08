import type { ProviderModelInfo } from "./session-manager.js";

const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

const MODEL_CATALOG: Record<"claude" | "codex", readonly ProviderModelInfo[]> =
	{
		claude: [
			{
				id: "default",
				label: "Opus 4.7 1M",
				cliModel: "default",
				effortLevels: ["low", "medium", "high", "xhigh", "max"],
			},
			{
				id: "claude-opus-4-6[1m]",
				label: "Opus 4.6 1M",
				cliModel: "claude-opus-4-6[1m]",
				effortLevels: ["low", "medium", "high", "max"],
				supportsFastMode: true,
			},
			{
				id: "sonnet",
				label: "Sonnet",
				cliModel: "sonnet",
				effortLevels: ["low", "medium", "high", "max"],
			},
			{
				id: "haiku",
				label: "Haiku",
				cliModel: "haiku",
				effortLevels: [],
			},
		],
		codex: [
			{
				id: "gpt-5.5",
				label: "GPT-5.5",
				cliModel: "gpt-5.5",
				effortLevels: CODEX_EFFORT_LEVELS,
				supportsFastMode: true,
			},
			{
				id: "gpt-5.4",
				label: "GPT-5.4",
				cliModel: "gpt-5.4",
				effortLevels: CODEX_EFFORT_LEVELS,
				supportsFastMode: true,
			},
			{
				id: "gpt-5.4-mini",
				label: "GPT-5.4-Mini",
				cliModel: "gpt-5.4-mini",
				effortLevels: CODEX_EFFORT_LEVELS,
				supportsFastMode: true,
			},
			{
				id: "gpt-5.3-codex",
				label: "GPT-5.3-Codex",
				cliModel: "gpt-5.3-codex",
				effortLevels: CODEX_EFFORT_LEVELS,
				supportsFastMode: true,
			},
			{
				id: "gpt-5.3-codex-spark",
				label: "GPT-5.3-Codex-Spark",
				cliModel: "gpt-5.3-codex-spark",
				effortLevels: CODEX_EFFORT_LEVELS,
				supportsFastMode: true,
			},
			{
				id: "gpt-5.2",
				label: "GPT-5.2",
				cliModel: "gpt-5.2",
				effortLevels: CODEX_EFFORT_LEVELS,
				supportsFastMode: true,
			},
		],
	};

export function listProviderModels(
	provider: "claude" | "codex",
): ProviderModelInfo[] {
	return MODEL_CATALOG[provider].map((model) => ({ ...model }));
}

export function modelSupportsFastMode(
	provider: "claude" | "codex",
	modelId: string | undefined | null,
): boolean {
	if (!modelId) return false;
	return MODEL_CATALOG[provider].some(
		(model) => model.id === modelId && model.supportsFastMode === true,
	);
}

// Heuristic for lightweight background tasks (e.g. title generation):
// pick the lowest version number in the catalog; when versions tie,
// prefer a `-mini` variant. Older/smaller variants are usually fast and
// cheap enough for a one-shot title prompt.
export function pickFastestCodexModel(): string {
	let best: { cliModel: string; version: number; isMini: boolean } | undefined;
	for (const m of MODEL_CATALOG.codex) {
		const match = m.id.match(/(\d+(?:\.\d+)?)/);
		const version = match?.[1]
			? Number.parseFloat(match[1])
			: Number.POSITIVE_INFINITY;
		const isMini = m.id.includes("mini");
		if (
			!best ||
			version < best.version ||
			(version === best.version && isMini && !best.isMini)
		) {
			best = { cliModel: m.cliModel, version, isMini };
		}
	}
	return best?.cliModel ?? "gpt-5.2";
}
