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
// Fixed local-dev member token (NOT random) so the desktop can default to a
// known token and connect with zero manual entry. Local dev only: it is only
// valid against this 127.0.0.1 dev proxy, and the desktop gates its matching
// default on `import.meta.env.DEV`. Keep in sync with `src/lib/team-mode.ts`.
const devMemberToken =
	process.env.HELMOR_LOCAL_TEAM_MEMBER_TOKEN ?? "hlm_dev_team_local";

mkdirSync(stateDir, { recursive: true, mode: 0o700 });
chmodSync(stateDir, 0o700);

const secrets = loadSecrets(join(stateDir, "secrets.json"));
const registryPath = join(stateDir, "registry.json");
// Per-member forge creds for the container's `member_creds` loader. A DIR mount
// (not a single file) so the launcher can rewrite members.json live on each
// `PUT /team/forge-identity` and the container hot-reloads it via mtime — no
// restart, so the desktop's auto-sync-on-connect never disrupts running agents.
const forgeMembersDir = join(stateDir, "forge-members");
const forgeMembersFile = join(forgeMembersDir, "members.json");
const registry = new InMemoryLocalTeamRegistry(
	loadSnapshot(registryPath),
	(s) => {
		writeJsonFile(registryPath, s);
		writeForgeMembersFile(s);
	},
);
const memberToken = await ensureDefaultMemberToken();
// Ensure the file exists before the container mounts it (first run has no creds
// yet; the desktop auto-sync fills it in live afterwards).
writeForgeMembersFile(registry.snapshot());

if (!process.env.HELMOR_LOCAL_TEAM_COMPANION_BASE) {
	// Build by DEFAULT so a backend (src-tauri / sidecar / Dockerfile.local)
	// change is always picked up — buildx is content-hash aware, so an unchanged
	// tree is a few-second cache no-op (the heavy trees are .dockerignore'd and
	// cargo/bun use cache mounts). `HELMOR_LOCAL_TEAM_BUILD=0` skips the build for
	// a fast restart when you KNOW nothing changed (still builds if missing).
	if (process.env.HELMOR_LOCAL_TEAM_BUILD !== "0" || !localImageExists()) {
		console.log(`Building local Team image ${image} (cache-aware)…`);
		buildLocalImage();
	}
	prepareCodexHome();
	prepareForgeAuth();
	// ensureDockerContainer recreates only if the image actually changed, so a
	// no-op build never pointlessly restarts a healthy container.
	ensureDockerContainer();
	// Sweep the ~1.7GB image the rebuild just superseded (now unreferenced since
	// the container was recreated off the new one). No-op when nothing was built.
	pruneSupersededImages();
}

// Setup-only mode: `dev:team` runs this FIRST (sequentially) to build the image
// + container with clean output, then starts the proxy server as a separate
// step. Exit here so the build phase doesn't also park on the long-lived proxy.
if (process.env.HELMOR_LOCAL_TEAM_SETUP_ONLY === "1") {
	console.log("Local Team image + container ready.");
	process.exit(0);
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
	// Bind all interfaces (not just proxyHost) so the container can reach this
	// proxy via host.docker.internal for the Stage B write-through (PUT /team/sync).
	// The desktop still connects on 127.0.0.1 — publicBaseUrl is unchanged.
	hostname: "0.0.0.0",
	port: proxyPort,
	// Long-lived subscription streams (e.g. /rpc-stream/subscribe_ui_mutations)
	// sit idle between sparse events. Bun's default ~10s idleTimeout would close
	// them, and the desktop's rpc-stream transport has no reconnect — so UiMutation
	// events (workspaceChanged, etc.) would silently stop arriving. Disable it.
	idleTimeout: 0,
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
	runDocker(
		[
			"buildx",
			"build",
			"--platform",
			platform,
			"-f",
			join(cloudRoot, "Dockerfile.local"),
			"--target",
			"runtime",
			// Label so we can prune ONLY our own superseded builds (the old `:dev`
			// image goes dangling on every rebuild) without touching other projects'
			// dangling images. See `pruneSupersededImages`.
			"--label",
			"helmor.local-team=dev",
			"-t",
			image,
			"--load",
			repoRoot,
			// Stream buildx progress to the terminal — a backend rebuild can take
			// minutes, so a silent (captured) build looks like a hang.
		],
		{ inherit: true },
	);
}

/** Remove our own now-dangling images (previous `:dev` builds that lost their
 *  tag on the latest rebuild). Scoped by label so other projects' dangling
 *  images are never touched; the current tagged `:dev` is not dangling, so it's
 *  kept. Best-effort — a prune failure must never block the dev loop. Run only
 *  AFTER the container is (re)created off the new image, or the old image is
 *  still referenced and can't be removed. */
function pruneSupersededImages() {
	docker(["image", "prune", "-f", "--filter", "label=helmor.local-team=dev"], {
		allowFailure: true,
	});
}

function localImageExists(): boolean {
	return (
		docker(["image", "inspect", image], { allowFailure: true }).status === 0
	);
}

function ensureDockerContainer() {
	const latestImageId = docker(["image", "inspect", "-f", "{{.Id}}", image], {
		allowFailure: true,
	}).stdout.trim();
	const inspect = docker(
		["inspect", "-f", "{{.State.Running}}|{{.Image}}", containerName],
		{
			allowFailure: true,
		},
	);
	if (inspect.status === 0) {
		const [running, containerImageId] = inspect.stdout.trim().split("|");
		// Reuse only when the container was created from the CURRENT image. A
		// rebuild yields a new image id, so recreate to run the new binary;
		// an unchanged image keeps the same id, so a no-op build never restarts it.
		if (!latestImageId || containerImageId === latestImageId) {
			if (running !== "true") runDocker(["start", containerName]);
			waitForHealth();
			return;
		}
		console.log("Image changed — recreating the container with the new build");
		runDocker(["rm", "-f", containerName]);
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
		// Stage B write-through target: the in-container TeamSync mirrors
		// sessions/messages to this proxy's PUT /team/sync so team-mode history
		// (GET /team/messages) populates even while the sandbox is "asleep".
		// `host.docker.internal` reaches the host proxy from inside the container.
		// Without this the mirror stays inert locally — matching the real Worker,
		// which injects HELMOR_SYNC_URL via ensureServe when it starts the process.
		"-e",
		`HELMOR_SYNC_URL=http://host.docker.internal:${proxyPort}`,
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
	// Forge auth (gh/glab) snapshotted from the host by prepareForgeAuth(). The
	// dirs are disposable copies under stateDir, so a plain (rw) bind is safe —
	// gh/glab never touch the real host config.
	const ghAuthDir = join(stateDir, "forge-auth", "gh");
	if (existsSync(join(ghAuthDir, "hosts.yml"))) {
		args.push("-v", `${ghAuthDir}:/root/.config/gh`);
	}
	// Per-member forge creds for the in-container `member_creds` loader (true
	// per-member: the forge layer selects by the acting member). DIR mount so live
	// rewrites hot-reload without a restart.
	if (existsSync(forgeMembersFile)) {
		args.push(
			"-v",
			`${forgeMembersDir}:/run/helmor-forge:ro`,
			"-e",
			"HELMOR_FORGE_MEMBERS_PATH=/run/helmor-forge/members.json",
		);
	}
	const glabAuthDir = join(stateDir, "forge-auth", "glab-cli");
	const glabConfig = join(glabAuthDir, "config.yml");
	if (existsSync(glabConfig)) {
		args.push(
			"-v",
			`${glabAuthDir}:/root/.config/glab-cli`,
			"-e",
			"GLAB_CONFIG_DIR=/root/.config/glab-cli",
		);
		const glabHosts = readGlabHosts(glabConfig);
		if (glabHosts.length) {
			args.push("-e", `HELMOR_GLAB_HOSTS=${glabHosts.join(",")}`);
		}
	}
	if (process.env.GITHUB_TOKEN) {
		args.push("-e", `GITHUB_TOKEN=${process.env.GITHUB_TOKEN}`);
	}
	// Claude has no host-credential mount (unlike Codex): inject the token the
	// user authorized IN-APP (stored in the local registry) — or an explicit env
	// override — so cloud Claude turns actually authenticate in the container.
	const claudeToken = resolveClaudeToken();
	if (claudeToken) {
		args.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${claudeToken}`);
	}
	args.push("--entrypoint", "/usr/local/bin/helmor-start-serve", image);
	runDocker(args);
	waitForHealth();
}

function resolveClaudeToken(): string | undefined {
	return (
		process.env.CLAUDE_CODE_OAUTH_TOKEN ??
		registry.getClaudeToken() ??
		undefined
	);
}

function restartDockerContainer() {
	if (process.env.HELMOR_LOCAL_TEAM_COMPANION_BASE) return;
	// RECREATE (not `docker restart`) so a freshly-authorized Claude token is
	// re-injected as env — `docker restart` keeps the create-time env, so a new
	// token would never reach the container otherwise.
	docker(["rm", "-f", containerName], { allowFailure: true });
	ensureDockerContainer();
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

/** Snapshot the host's gh + glab auth into stateDir so the container can use
 *  the same forge credentials. gh's token lives in the macOS keychain (not in
 *  hosts.yml), so it's pulled via `gh auth token` and written into a synthetic
 *  hosts.yml the Linux gh reads directly; glab keeps its token in plaintext
 *  config.yml, so that's copied as-is. Best-effort — a missing CLI / logged-out
 *  host just skips that provider. */
/** Mirror the registry's per-member forge creds to the file the container's
 *  `member_creds` loader reads (`{ memberId: { githubToken?, glabConfigYml? } }`).
 *  Rewritten on every registry change so a live `PUT /team/forge-identity` is
 *  picked up by the running container via mtime reload. */
function writeForgeMembersFile(snapshot: LocalTeamSnapshot) {
	mkdirSync(forgeMembersDir, { recursive: true, mode: 0o700 });
	chmodSync(forgeMembersDir, 0o700);
	// Merge each member's login (for per-member commit authorship) alongside their
	// creds into the shape the in-container loader reads.
	const members: Record<
		string,
		{ githubToken?: string; glabConfigYml?: string; login?: string }
	> = {};
	for (const [memberId, creds] of Object.entries(
		snapshot.forgeCredentials ?? {},
	)) {
		members[memberId] = {
			...creds,
			login: snapshot.members[memberId]?.github_login,
		};
	}
	writeFileSync(forgeMembersFile, `${JSON.stringify(members, null, 2)}\n`, {
		mode: 0o600,
	});
}

function prepareForgeAuth() {
	const synced: string[] = [];
	if (prepareGhAuth(join(stateDir, "forge-auth", "gh"))) synced.push("gh");
	if (prepareGlabAuth(join(stateDir, "forge-auth", "glab-cli")))
		synced.push("glab");
	if (synced.length) {
		console.log(`Forge auth synced into the container: ${synced.join(" + ")}`);
	}
}

function prepareGhAuth(targetDir: string): boolean {
	const ghBin = process.env.HELMOR_LOCAL_TEAM_GH_BIN ?? "gh";
	const status = captureCommand(ghBin, ["auth", "status"]);
	if (status.status !== 0) return false;
	let yaml = "";
	for (const { host, login } of parseGhHosts(status.stdout)) {
		const token = captureCommand(ghBin, [
			"auth",
			"token",
			"--hostname",
			host,
		]).stdout.trim();
		if (!token) continue;
		// Write both the legacy top-level token and the `users` map so any gh
		// version in the container reads it.
		yaml += `${host}:\n    git_protocol: https\n    oauth_token: ${token}\n`;
		if (login) {
			yaml += `    user: ${login}\n    users:\n        ${login}:\n            oauth_token: ${token}\n`;
		}
	}
	if (!yaml) return false;
	mkdirSync(targetDir, { recursive: true, mode: 0o700 });
	chmodSync(targetDir, 0o700);
	writeFileSync(join(targetDir, "hosts.yml"), yaml, { mode: 0o600 });
	return true;
}

/** Hosts + active login from `gh auth status` (one block per host). */
function parseGhHosts(out: string): Array<{ host: string; login: string }> {
	const hosts: Array<{ host: string; login: string }> = [];
	let current: { host: string; login: string } | null = null;
	for (const line of out.split("\n")) {
		const host = line.match(/^([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})\s*$/);
		if (host) {
			current = { host: host[1], login: "" };
			hosts.push(current);
			continue;
		}
		if (current && !current.login) {
			const m = line.match(/(?:account|as)\s+([A-Za-z0-9-]+)/);
			if (m) current.login = m[1];
		}
	}
	return hosts;
}

function prepareGlabAuth(targetDir: string): boolean {
	const source = [
		process.env.HELMOR_LOCAL_TEAM_GLAB_CONFIG,
		join(homedir(), ".config", "glab-cli", "config.yml"),
		join(homedir(), "Library", "Application Support", "glab-cli", "config.yml"),
	].find((p): p is string => Boolean(p) && existsSync(p as string));
	if (!source) return false;
	mkdirSync(targetDir, { recursive: true, mode: 0o700 });
	chmodSync(targetDir, 0o700);
	const dest = join(targetDir, "config.yml");
	copyFileSync(source, dest);
	chmodSync(dest, 0o600);
	return true;
}

/** Host keys under glab's `hosts:` block — used to register git credential
 *  helpers per host in the container. */
function readGlabHosts(configPath: string): string[] {
	const hosts: string[] = [];
	let inHosts = false;
	for (const line of readFileSync(configPath, "utf8").split("\n")) {
		if (/^hosts:\s*$/.test(line)) {
			inHosts = true;
			continue;
		}
		if (!inHosts) continue;
		if (/^\S/.test(line)) break;
		const m = line.match(/^ {4}([A-Za-z0-9.-]+):\s*$/);
		if (m) hosts.push(m[1]);
	}
	return hosts;
}

function captureCommand(
	cmd: string,
	args: string[],
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(cmd, args, { encoding: "utf8", stdio: "pipe" });
	return {
		status: result.status ?? (result.error ? 1 : 0),
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
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
	// Ensure the FIXED dev token specifically is a valid member (not just "some"
	// member) so the desktop's known default always works, even if an older
	// random-token member already exists in persisted state.
	const existing = registry.snapshot().invites[devMemberToken];
	if (existing?.member_id) return devMemberToken;

	const memberId =
		process.env.HELMOR_LOCAL_TEAM_MEMBER_ID ?? "local-docker-dev";
	const login =
		process.env.HELMOR_LOCAL_TEAM_MEMBER_LOGIN ?? "local-docker-dev";
	await registry.bootstrap("local-docker");
	const invite = await registry.createInvite({
		baseUrl: publicBaseUrl,
		token: devMemberToken,
	});
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

function runDocker(args: string[], options?: { inherit?: boolean }) {
	const result = docker(args, options);
	if (result.status !== 0) {
		throw new Error(
			`docker ${args.join(" ")} failed\n${result.stderr || result.stdout}`,
		);
	}
	return result;
}

function docker(
	args: string[],
	options?: { allowFailure?: boolean; inherit?: boolean },
): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("docker", args, {
		cwd: repoRoot,
		encoding: "utf8",
		// `inherit` streams long/verbose commands (the image build) straight to
		// the terminal so progress is visible live; otherwise pipe so callers can
		// parse stdout (image ids, container state).
		stdio: options?.inherit ? "inherit" : "pipe",
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
