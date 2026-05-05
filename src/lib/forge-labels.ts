// Frontend mirror of `forge::cli_status::labels_for` on the Rust side.
// Kept in sync by hand — labels are a fixed enum-like mapping, so a
// duplicate const map is cheaper than threading a backend round-trip
// through every UI surface that needs the copy. If you change one
// side, change the other.

import type { ForgeLabels, ForgeProvider } from "./api";

const GITHUB: ForgeLabels = {
	providerName: "GitHub",
	cliName: "gh",
	changeRequestName: "PR",
	changeRequestFullName: "pull request",
	connectAction: "Connect GitHub",
};

const GITLAB: ForgeLabels = {
	providerName: "GitLab",
	cliName: "glab",
	changeRequestName: "MR",
	changeRequestFullName: "merge request",
	connectAction: "Connect GitLab",
};

const UNKNOWN: ForgeLabels = {
	providerName: "Git",
	cliName: "",
	changeRequestName: "change request",
	changeRequestFullName: "change request",
	connectAction: "",
};

export function forgeLabelsFor(
	provider: ForgeProvider | null | undefined,
): ForgeLabels {
	switch (provider) {
		case "github":
			return GITHUB;
		case "gitlab":
			return GITLAB;
		default:
			return UNKNOWN;
	}
}
