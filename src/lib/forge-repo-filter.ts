// Forge-aware "owner/name" or "namespace/project" filter parser.
//
// Backend inbox queries scope to a single repo via a provider-specific
// search qualifier — `repo:owner/name` for GitHub, project full path for
// GitLab. The frontend computes the filter string from a repo's stored
// remote URL + forge provider so the kanban repo picker drives the inbox
// to the right slice.

import type { ForgeProvider, RepositoryCreateOption } from "./api";

const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com"]);

export type ForgeRepoLocator = {
	/** Hostname from the repo's remote URL (e.g. `github.com`,
	 *  `gitlab.com`, `gitlab.example.com`). The backend uses this to
	 *  pick the right CLI host — for self-hosted GitLab this is *not*
	 *  the same as the login's home host. */
	host: string;
	/** Repository "full path" — `owner/name` for GitHub, `group/sub/project`
	 *  for GitLab. Trailing `.git` and slashes stripped. */
	path: string;
};

/** Parse a repository's remote URL into a `(host, path)` pair, gated by
 *  the declared forge provider. Returns null when the URL doesn't parse
 *  or the host shape doesn't match the provider. */
export function parseForgeRepoLocator(
	repository: RepositoryCreateOption | null,
): ForgeRepoLocator | null {
	if (!repository) return null;
	const provider: ForgeProvider = repository.forgeProvider ?? "unknown";
	const trimmed = (repository.remoteUrl ?? repository.remote ?? "").trim();
	if (!trimmed) return null;
	const parsed = parseRemote(trimmed);
	if (!parsed) return null;

	// Provider-aware host check. "unknown" defaults to GitHub for legacy
	// rows whose forge_provider column might still be NULL.
	const host = parsed.host.toLowerCase();
	if (provider === "github" || provider === "unknown") {
		if (!GITHUB_HOSTS.has(host)) return null;
	} else if (provider === "gitlab") {
		// Reject GitHub hosts when provider says GitLab (data drift);
		// otherwise accept anything (gitlab.com / self-hosted / pattern).
		if (GITHUB_HOSTS.has(host)) return null;
	}

	return { host: parsed.host, path: parsed.path };
}

/** Repo path only — convenience over `parseForgeRepoLocator` for places
 *  that only need the `owner/name` qualifier. */
export function parseForgeRepoFilter(
	repository: RepositoryCreateOption | null,
): string | null {
	return parseForgeRepoLocator(repository)?.path ?? null;
}

/** Repo host only — convenience over `parseForgeRepoLocator`. Used by
 *  the inbox to route the API call to the right GitLab instance
 *  (self-hosted vs gitlab.com), independent of where the bound login
 *  happens to live. */
export function parseForgeRepoHost(
	repository: RepositoryCreateOption | null,
): string | null {
	return parseForgeRepoLocator(repository)?.host ?? null;
}

type ParsedRemote = {
	host: string;
	path: string;
};

function parseRemote(url: string): ParsedRemote | null {
	// SSH: git@host:namespace/project(.git)
	const sshMatch = url.match(/^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?\/?$/i);
	if (sshMatch) {
		const path = stripGitSuffix(sshMatch[2]);
		if (!path.includes("/")) return null;
		return { host: sshMatch[1], path };
	}
	// HTTPS / git:// / ssh://
	const protoMatch = url.match(
		/^(?:https?|git|ssh):\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+?)(?:\.git)?\/?$/i,
	);
	if (protoMatch) {
		const path = stripGitSuffix(protoMatch[2]);
		if (!path.includes("/")) return null;
		return { host: protoMatch[1], path };
	}
	return null;
}

function stripGitSuffix(value: string): string {
	return value.replace(/\.git\/?$/i, "").replace(/\/+$/g, "");
}
