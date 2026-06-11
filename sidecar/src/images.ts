/**
 * Strip `@<path>` image markers from a user prompt and return the
 * stripped text alongside the resolved image paths. Each provider
 * (Claude / Codex) materializes the result into its own SDK input.
 *
 * The structured `imagePaths` array is the single source of truth for
 * which `@<path>` substrings inside `prompt` should be lifted out as
 * image attachments. Paths may contain whitespace (macOS Finder
 * drops); never re-derive this list from the prompt text via regex —
 * doing so silently truncates at the first whitespace.
 *
 * Empty array means "no attachments" — the prompt text is preserved
 * untouched (apart from leading/trailing trim) and `imagePaths` stays
 * empty. Callers that want best-effort lift of typed `@/foo.png`
 * patterns must do that detection upstream (in the composer) and feed
 * the result into `imagePaths`.
 */

export interface ParsedImageRefs {
	readonly text: string;
	readonly imagePaths: readonly string[];
}

export function parseImageRefs(
	prompt: string,
	imagePaths: readonly string[],
): ParsedImageRefs {
	// Strip longest needles first so a path that's a suffix of another
	// path never wins over the longer one.
	const dedup = [...new Set(imagePaths)];
	if (dedup.length === 0) {
		return { text: prompt.trim(), imagePaths: [] };
	}
	const sorted = [...dedup].sort((a, b) => b.length - a.length);
	let text = prompt;
	for (const path of sorted) {
		const needle = `@${path}`;
		while (text.includes(needle)) {
			text = text.replace(needle, "");
		}
	}
	// Collapse runs of spaces left behind where a needle was lifted out
	// AND trim. This can over-collapse intentional double-spaces in
	// non-attachment text, but it keeps single-line prompts tidy and
	// matches pre-refactor behavior.
	text = text.replace(/ {2,}/g, " ").trim();
	return { text, imagePaths: dedup };
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	heic: "image/heic",
};

/** Best-effort MIME from a file extension; image/png when unknown. */
export function imageMime(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_MIME_BY_EXT[ext] ?? "image/png";
}
