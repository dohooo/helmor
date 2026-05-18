export function basename(path: string): string {
	const normalized = path.replace(/\/+$/, "");
	const value = normalized.split(/[\\/]/).pop();
	return value && value.length > 0 ? value : "Local project";
}

export function repositoryNameFromUrl(url: string): string {
	const withoutTrailingSlash = url.trim().replace(/\/+$/, "");
	const name = withoutTrailingSlash
		.split("/")
		.pop()
		?.replace(/\.git$/, "");
	return name && name.length > 0 ? name : "GitHub repository";
}
