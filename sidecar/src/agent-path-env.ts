import { execFileSync } from "node:child_process";

export type WindowsRegistryPathScope = "machine" | "user";

export interface WindowsPathEnvOptions {
	platform?: NodeJS.Platform;
	readWindowsRegistryPath?: (
		scope: WindowsRegistryPathScope,
		env: NodeJS.ProcessEnv,
	) => string | undefined;
}

export function applyWindowsPathFromRegistry(
	env: NodeJS.ProcessEnv,
	options: WindowsPathEnvOptions = {},
): NodeJS.ProcessEnv {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return env;
	const readRegistryPath =
		options.readWindowsRegistryPath ?? readWindowsRegistryPath;
	const machinePath = expandWindowsEnvRefs(
		readRegistryPath("machine", env) ?? "",
		env,
	);
	const userPath = expandWindowsEnvRefs(
		readRegistryPath("user", env) ?? "",
		env,
	);
	const pathKey = getPathEnvKey(env, platform);
	const existingPath = env[pathKey] ?? "";
	const path = joinPathSegments(
		[
			...splitPathSegments(machinePath, ";"),
			...splitPathSegments(userPath, ";"),
			...splitPathSegments(existingPath, ";"),
		],
		";",
		platform,
	);
	setPathEnv(env, pathKey, path, platform);
	return env;
}

export function prependPathSegment(
	env: NodeJS.ProcessEnv,
	segment: string,
	platform: NodeJS.Platform = process.platform,
): void {
	const sep = platform === "win32" ? ";" : ":";
	const pathKey = getPathEnvKey(env, platform);
	const path = joinPathSegments(
		[segment, ...splitPathSegments(env[pathKey], sep)],
		sep,
		platform,
	);
	setPathEnv(env, pathKey, path, platform);
}

function readWindowsRegistryPath(
	scope: WindowsRegistryPathScope,
	_env: NodeJS.ProcessEnv,
): string | undefined {
	const key =
		scope === "machine"
			? String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
			: String.raw`HKCU\Environment`;
	try {
		const output = execFileSync("reg.exe", ["query", key, "/v", "Path"], {
			encoding: "utf8",
			timeout: 2_000,
			windowsHide: true,
		});
		return parseWindowsRegistryPathValue(output);
	} catch {
		return undefined;
	}
}

export function parseWindowsRegistryPathValue(
	output: string,
): string | undefined {
	const match = output.match(/^\s*Path\s+REG_\w+\s+(.+)$/im);
	return match?.[1]?.trim();
}

function expandWindowsEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
	return value.replace(/%([^%]+)%/g, (match, name: string) => {
		return getEnvValue(env, name) ?? match;
	});
}

function getPathEnvKey(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): string {
	if (platform !== "win32") return "PATH";
	return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function setPathEnv(
	env: NodeJS.ProcessEnv,
	pathKey: string,
	value: string,
	platform: NodeJS.Platform,
): void {
	if (platform === "win32") {
		for (const key of Object.keys(env)) {
			if (key !== pathKey && key.toLowerCase() === "path") delete env[key];
		}
	}
	env[pathKey] = value;
}

function joinPathSegments(
	segments: string[],
	sep: string,
	platform: NodeJS.Platform,
): string {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const rawSegment of segments) {
		const segment = rawSegment.trim();
		if (!segment) continue;
		const key = platform === "win32" ? segment.toLowerCase() : segment;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(segment);
	}
	return unique.join(sep);
}

function splitPathSegments(path: string | undefined, sep: string): string[] {
	return path?.split(sep) ?? [];
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find(
		(candidate) => candidate.toLowerCase() === name.toLowerCase(),
	);
	return key ? env[key] : undefined;
}
