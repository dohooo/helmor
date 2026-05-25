// Provider abstraction for triage integrations.

import type { ScratchSession } from "../scratch";

export interface ProviderContext {
	readonly scratch: ScratchSession;
	readonly lastTriagedAt: string;
}

export interface PreflightResult {
	readonly ok: boolean;
	readonly reason?: string;
}

// Loosely typed tool — concrete shape comes from pi-ai/pi-agent-core.
export type AgentTool = unknown;

export interface TriageProvider {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	preflight?(): Promise<PreflightResult>;
	buildTools(ctx: ProviderContext): readonly AgentTool[];
	promptHint(ctx: ProviderContext): string | null;
}

// Tool-result content for *_save_image / *_save_attachment: status line
// plus an inline `image` block when the Rust handler returned base64.
// Files over the 5 MB inline cap still land in workspace staging for the
// downstream cloud agent — local LLM just doesn't see them as vision.
type AttachmentContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export function buildAttachmentContent(
	text: string,
	dataBase64?: string,
	mimeType?: string,
): AttachmentContentBlock[] {
	const blocks: AttachmentContentBlock[] = [{ type: "text", text }];
	if (dataBase64 && mimeType) {
		blocks.push({ type: "image", data: dataBase64, mimeType });
	}
	return blocks;
}
