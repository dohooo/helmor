type ParsedRemote = {
	host: string;
	namespace: string;
	repo: string;
};

function parseRemote(remote: string): ParsedRemote | null {
	const trimmed = remote.trim();
	if (!trimmed) return null;

	let host: string;
	let path: string;

	const sshMatch = trimmed.match(/^(?:git@)?([^/:@]+):(.+)$/);
	if (sshMatch && !trimmed.includes("://")) {
		host = sshMatch[1];
		path = sshMatch[2];
	} else {
		const schemeMatch = trimmed.match(
			/^[a-z]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i,
		);
		if (!schemeMatch) return null;
		host = schemeMatch[1];
		path = schemeMatch[2];
	}

	const cleaned = path.replace(/\/+$/, "").replace(/\.git$/i, "");
	const lastSlash = cleaned.lastIndexOf("/");
	if (lastSlash <= 0) return null;
	const namespace = cleaned.slice(0, lastSlash);
	const repo = cleaned.slice(lastSlash + 1);
	if (!namespace || !repo) return null;

	return { host: host.toLowerCase(), namespace, repo };
}

function encodePath(path: string): string {
	return path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

export function buildRemoteFileUrl(
	remoteUrl: string | null | undefined,
	branch: string | null | undefined,
	relativePath: string,
): string | null {
	if (!remoteUrl || !branch || !relativePath) return null;
	const parsed = parseRemote(remoteUrl);
	if (!parsed) return null;

	const { host, namespace, repo } = parsed;
	const ref = encodeURIComponent(branch);
	const file = encodePath(relativePath);
	const base = `https://${host}/${namespace}/${repo}`;

	if (host.includes("bitbucket.")) {
		return `${base}/src/${ref}/${file}`;
	}
	if (host.includes("gitlab")) {
		return `${base}/-/blob/${ref}/${file}`;
	}
	// Default to GitHub-style (covers github.com and GitHub Enterprise hosts).
	return `${base}/blob/${ref}/${file}`;
}
