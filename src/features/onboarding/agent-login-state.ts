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
			description: codexDescription(status),
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

function codexDescription(status?: AgentLoginStatusResult | null): string {
	if (status?.codex && status.codexAuthMethod === "apiKey") {
		const provider = status.codexProvider ?? "configured provider";
		return `Using ${provider} from Codex config with its API key environment variable.`;
	}
	if (status?.codex) {
		return "Signed in and ready to run OpenAI models in Helmor.";
	}
	return "Sign in to Codex or configure a Codex API-key provider to use Codex models in Helmor.";
}
