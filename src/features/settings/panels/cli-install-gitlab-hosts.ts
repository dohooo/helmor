import type { RepositoryCreateOption } from "@/lib/api";

export function parseRemoteHost(remoteUrl?: string | null): string | null {
	const value = remoteUrl?.trim();
	if (!value) return null;
	const scpLike = value.match(/^[^@]+@([^:]+):/);
	if (scpLike?.[1]) return scpLike[1].toLowerCase();
	try {
		return new URL(value).hostname.toLowerCase() || null;
	} catch {
		return null;
	}
}

export function gitlabHostsForRepositories(
	repositories: RepositoryCreateOption[],
): string[] {
	const hosts = new Set<string>();
	for (const repo of repositories) {
		const host = parseRemoteHost(repo.remoteUrl);
		if (host && (repo.forgeProvider === "gitlab" || host.includes("gitlab"))) {
			hosts.add(host);
		}
	}
	return [...hosts].sort();
}
