import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/// Detect the synthetic `## Context Usage` assistant message the SDK emits
/// after `/compact` — redundant once `compact_boundary` confirms the compact.
function isCompactContextUsageMessage(message: SDKMessage): boolean {
	if (message.type !== "assistant") {
		return false;
	}
	const payload = (
		message as { message?: { model?: string; content?: unknown } }
	).message;
	if (payload?.model !== "<synthetic>") {
		return false;
	}
	const content = payload.content;
	if (!Array.isArray(content) || content.length === 0) {
		return false;
	}
	const first = content[0] as { type?: string; text?: string };
	return (
		first.type === "text" &&
		typeof first.text === "string" &&
		first.text.startsWith("## Context Usage")
	);
}

/// Only drop the table for `/compact` — `/context` produces it on purpose.
export function shouldSuppressCompactContextUsageMessage(
	message: SDKMessage,
	rootSlashCommand: string | null,
): boolean {
	return (
		rootSlashCommand === "/compact" && isCompactContextUsageMessage(message)
	);
}
