/**
 * Tracks Codex sub-agent threads spawned during a session.
 *
 * The Codex App Server multiplexes parent + sub-agent events on the same
 * stdio stream, distinguished by `params.threadId`. Sub-agent threads are
 * created when the parent calls the `spawn_agent` tool — surfaced as a
 * `collabAgentToolCall(spawnAgent)` item — and their `agentNickname` /
 * `agentRole` are *not* delivered in any notification. We have to fetch
 * them explicitly with `thread/read` and cache them per session.
 *
 * This tracker is intentionally per-session (one instance per
 * `AppServerContext`) so a tracker's lifetime matches the underlying
 * `codex app-server` child process.
 */

import type { CodexAppServer } from "./codex-app-server.js";
import { errorDetails, logger } from "./logger.js";

export interface SubAgentMeta {
	threadId: string;
	parentThreadId: string | null;
	agentNickname: string | null;
	agentRole: string | null;
}

const META_FETCH_TIMEOUT_MS = 2_000;

export class SubAgentTracker {
	private metas = new Map<string, SubAgentMeta>();
	private inflight = new Map<string, Promise<SubAgentMeta>>();

	constructor(private readonly server: CodexAppServer) {}

	/** True iff the threadId belongs to a sub-agent we already know about. */
	knows(threadId: string): boolean {
		return this.metas.has(threadId);
	}

	/** Synchronously read cached meta. Undefined if not yet resolved. */
	get(threadId: string): SubAgentMeta | undefined {
		return this.metas.get(threadId);
	}

	/** All known sub-agent thread ids. */
	allThreadIds(): string[] {
		return Array.from(this.metas.keys());
	}

	/**
	 * Note that the parent just spawned a sub-agent. Kicks off a `thread/read`
	 * to populate metadata, with a hard timeout so we never block the stream
	 * indefinitely. Returns the resolved meta — including a placeholder if the
	 * lookup fails or times out, so callers always have *something* to attach.
	 */
	async noteSpawned(threadId: string): Promise<SubAgentMeta> {
		const cached = this.metas.get(threadId);
		if (cached) return cached;

		const existing = this.inflight.get(threadId);
		if (existing) return existing;

		const p = this.fetchMeta(threadId).then(
			(meta) => {
				this.metas.set(threadId, meta);
				this.inflight.delete(threadId);
				return meta;
			},
			(err) => {
				this.inflight.delete(threadId);
				const fallback: SubAgentMeta = {
					threadId,
					parentThreadId: null,
					agentNickname: null,
					agentRole: null,
				};
				logger.debug("subagent meta fetch failed; using placeholder", {
					threadId,
					...errorDetails(err),
				});
				this.metas.set(threadId, fallback);
				return fallback;
			},
		);
		this.inflight.set(threadId, p);
		return p;
	}

	private async fetchMeta(threadId: string): Promise<SubAgentMeta> {
		const result = (await this.server.sendRequest(
			"thread/read",
			{ threadId, includeTurns: false },
			META_FETCH_TIMEOUT_MS,
		)) as Record<string, unknown> | null;

		const thread = (result?.thread ?? {}) as Record<string, unknown>;
		const nickname = thread.agentNickname;
		const role = thread.agentRole;
		const parentId = extractParentThreadId(thread);

		return {
			threadId,
			parentThreadId: typeof parentId === "string" ? parentId : null,
			agentNickname: typeof nickname === "string" ? nickname : null,
			agentRole: typeof role === "string" ? role : null,
		};
	}
}

/**
 * Codex's `thread.source` for a sub-agent looks like:
 *   { subAgent: { thread_spawn: { parent_thread_id, agent_nickname, agent_role, depth, ... } } }
 * We only need parent_thread_id here — nickname/role are duplicated at the
 * top level of `thread`.
 */
function extractParentThreadId(thread: Record<string, unknown>): string | null {
	const src = thread.source;
	if (!src || typeof src !== "object") return null;
	const subAgent = (src as Record<string, unknown>).subAgent;
	if (!subAgent || typeof subAgent !== "object") return null;
	for (const variant of Object.values(subAgent as Record<string, unknown>)) {
		if (variant && typeof variant === "object") {
			const parent = (variant as Record<string, unknown>).parent_thread_id;
			if (typeof parent === "string") return parent;
		}
	}
	return null;
}
