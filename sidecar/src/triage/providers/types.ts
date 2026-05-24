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
