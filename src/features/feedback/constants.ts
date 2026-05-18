/** Upstream helmor repository — hardcoded. Users never configure this. */
export const HELMOR_UPSTREAM_OWNER = "dohooo";
export const HELMOR_UPSTREAM_REPO = "helmor";
export const HELMOR_UPSTREAM_SLUG = `${HELMOR_UPSTREAM_OWNER}/${HELMOR_UPSTREAM_REPO}`;
export const HELMOR_UPSTREAM_HTML_URL = `https://github.com/${HELMOR_UPSTREAM_SLUG}`;

/** Max characters we auto-derive from user input when generating an issue title. */
export const ISSUE_TITLE_MAX_CHARS = 30;

/** Fallback title when the user's input is empty after trimming. */
export const FALLBACK_ISSUE_TITLE = "Helmor feedback";
