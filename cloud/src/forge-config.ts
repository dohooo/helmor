// Helmor Team Cloud Sandbox — forge (gh/glab) credential shapes + pure helpers.
//
// Kept dependency-free (no `cloudflare:workers`) so BOTH the Durable Object
// broker (`forge-identity.ts`) and the local-dev in-memory registry can import
// it without pulling the Workers runtime into the local Bun proxy.

/** What the desktop uploads per member. At least one field is present.
 *  - `githubToken`: a gh OAuth/PAT (pulled from the host keychain via
 *    `gh auth token`). github.com only for now.
 *  - `glabConfigYml`: the verbatim `glab-cli/config.yml` (carries token +
 *    protocol per GitLab host, incl. self-hosted). */
export interface ForgeIdentityInput {
	githubToken?: string;
	glabConfigYml?: string;
}

/** Non-secret status for the settings panel / GET route. NEVER carries a token. */
export interface ForgeIdentityStatus {
	hasGithub: boolean;
	glabHosts: string[];
}

/** Host keys under glab's `hosts:` block (e.g. `gitlab.com`, `ngit.hundun.cn`).
 *  Non-secret — used only to populate {@link ForgeIdentityStatus}. */
export function parseGlabHosts(configYml: string): string[] {
	const hosts: string[] = [];
	let inHosts = false;
	for (const line of configYml.split("\n")) {
		if (/^hosts:\s*$/.test(line)) {
			inHosts = true;
			continue;
		}
		if (!inHosts) continue;
		if (/^\S/.test(line)) break;
		const match = line.match(/^ {4}([A-Za-z0-9.-]+):\s*$/);
		if (match) hosts.push(match[1]);
	}
	return hosts;
}

/** Parse `host -> token` from a glab `config.yml` (4-space host keys, deeper
 *  `token:` fields). Mirrors the Rust `member_creds::parse_glab_tokens`. Used to
 *  rewrite a GitLab clone URL with the acting member's token. */
export function parseGlabTokens(configYml: string): Record<string, string> {
	const tokens: Record<string, string> = {};
	let inHosts = false;
	let currentHost: string | null = null;
	for (const line of configYml.split("\n")) {
		if (line.trimEnd() === "hosts:") {
			inHosts = true;
			continue;
		}
		if (!inHosts) continue;
		if (/^\S/.test(line)) break;
		if (!line.startsWith("    ")) continue;
		const rest = line.slice(4);
		if (rest.startsWith(" ")) {
			const match = rest.trimStart().match(/^token:\s*(.+)$/);
			if (match && currentHost) {
				const token = match[1].trim();
				if (token) tokens[currentHost] = token;
			}
		} else {
			const match = rest.trimEnd().match(/^([A-Za-z0-9.-]+):$/);
			if (match) currentHost = match[1];
		}
	}
	return tokens;
}

/** Derive non-secret status from a raw input payload. */
export function forgeStatusFromInput(
	input: ForgeIdentityInput,
): ForgeIdentityStatus {
	return {
		hasGithub: Boolean(input.githubToken),
		glabHosts: input.glabConfigYml ? parseGlabHosts(input.glabConfigYml) : [],
	};
}
