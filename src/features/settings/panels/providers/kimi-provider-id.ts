// Auto-derive an id for a custom (OpenAI-compatible) Kimi provider — the
// config.toml table key. Numeric suffix avoids clobbering configured providers.

export function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
}

export function hostFromUrl(url: string): string {
	const trimmed = url.trim();
	for (const candidate of [trimmed, `https://${trimmed}`]) {
		try {
			return new URL(candidate).hostname;
		} catch {
			// try next
		}
	}
	return "";
}

export function deriveProviderId(
	name: string,
	baseUrl: string,
	taken: ReadonlySet<string>,
): string {
	const base = slugify(name) || slugify(hostFromUrl(baseUrl)) || "custom";
	if (!taken.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
	}
	return `${base}-${taken.size + 1}`;
}
