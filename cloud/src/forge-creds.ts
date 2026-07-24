// Per-member forge credentials: collection from the ForgeIdentity DOs and
// injection into the running container.
//
// Extracted from index.ts (round6 P1-4a) so BOTH injection sites share one
// implementation without an import cycle:
//   - cold start (`ensureServe` in index.ts) — the original site;
//   - live re-inject on `PUT /team/forge-identity` (team.ts) — the P1-4a fix.
//     Before it, `injectForgeMembers` ran ONLY at cold start, so a forge
//     (re-)authorization left a running container's members file stale until
//     a manual destroy (live-reproduced in the class2 rollout: private-repo
//     clone failed with `could not read Username`).

import { withTimeout } from "./container-net";
import type { Env } from "./index";
import { TEAM_ID } from "./team-gateway/core";

/** Where the per-member forge creds file is written in the container. OUTSIDE
 *  the backed-up `/home` tree so plaintext tokens never enter an R2 backup and a
 *  restore can't shadow a fresh injection. Matches the in-container loader's
 *  `HELMOR_FORGE_MEMBERS_PATH`. */
export const FORGE_MEMBERS_PATH = "/tmp/helmor-forge-members.json";

export const FORGE_INJECT_TIMEOUT_MS = 15_000;

/** Per-member entry in the injected forge-creds file. Non-creator entries
 *  carry ONLY the (non-secret) login — for per-member commit authorship —
 *  never a token. */
export type ForgeMemberEntry = {
	githubToken?: string;
	glabConfigYml?: string;
	login?: string;
	/** Marks the team's forge creator (the only entry carrying tokens); the
	 *  in-container loader falls back to this entry's tokens for every acting
	 *  member (creator-identity model, round6 P1-2a). */
	creator?: boolean;
};

/** The one container capability injection needs — structural so tests can pass
 *  a plain spy instead of a real Sandbox DO stub. */
export type ForgeInjectableSandbox = {
	writeFile(path: string, content: string): Promise<unknown>;
};

/** Read the team's bound forge-creator member id (round6 P1-2a), or null when
 *  no member has authorized forge yet. Lives here (not team.ts) because BOTH
 *  the injection paths and the registry routes need it — and team.ts imports
 *  this module for the live re-inject, so the reverse import would cycle. */
export async function readForgeIdentityMemberId(
	env: Env,
): Promise<string | null> {
	const row = await env.DB.prepare(
		"SELECT forge_identity_member_id FROM teams WHERE id = ?1",
	)
		.bind(TEAM_ID)
		.first<{ forge_identity_member_id: string | null }>();
	return row?.forge_identity_member_id ?? null;
}

/** Collect the forge creds to inject, keyed by member id (round6 P1-2a).
 *  ONLY the team's forge creator (`teams.forge_identity_member_id`,
 *  first-authorizer-wins) gets their DO minted for tokens — every other
 *  member contributes just their login (commit authorship), so a container
 *  compromise leaks at most ONE member's forge tokens instead of the whole
 *  team's. No creator bound yet → no tokens at all (same as before anyone
 *  authorized). */
export async function collectMemberForgeCreds(
	env: Env,
): Promise<Record<string, ForgeMemberEntry>> {
	const { results } = await env.DB.prepare(
		"SELECT id, github_login FROM members",
	).all<{ id: string; github_login: string | null }>();
	const creatorId = await readForgeIdentityMemberId(env).catch(() => null);
	const out: Record<string, ForgeMemberEntry> = {};
	for (const row of results ?? []) {
		const entry: ForgeMemberEntry = { login: row.github_login ?? undefined };
		if (row.id === creatorId) {
			try {
				const stub = env.FORGE_IDENTITY.get(
					env.FORGE_IDENTITY.idFromName(row.id),
				);
				const minted = await stub.mint();
				if (
					minted &&
					!("error" in minted) &&
					(minted.githubToken || minted.glabConfigYml)
				) {
					entry.githubToken = minted.githubToken;
					entry.glabConfigYml = minted.glabConfigYml;
					entry.creator = true;
				}
			} catch {
				// Creator DO read failed → inject login-only; forge ops degrade to
				// unauthenticated until the next (re-)inject, never to another
				// member's token.
			}
		}
		if (entry.login || entry.creator) out[row.id] = entry;
	}
	return out;
}

/** Write the collected per-member forge creds into the running container at
 *  {@link FORGE_MEMBERS_PATH}. The in-container `member_creds` loader
 *  hot-reloads it via mtime (src-tauri/src/forge/member_creds.rs), so this
 *  doubles as the live re-inject on re-authorize — no restart needed. */
export async function injectForgeMembers(
	sandbox: ForgeInjectableSandbox,
	env: Env,
): Promise<void> {
	const creds = await collectMemberForgeCreds(env);
	await sandbox.writeFile(FORGE_MEMBERS_PATH, JSON.stringify(creds));
}

/** Live re-inject for `PUT /team/forge-identity` (round6 P1-4a): when the
 *  container is currently SERVING, rewrite the members file so the fresh
 *  credential takes effect immediately (mtime hot-reload — no restart, unlike
 *  the cloud-identity reauth path, whose tokens are startProcess env and DO
 *  need a real restart).
 *
 *  `probe` is the non-waking liveness check (`healthOk`), injected for
 *  testability. Not serving → skip ENTIRELY: the next cold start injects
 *  anyway, and touching an asleep sandbox would just spin up a serve-less VM.
 *  Best-effort: a probe/write failure is logged and swallowed — the identity
 *  is already persisted in its DO, so the cold-start path remains the
 *  backstop. */
export async function reinjectForgeMembersIfServing(
	sandbox: ForgeInjectableSandbox,
	env: Env,
	probe: () => Promise<boolean>,
): Promise<void> {
	try {
		if (!(await probe())) return;
		await withTimeout(
			injectForgeMembers(sandbox, env),
			FORGE_INJECT_TIMEOUT_MS,
			"forge members re-inject",
		);
	} catch (error) {
		console.error(
			"forge members re-inject failed",
			error instanceof Error ? error.message : "unknown",
		);
	}
}
