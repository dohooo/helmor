import type {
	AgentLoginItem,
	AgentLoginStatus,
} from "@/components/agent-login/types";
import {
	ClaudeIcon,
	CursorIcon,
	KimiIcon,
	OpenAIIcon,
	OpenCodeIcon,
} from "@/components/icons";
import type { AgentLoginStatusResult } from "@/lib/api";
import { formatSource, translateSource } from "@/lib/i18n";

export function buildAgentLoginItems(
	status?: AgentLoginStatusResult | null,
): AgentLoginItem[] {
	// `undefined` = the first status check hasn't resolved yet (cold start) →
	// show "Connecting" instead of a premature "Log in". `null` = the check ran
	// but failed → fall through to the not-connected copy.
	const checking = status === undefined;
	const resolve = (ready: boolean | undefined): AgentLoginStatus =>
		checking ? "checking" : ready ? "ready" : "needsSetup";
	const CHECKING_COPY = translateSource("miscCheckingSignIn");
	return [
		{
			icon: OpenCodeIcon,
			provider: "opencode",
			label: "OpenCode",
			description: checking
				? CHECKING_COPY
				: status?.opencode
					? translateSource("miscOpencodeConnectedReady")
					: translateSource("miscOpencodeSignIn"),
			status: resolve(status?.opencode),
		},
		{
			icon: ClaudeIcon,
			provider: "claude",
			label: "Claude Code",
			description: checking
				? CHECKING_COPY
				: status?.claude
					? translateSource("miscClaudeSignedInReady")
					: translateSource("miscClaudeSignIn"),
			status: resolve(status?.claude),
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
			label: "Kimi",
			description: checking
				? CHECKING_COPY
				: status?.kimi
					? translateSource("miscKimiSignedInReady")
					: translateSource("miscKimiSignIn"),
			status: resolve(status?.kimi),
		},
		{
			icon: CursorIcon,
			provider: "cursor",
			label: "Cursor",
			description: checking
				? CHECKING_COPY
				: status?.cursor
					? translateSource("miscCursorApiKeySavedReady")
					: translateSource("miscCursorAddApiKey"),
			status: resolve(status?.cursor),
		},
	];
}

function codexDescription(status?: AgentLoginStatusResult | null): string {
	if (status?.codex && status.codexAuthMethod === "apiKey") {
		const provider =
			status.codexProvider ?? translateSource("miscConfiguredProvider");
		return formatSource("miscCodexUsingProvider", { provider });
	}
	if (status?.codex) {
		return translateSource("miscCodexSignedInReady");
	}
	return translateSource("miscCodexSignIn");
}
