import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";

export type AgentProxySettings =
	| { readonly mode: "system" }
	| { readonly mode: "custom"; readonly customUrl: string };

export function buildAgentProxyEnv(
	agentProxy?: AgentProxySettings,
): Readonly<Record<string, string>> | undefined {
	if (process.platform !== "darwin") return undefined;
	const proxyUrl = resolveProxyUrl(agentProxy);
	if (!proxyUrl) return undefined;
	return {
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		ALL_PROXY: proxyUrl,
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
		all_proxy: proxyUrl,
	};
}

function resolveProxyUrl(agentProxy?: AgentProxySettings): string | null {
	if (!agentProxy) return null;
	if (agentProxy.mode === "custom") return agentProxy.customUrl;
	return resolveSystemProxyUrl();
}

function resolveSystemProxyUrl(): string | null {
	try {
		const output = execFileSync("/usr/sbin/scutil", ["--proxy"], {
			encoding: "utf8",
			timeout: 1500,
		});
		return parseMacSystemProxy(output);
	} catch (err) {
		logger.info("failed to read macOS system proxy", { err: String(err) });
		return null;
	}
}

export function parseMacSystemProxy(output: string): string | null {
	const values = new Map<string, string>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
		const key = match?.[1];
		const value = match?.[2];
		if (key && value) values.set(key, value);
	}
	return (
		proxyFromMacSettings(values, "HTTPS") ??
		proxyFromMacSettings(values, "HTTP") ??
		proxyFromMacSettings(values, "SOCKS")
	);
}

function proxyFromMacSettings(
	values: Map<string, string>,
	prefix: "HTTP" | "HTTPS" | "SOCKS",
): string | null {
	if (values.get(`${prefix}Enable`) !== "1") return null;
	const host = values.get(`${prefix}Proxy`)?.trim();
	if (!host) return null;
	const port = values.get(`${prefix}Port`)?.trim();
	const scheme = prefix === "SOCKS" ? "socks5" : "http";
	return port ? `${scheme}://${host}:${port}` : `${scheme}://${host}`;
}
