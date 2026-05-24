// Provider abstraction. Each integration (lark/gitlab/github/...) implements
// this. Adding a provider = drop a file + register it.

import type { ScratchSession } from "../scratch";

export interface ProviderContext {
	readonly scratch: ScratchSession;
	/** ISO 8601 timestamp the last successful tick advanced to. null on first run. */
	readonly lastTriagedAt: string | null;
}

export interface PreflightResult {
	readonly ok: boolean;
	readonly reason?: string;
}

// Loosely typed tool — concrete shape comes from pi-ai/pi-agent-core.
// Each provider returns these and the agent loop uses them as-is.
export type AgentTool = unknown;

export interface TriageProvider {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	preflight?(): Promise<PreflightResult>;
	buildTools(ctx: ProviderContext): readonly AgentTool[];
	promptHint(ctx: ProviderContext): string | null;
}
