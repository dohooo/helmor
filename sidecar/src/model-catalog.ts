import type { Provider, ProviderModelInfo } from "./session-manager.js";

const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const CURSOR_REASONING_LEVELS = ["low", "medium", "high"] as const;

// NOTE: the Claude/Codex sections here MUST stay in sync with the Rust
// catalog in `src-tauri/src/agents/catalog.rs` (`official_claude_section` /
// `codex_section`) — that Rust list is what drives the model picker via the
// `list_agent_model_sections` command; this one feeds `listModels`.
const MODEL_CATALOG: Record<Provider, readonly ProviderModelInfo[]> = {
	claude: [
		// Fable 5 leads the list as the most capable pick, but it burns limits
		// ~2x faster than Opus — `useEnsureDefaultModel` pins the app default
		// to the `default` (Opus) entry below, NOT to the first entry. No fast
		// mode (Opus 4.6+ only).
		{
			id: "claude-fable-5[1m]",
			label: "Fable 5 1M",
			cliModel: "claude-fable-5[1m]",
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
		},
		// `default` resolves to the newest Opus the bundled claude-code knows
		// about — in 2.1.170 that is Opus 4.8 (1M context, adaptive thinking,
		// default high effort, fast mode at 2x rate / 2.5x speed). Kept as
		// `default` (rather than pinned `claude-opus-4-8`) so it stays the
		// auto-latest pick AND remains the app default selection (see
		// `useEnsureDefaultModel`, which prefers id == "default").
		{
			id: "default",
			label: "Opus 4.8 1M",
			cliModel: "default",
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
			supportsFastMode: true,
		},
		// Explicit 4.7 pin — previously this slot WAS `default`; now that
		// `default` advanced to 4.8 we surface 4.7 as its own entry so users
		// can still select it.
		{
			id: "claude-opus-4-7[1m]",
			label: "Opus 4.7 1M",
			cliModel: "claude-opus-4-7[1m]",
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
	],
	// Static seed; live set comes from `OpencodeSessionManager.listModels`.
	// MUST stay in sync with Rust `opencode_section()` in agents/catalog.rs.
	// Ids are opencode's `provider/model` slug.
	opencode: [
		{
			id: "anthropic/claude-opus-4-5",
			label: "Claude Opus 4.5",
			cliModel: "anthropic/claude-opus-4-5",
		},
		{
			id: "anthropic/claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
			cliModel: "anthropic/claude-sonnet-4-6",
		},
		{
			id: "anthropic/claude-haiku-4-5",
			label: "Claude Haiku 4.5",
			cliModel: "anthropic/claude-haiku-4-5",
		},
		{
			id: "openai/gpt-5.2",
			label: "GPT-5.2",
			cliModel: "openai/gpt-5.2",
		},
		{
			id: "openai/gpt-5-codex",
			label: "GPT-5-Codex",
			cliModel: "openai/gpt-5-codex",
		},
	],
	// Static fallback only — `CursorSessionManager.listModels` hits the live
	// `Cursor.models.list` API for the full set with up-to-date capability
	// metadata. This list is what shows when the API key isn't configured
	// yet (so the picker still shows reasonable defaults).
	cursor: [
		{
			id: "composer-2",
			label: "Composer 2",
			cliModel: "composer-2",
			supportsFastMode: true,
		},
		{
			id: "gpt-5.3-codex",
			label: "Codex 5.3",
			cliModel: "gpt-5.3-codex",
			effortLevels: CURSOR_REASONING_LEVELS,
		},
		{
			id: "claude-sonnet-4-5",
			label: "Sonnet 4.5",
			cliModel: "claude-sonnet-4-5",
			effortLevels: CURSOR_REASONING_LEVELS,
		},
	],
};

export function listProviderModels(provider: Provider): ProviderModelInfo[] {
	return MODEL_CATALOG[provider].map((model) => ({ ...model }));
}

export function modelSupportsFastMode(
	provider: Provider,
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
	return best?.cliModel ?? "gpt-5.4-mini";
}
