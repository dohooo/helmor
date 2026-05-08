import { ClaudeIcon, CursorIcon, OpenAIIcon } from "@/components/icons";
import type { AgentLoginStatusResult } from "@/lib/api";
import type { AgentLoginItem } from "./types";

export function buildAgentLoginItems(
	status?: AgentLoginStatusResult | null,
): AgentLoginItem[] {
	return [
		{
			icon: ClaudeIcon,
			provider: "claude",
			label: "Claude Code",
			description: status?.claude
				? "Signed in and ready to run in local workspaces."
				: "Sign in to Claude Code to use Anthropic models in Helmor.",
			status: status?.claude ? "ready" : "needsSetup",
		},
		{
			icon: OpenAIIcon,
			provider: "codex",
			label: "Codex",
			description: status?.codex
				? "Signed in and ready to run OpenAI models in Helmor."
				: "Sign in to Codex to use OpenAI models in Helmor.",
			status: status?.codex ? "ready" : "needsSetup",
		},
		{
			icon: CursorIcon,
			provider: "cursor",
			label: "Cursor",
			description: status?.cursor
				? "API key saved and ready to run Cursor models in Helmor."
				: "Add a Cursor API key to use Cursor models in Helmor.",
			status: status?.cursor ? "ready" : "needsSetup",
		},
	];
}
