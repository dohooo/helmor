/**
 * Provider-agnostic parsing of `@/path/to/file.png` image references in a
 * user prompt. Each provider (Claude / Codex) decides how to materialize
 * the result into its own SDK input format.
 */

const IMAGE_REF_RE = /@(\/\S+\.(?:png|jpe?g|gif|webp|svg|bmp|ico))/gi;

export interface ParsedImageRefs {
	readonly text: string;
	readonly imagePaths: readonly string[];
}

export function parseImageRefs(prompt: string): ParsedImageRefs {
	const matches = [...prompt.matchAll(IMAGE_REF_RE)];
	if (matches.length === 0) {
		return { text: prompt, imagePaths: [] };
	}
	const imagePaths = matches.map((m) => {
		const captured = m[1];
		if (typeof captured !== "string") {
			throw new Error("IMAGE_REF_RE capture group missing");
		}
		return captured;
	});
	let text = prompt;
	for (const p of imagePaths) {
		text = text.replace(`@${p}`, "");
	}
	text = text.replace(/ {2,}/g, " ").trim();
	return { text, imagePaths: [...new Set(imagePaths)] };
}
