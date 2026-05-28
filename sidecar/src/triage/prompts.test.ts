import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "./prompts";
import type { TriageCandidate } from "./types";

function makeCandidate(
	source: TriageCandidate["source"],
	overrides: Partial<TriageCandidate> = {},
): TriageCandidate {
	return {
		id: `${source}:1`,
		source,
		sourceKind: "test",
		sourceRef: "ref-1",
		sourceParent: null,
		sourceTime: "2026-05-26T10:00:00Z",
		sender: "alice",
		title: "Sample title",
		preview: null,
		externalUrl: null,
		payloadPath: `${source}/1.md`,
		payloadBytes: 100,
		...overrides,
	};
}

const FORGE_VOCAB =
	/\b(github|gitlab|pull request|forge-source|issue\s*\/\s*pr|PR\s*\/|externalUrl)\b/i;
const IM_VOCAB =
	/\b(lark|slack|im-source|sliding window|last_proposed_anchors|om_xxx|tail=N)\b/i;

const BASE_INPUT = {
	userPromptSuffix: "",
	maxPerTick: 5,
};

describe("buildSystemPrompt: source-family gating", () => {
	it("Lark-only batch contains no forge vocabulary", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("lark"), makeCandidate("lark")],
		});
		expect(prompt).toMatch(/<im-source/);
		expect(prompt).not.toMatch(/<forge-source/);
		expect(prompt).not.toMatch(FORGE_VOCAB);
	});

	it("Slack-only batch contains no forge vocabulary", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("slack")],
		});
		expect(prompt).toMatch(/<im-source/);
		expect(prompt).not.toMatch(/<forge-source/);
		expect(prompt).not.toMatch(FORGE_VOCAB);
	});

	it("GitHub-only batch contains no IM vocabulary", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("github")],
		});
		expect(prompt).toMatch(/<forge-source/);
		expect(prompt).not.toMatch(/<im-source/);
		expect(prompt).not.toMatch(IM_VOCAB);
	});

	it("GitLab-only batch contains no IM vocabulary", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("gitlab")],
		});
		expect(prompt).toMatch(/<forge-source/);
		expect(prompt).not.toMatch(/<im-source/);
		expect(prompt).not.toMatch(IM_VOCAB);
	});

	it("mixed batch loads both family blocks", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("lark"), makeCandidate("github")],
		});
		expect(prompt).toMatch(/<im-source[^>]*sources="lark"/);
		expect(prompt).toMatch(/<forge-source[^>]*sources="github"/);
	});

	it("multiple sources within a family get listed in the tag attribute", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [
				makeCandidate("lark"),
				makeCandidate("slack"),
				makeCandidate("github"),
				makeCandidate("gitlab"),
			],
		});
		expect(prompt).toMatch(/<im-source sources="lark,slack"/);
		expect(prompt).toMatch(/<forge-source sources="github,gitlab"/);
	});

	it("empty batch still emits the core sections without family blocks", () => {
		const prompt = buildSystemPrompt({ ...BASE_INPUT, candidates: [] });
		expect(prompt).toMatch(/<role>/);
		expect(prompt).toMatch(/<workflow>/);
		expect(prompt).toMatch(/<plan-format>/);
		expect(prompt).toMatch(/<critical>/);
		expect(prompt).not.toMatch(/<im-source/);
		expect(prompt).not.toMatch(/<forge-source/);
	});

	it("forge block tells the model to render a clickable markdown link", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("github")],
		});
		expect(prompt).toMatch(/clickable markdown link/i);
		expect(prompt).toMatch(/`link:` value verbatim/);
		// GitHub-only → no "MR" noun.
		expect(prompt).toMatch(/issue \/ PR/);
		expect(prompt).not.toMatch(/\bMR\b/);
	});

	it("gitlab-only block uses MR vocabulary, no PR noise", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("gitlab")],
		});
		expect(prompt).toMatch(/issue \/ MR/);
		expect(prompt).not.toMatch(/\bPR\b/);
	});

	it("lark-only IM block doesn't mention Slack's ts string", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("lark")],
		});
		expect(prompt).toMatch(/om_xxx/);
		expect(prompt).not.toMatch(/Slack/);
		expect(prompt).not.toMatch(/`ts` string/);
	});

	it("slack-only IM block doesn't mention Lark's om_xxx", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("slack")],
		});
		expect(prompt).toMatch(/`ts` string/);
		expect(prompt).not.toMatch(/om_xxx/);
		expect(prompt).not.toMatch(/Lark/);
	});

	it("im block keeps the last_proposed_anchors guidance", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("lark")],
		});
		expect(prompt).toMatch(/last_proposed_anchors/);
		expect(prompt).toMatch(/ALWAYS call `read_candidate`/);
	});

	it("always includes the skip-policy block", () => {
		// Core skip-policy must be present regardless of which sources are active.
		for (const src of ["lark", "slack", "github", "gitlab"] as const) {
			const prompt = buildSystemPrompt({
				...BASE_INPUT,
				candidates: [makeCandidate(src)],
			});
			expect(prompt).toMatch(/<skip-policy>/);
			expect(prompt).toMatch(/LAST\s+RESORT/);
			// Logic-driven, not pattern-driven: must articulate the
			// INTENT-vs-COMPLETION distinction without listing phrases to match.
			expect(prompt).toMatch(/Intent|INTENT/);
			expect(prompt).toMatch(/completion|COMPLETION|shipped/);
			// And must explicitly call out the cap escape hatch so the
			// model doesn't read the cap rule as contradicting skip-policy.
			expect(prompt).toMatch(/CAP\s+REACHED/);
		}
	});

	it("skip-policy does not pin to specific surface phrasings", () => {
		// Guardrail: if someone re-adds literal phrase lists ("我改改", "I'll fix it",
		// "认领", etc.) the policy turns into brittle keyword matching. The test
		// flags that regression — keep guidance abstract.
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("slack")],
		});
		const policy = prompt.match(/<skip-policy>[\s\S]*?<\/skip-policy>/)?.[0];
		expect(policy).toBeDefined();
		expect(policy).not.toMatch(/我改改|我看看|我来|认领/);
		expect(policy).not.toMatch(/I'?ll fix|I'?ll take|@me/i);
	});

	it("appends user-additions suffix when present", () => {
		const prompt = buildSystemPrompt({
			...BASE_INPUT,
			candidates: [makeCandidate("lark")],
			userPromptSuffix: "Focus on DMs from my team lead.",
		});
		expect(prompt).toMatch(
			/<user-additions>\nFocus on DMs from my team lead\.\n<\/user-additions>/,
		);
	});
});
