// Parse PR/MR URLs into the parts needed for optimistic rendering.
// Backend persists only the URL on the workspace row (pr_url); the number
// is recovered here to avoid an extra DB column.

export type ForgeProvider = "github" | "gitlab";

export type ParsedPrUrl = {
	number: number;
	provider: ForgeProvider;
};

// GitHub:  https://github.com/{owner}/{repo}/pull/{n}
// GitHub Enterprise also matches — the path shape is identical.
const GITHUB_PR_PATH = /\/pull\/(\d+)(?:\/|$|\?|#)/;

// GitLab:  https://gitlab.com/{group}/{repo}/-/merge_requests/{n}
// Self-hosted GitLab uses the same `/-/merge_requests/N` shape.
const GITLAB_MR_PATH = /\/-\/merge_requests\/(\d+)(?:\/|$|\?|#)/;

export function parsePrUrl(url: string | null | undefined): ParsedPrUrl | null {
	if (!url) return null;
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		// Tolerate raw paths too — some tests / fixtures may pass `/owner/repo/pull/1`.
		pathname = url;
	}

	const githubMatch = pathname.match(GITHUB_PR_PATH);
	if (githubMatch) {
		const n = Number.parseInt(githubMatch[1], 10);
		if (Number.isFinite(n) && n > 0) {
			return { number: n, provider: "github" };
		}
	}

	const gitlabMatch = pathname.match(GITLAB_MR_PATH);
	if (gitlabMatch) {
		const n = Number.parseInt(gitlabMatch[1], 10);
		if (Number.isFinite(n) && n > 0) {
			return { number: n, provider: "gitlab" };
		}
	}

	return null;
}
