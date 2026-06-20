#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createLocalTeamProxy } from "../src/local-dev/proxy";
import {
	InMemoryLocalTeamRegistry,
	type LocalTeamSnapshot,
} from "../src/local-dev/registry";

type LocalSecrets = {
	adminToken: string;
	companionToken: string;
};

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");
const cloudRoot = resolve(scriptDir, "..");

const stateDir = resolvePath(
	process.env.HELMOR_LOCAL_TEAM_STATE_DIR ??
		join(repoRoot, ".local-data", "team-docker"),
);
const proxyHost = process.env.HELMOR_LOCAL_TEAM_HOST ?? "127.0.0.1";
const proxyPort = Number(process.env.HELMOR_LOCAL_TEAM_PORT ?? "8787");
const companionPort = Number(
	process.env.HELMOR_LOCAL_TEAM_COMPANION_PORT ?? "18080",
);
const image = process.env.HELMOR_LOCAL_TEAM_IMAGE ?? "helmor-team-local:dev";
const platform =
	process.env.HELMOR_LOCAL_TEAM_PLATFORM ?? defaultDockerPlatform();
const containerName =
	process.env.HELMOR_LOCAL_TEAM_CONTAINER ?? "helmor-team-local-dev";
const dataVolume =
	process.env.HELMOR_LOCAL_TEAM_DATA_VOLUME ?? "helmor-team-local-data";
const workspaceVolume =
	process.env.HELMOR_LOCAL_TEAM_WORKSPACE_VOLUME ??
	"helmor-team-local-workspace";
const publicBaseUrl =
	process.env.HELMOR_LOCAL_TEAM_PUBLIC_URL ??
	`http://${proxyHost}:${proxyPort}`;
const companionBaseUrl =
	process.env.HELMOR_LOCAL_TEAM_COMPANION_BASE ??
	`http://127.0.0.1:${companionPort}`;
const debugProxy = process.env.HELMOR_LOCAL_TEAM_DEBUG === "1";

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);

const secrets = loadSecrets(join(stateDir, "secrets.json"));
const registryPath = join(stateDir, "registry.json");
const registry = new InMemoryLocalTeamRegistry(
	loadSnapshot(registryPath),
	(s) => writeJsonFile(registryPath, s),
);
const memberToken = await ensureDefaultMemberToken();

if (!process.env.HELMOR_LOCAL_TEAM_COMPANION_BASE) {
	if (process.env.HELMOR_LOCAL_TEAM_BUILD === "1") {
		buildLocalImage();
	}
	prepareCodexHome();
	ensureDockerContainer();
}

const proxy = createLocalTeamProxy({
	registry,
	companionBaseUrl,
	companionToken: secrets.companionToken,
	adminToken: secrets.adminToken,
	publicBaseUrl,
	sandboxId: "local-docker",
	fetchCompanion: fetchCompanionWithNodeHttp,
	restartCompanion: async () => restartDockerContainer(),
});

Bun.serve({
	hostname: proxyHost,
	port: proxyPort,
	fetch: proxy.fetch,
});

console.log(`Helmor local Team proxy: ${publicBaseUrl}`);
console.log(`Member token: ${memberToken}`);
console.log(`Admin token: ${secrets.adminToken}`);
console.log(`Companion: ${companionBaseUrl}`);
console.log(`State: ${stateDir}`);
console.log("Use Settings -> Team with the URL above and the member token.");
console.log("Use the admin token only for bootstrap/admin operations.");

function buildLocalImage() {
	runDocker([
		"buildx",
		"build",
		"--platform",
		platform,
		"-f",
		join(cloudRoot, "Dockerfile.local"),
		"--target",
		"runtime",
		"-t",
		image,
		"--load",
		repoRoot,
	]);
}

function ensureDockerContainer() {
	const inspect = docker(
		["inspect", "-f", "{{.State.Running}}", containerName],
		{
			allowFailure: true,
		},
	);
	if (inspect.status === 0) {
		if (inspect.stdout.trim() !== "true") runDocker(["start", containerName]);
		waitForHealth();
		return;
	}

	const args = [
		"run",
		"-d",
		"--name",
		containerName,
		"--platform",
		platform,
		"-p",
		`127.0.0.1:${companionPort}:8080`,
		"-e",
		`HELMOR_COMPANION_TOKEN=${secrets.companionToken}`,
		"-e",
		"HELMOR_CLOUD_AUTOPUSH=0",
		"-e",
		"HELMOR_LOG=debug",
		"-e",
		"HELMOR_DATA_DIR=/home/helmor",
		"-e",
		"HOME=/root",
		"-e",
		"IS_SANDBOX=1",
		"-v",
		`${dataVolume}:/home/helmor`,
		"-v",
		`${workspaceVolume}:/workspace`,
	];
	const codexHome = join(stateDir, "codex-home");
	if (existsSync(codexHome)) {
		args.push("-v", `${codexHome}:/root/.codex`);
	}
	if (process.env.GITHUB_TOKEN) {
		args.push("-e", `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
	}
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
		args.push(
			"-e",
			`CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
		);
	}
	args.push("--entrypoint", "/usr/local/bin/helmor-start-serve", image);
	runDocker(args);
	waitForHealth();
}

function restartDockerContainer() {
	if (process.env.HELMOR_LOCAL_TEAM_COMPANION_BASE) return;
	runDocker(["restart", containerName]);
	waitForHealth();
}

function waitForHealth() {
	const deadline = Date.now() + 120_000;
	let lastError = "";
	while (Date.now() < deadline) {
		const response = Bun.spawnSync({
			cmd: [
				"curl",
				"-fsS",
				`${companionBaseUrl.replace(/\/+$/, "")}/v1/health`,
			],
			stdout: "pipe",
			stderr: "pipe",
		});
		if (response.exitCode === 0) return;
		lastError = response.stderr.toString();
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
	}
	throw new Error(
		`local Docker companion did not become healthy: ${lastError}`,
	);
}

function prepareCodexHome() {
	const source = resolvePath(
		process.env.HELMOR_LOCAL_TEAM_CODEX_HOME ?? join(homedir(), ".codex"),
	);
	const auth = join(source, "auth.json");
	const config = join(source, "config.toml");
	if (!existsSync(auth) && !existsSync(config)) return;

	const target = join(stateDir, "codex-home");
	mkdirSync(target, { recursive: true, mode: 0o700 });
	chmodSync(target, 0o700);
	if (existsSync(auth)) copyFileSync(auth, join(target, "auth.json"));
	if (existsSync(config)) copyFileSync(config, join(target, "config.toml"));
}

function loadSecrets(path: string): LocalSecrets {
	if (existsSync(path)) {
		return JSON.parse(readFileSync(path, "utf8")) as LocalSecrets;
	}
	const value = {
		adminToken: `hlm_local_admin_${randomUUID()}`,
		companionToken: `hlm_local_companion_${randomUUID()}`,
	};
	writeJsonFile(path, value);
	return value;
}

function loadSnapshot(path: string): Partial<LocalTeamSnapshot> | undefined {
	if (!existsSync(path)) return undefined;
	return JSON.parse(readFileSync(path, "utf8")) as Partial<LocalTeamSnapshot>;
}

async function ensureDefaultMemberToken(): Promise<string> {
	const existing = Object.values(registry.snapshot().invites).find(
		(invite) => invite.member_id,
	);
	if (existing) return existing.token;

	const memberId =
		process.env.HELMOR_LOCAL_TEAM_MEMBER_ID ?? "local-docker-dev";
	const login =
		process.env.HELMOR_LOCAL_TEAM_MEMBER_LOGIN ?? "local-docker-dev";
	await registry.bootstrap("local-docker");
	const invite = await registry.createInvite({ baseUrl: publicBaseUrl });
	const accepted = await registry.acceptInvite({
		token: invite.token,
		githubId: memberId,
		login,
		displayName:
			process.env.HELMOR_LOCAL_TEAM_MEMBER_NAME ?? "Local Docker Dev",
	});
	if (!accepted.ok) {
		throw new Error(
			`failed to create default local member: ${accepted.message}`,
		);
	}
	return invite.token;
}

function writeJsonFile(path: string, value: unknown) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
}

function runDocker(args: string[]) {
	const result = docker(args);
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed\n${result.stderr || result.stdout}`,
		);
	}
	return result;
}

function docker(
	args: string[],
	options?: { allowFailure?: boolean },
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("docker", args, {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (!options?.allowFailure && result.error) throw result.error;
	return {
		status: result.status ?? (result.error ? 1 : 0),
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function resolvePath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(path);
}

function defaultDockerPlatform(): string {
	if (process.arch === "arm64") return "linux/arm64";
	return "linux/amd64";
}

async function fetchCompanionWithNodeHttp(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const body =
		request.method === "GET" || request.method === "HEAD"
			? null
			: Buffer.from(await request.arrayBuffer());
	if (debugProxy) {
		console.error(
			`[local-team-proxy] -> ${request.method} ${url.pathname}${url.search} body=${body?.length ?? 0}`,
		);
	}
	return new Promise((resolve, reject) => {
		const client = url.protocol === "https:" ? https : http;
		const headers = Object.fromEntries(request.headers);
		if (body) headers["content-length"] = String(body.length);
		const upstream = client.request(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port,
				path: `${url.pathname}${url.search}`,
				method: request.method,
				headers,
			},
			(response) => {
				if (debugProxy) {
					console.error(
						`[local-team-proxy] <- ${response.statusCode ?? 0} ${url.pathname}`,
					);
				}
				const headers = new Headers();
				for (const [key, value] of Object.entries(response.headers)) {
					if (Array.isArray(value)) {
						for (const item of value) headers.append(key, item);
					} else if (value !== undefined) {
						headers.set(key, String(value));
					}
				}
				resolve(
					new Response(Readable.toWeb(response) as ReadableStream, {
						status: response.statusCode ?? 500,
						statusText: response.statusMessage,
						headers,
					}),
				);
			},
		);
		upstream.on("error", reject);
		if (body) upstream.write(body);
		upstream.end();
	});
}
