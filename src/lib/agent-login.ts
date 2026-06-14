import type {
	AgentLoginItem,
	AgentLoginStatus,
} from "@/components/agent-login/types";
import {
	ClaudeIcon,
	CursorIcon,
	KimiIcon,
	MiMoCodeIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import type { AgentLoginStatusResult } from "@/lib/api";

export function buildAgentLoginItems(
	status?: AgentLoginStatusResult | null,
): AgentLoginItem[] {
	// `undefined` = the first status check hasn't resolved yet (cold start) →
	// show "Connecting" instead of a premature "Log in". `null` = the check ran
	// but failed → fall through to the not-connected copy.
	const checking = status === undefined;
	const resolve = (ready: boolean | undefined): AgentLoginStatus =>
		checking ? "checking" : ready ? "ready" : "needsSetup";
	const CHECKING_COPY = "Checking sign-in…";
	return [
		{
			icon: ClaudeIcon,
			provider: "claude",
			label: "Claude Code",
			description: checking
				? CHECKING_COPY
				: status?.claude
					? "Signed in and ready to run in local workspaces."
					: "Sign in to Claude Code to use Anthropic models in Helmor.",
			status: resolve(status?.claude),
		},
		{
			icon: OpenCodeIcon,
			provider: "opencode",
			label: "OpenCode",
			description: checking
				? CHECKING_COPY
				: status?.opencode
					? "Connected and ready to run OpenCode models in Helmor."
					: "Sign in with `opencode auth login` to use OpenCode models in Helmor.",
			status: resolve(status?.opencode),
		},
		{
			icon: MiMoCodeIcon,
			provider: "mimo",
			label: "MiMo Code",
			description: checking
				? CHECKING_COPY
				: status?.mimo
					? "Connected and ready to run MiMo Code models in Helmor."
					: "Sign in with `mimo auth login` to use MiMo Code models in Helmor.",
			status: resolve(status?.mimo),
		},
		{
			icon: OpenAIIcon,
			provider: "codex",
			label: "Codex",
			description: checking ? CHECKING_COPY : codexDescription(status),
			status: resolve(status?.codex),
		},
		{
			icon: KimiIcon,
			provider: "kimi",
			label: "Kimi Code",
			description: checking
				? CHECKING_COPY
				: status?.kimi
					? "Signed in and ready to run Kimi models in Helmor."
					: "Sign in with `kimi login` to use Kimi models in Helmor.",
			status: resolve(status?.kimi),
		},
		{
			icon: CursorIcon,
			provider: "cursor",
			label: "Cursor",
			description: checking
				? CHECKING_COPY
				: status?.cursor
					? "API key saved and ready to run Cursor models in Helmor."
					: "Add a Cursor API key to use Cursor models in Helmor.",
			status: resolve(status?.cursor),
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
