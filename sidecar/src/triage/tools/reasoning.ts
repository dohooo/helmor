// Reasoning aid for the local triage judge.
//
// `think` is a no-op scratchpad — the model writes structured reasoning
// and the tool returns a fixed "noted". Small models (7-9B Qwen) make
// noticeably more stable multi-step decisions when given an explicit
// thinking step before they commit to a tool call.

import { Type } from "@earendil-works/pi-ai";

export function buildThinkTool() {
	return {
		name: "think",
		label: "Think",
		description:
			"Lay out your reasoning BEFORE calling propose_workspace or mark_not_actionable. The text is NOT shown to the user — it's a private scratchpad for you to commit to a structured decision. Use it for: (1) summarising what you found in a chat candidate before deciding, (2) listing the independent tasks you've identified, (3) checking whether a candidate's anchor already appears in `last_proposed_anchors`. Calling `think` has no side effect; it just returns `noted`. Free to call multiple times per candidate.",
		parameters: Type.Object({
			thought: Type.String({
				description:
					"Your structured reasoning. Keep it tight (≤ ~300 words). Use the user's language.",
			}),
		}),
		execute: async (_id: string, params: { thought: string }) => ({
			content: [{ type: "text" as const, text: "noted" }],
			details: { length: params.thought.length },
		}),
	};
}
