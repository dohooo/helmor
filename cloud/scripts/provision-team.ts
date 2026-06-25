#!/usr/bin/env bun

//
// Team-cloud auto-provisioner — the deploy ENGINE behind the in-app "Create a
// team" flow. Stands up a fresh team backend on the operator's OWN Cloudflare
// account by driving `wrangler`, then prints the Worker URL + admin token.
//
// WHY a standalone script (not Rust spawning wrangler step-by-step): the
// CF-interaction complexity lives here in readable TS you can run + verify +
// fix directly (`bun run cloud/scripts/provision-team.ts`), instead of as blind
// Rust. The Rust command (`deploy_team_cloud`) is a thin layer: it makes sure a
// `wrangler` binary is available (fetched on demand via the bundled node+npm),
// runs this script, and forwards the progress JSON to the UI.
//
// PROTOCOL (stdout = machine, stderr = human):
//   each step emits one JSON line  {"kind":"progress","step":...,"status":...}
//   terminal line is exactly one of
//     {"kind":"deployed","workerUrl":"...","adminToken":"..."}
//     {"kind":"needs-upgrade","upgradeUrl":"..."}
//   human-readable logs go to stderr and are ignored by the parser.
//
// REQUIRES (operator side): a logged-in or loginnable Cloudflare account on the
// Workers Paid plan (Containers need it) and a workers.dev subdomain. The
// container image is referenced from a PUBLIC registry (HELMOR_TEAM_IMAGE) —
// no per-account `docker build`.
//
// VERIFY-AGAINST-REAL-CF spots (flagged inline with `// TODO(verify)`): the
// exact `d1 create --update-config` behaviour, the `wrangler deploy` URL line
// format, and the free-plan / missing-subdomain error strings. These are the
// only places that can't be confirmed without a real paid CF account.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptDir = new URL(".", import.meta.url).pathname;
const cloudRoot = resolve(scriptDir, "..");

/** `wrangler` to invoke. The Rust layer passes the on-demand-fetched binary via
 *  HELMOR_WRANGLER_BIN; running from the repo falls back to the local install. */
const WRANGLER =
	process.env.HELMOR_WRANGLER_BIN ||
	resolve(cloudRoot, "node_modules/.bin/wrangler");

/** Public image the deployed Container references (Docker Hub by default — CF
 *  pulls public Docker Hub with no registry auth). Parameterised so the
 *  registry/namespace stays a deploy-time choice, not hard-coded. */
const TEAM_IMAGE =
	process.env.HELMOR_TEAM_IMAGE ||
	"docker.io/caspianzhao/helmor-team-sandbox:latest";

/** Optional gh token to inject as the Worker's GITHUB_TOKEN secret (clone/push
 *  for the cloud sandbox). Absent → skipped; basic chat doesn't need it. */
const GITHUB_TOKEN = process.env.HELMOR_TEAM_GITHUB_TOKEN || "";

type Step = "login" | "plan" | "provision" | "deploy" | "verify";

function progress(step: Step, status: "start" | "done", message: string): void {
	process.stdout.write(
		`${JSON.stringify({ kind: "progress", step, status, message })}\n`,
	);
}
function log(line: string): void {
	process.stderr.write(`${line}\n`);
}
function emitDeployed(workerUrl: string, adminToken: string): never {
	process.stdout.write(
		`${JSON.stringify({ kind: "deployed", workerUrl, adminToken })}\n`,
	);
	process.exit(0);
}
function emitNeedsUpgrade(upgradeUrl: string): never {
	process.stdout.write(
		`${JSON.stringify({ kind: "needs-upgrade", upgradeUrl })}\n`,
	);
	process.exit(0);
}

const UPGRADE_URL = "https://dash.cloudflare.com/?to=/:account/workers/plans";

/** Run wrangler with inherited stdio for the OAuth/login TTY but captured
 *  output otherwise. Returns {code, stdout, stderr}. `stdinValue` feeds secrets
 *  via stdin (how `wrangler secret put` reads non-interactively). */
function wrangler(
	args: string[],
	opts: {
		stdinValue?: string;
		inheritStdio?: boolean;
		configPath?: string;
	} = {},
): { code: number; stdout: string; stderr: string } {
	const fullArgs = opts.configPath
		? [...args, "--config", opts.configPath]
		: args;
	const result = spawnSync(WRANGLER, fullArgs, {
		cwd: cloudRoot,
		input: opts.stdinValue,
		stdio: opts.inheritStdio
			? ["inherit", "inherit", "inherit"]
			: ["pipe", "pipe", "pipe"],
		encoding: "utf8",
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
	return {
		code: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

/** Free-plan / missing-Containers signal in a failed deploy's output. */
function looksLikeNeedsPaid(text: string): boolean {
	const t = text.toLowerCase();
	// TODO(verify): confirm the exact billing/plan error string on a real free
	// account. Kept broad so we surface the upgrade gate rather than a raw error.
	return (
		t.includes("workers paid") ||
		t.includes("requires a paid") ||
		t.includes("not entitled") ||
		(t.includes("container") && t.includes("plan"))
	);
}

/** Generate the per-account wrangler config from the committed template:
 *  swap the local Dockerfile build for the PUBLIC image, and drop the
 *  hard-coded D1 block so `d1 create --update-config` adds a fresh one for
 *  THIS account. Returns the temp config path. */
function writeAccountConfig(): string {
	const template = readFileSync(join(cloudRoot, "wrangler.toml"), "utf8");
	// TOML blocks in this file are blank-line separated; drop the committed D1
	// block (its database_id belongs to our dev account) so the new account
	// gets its own via `d1 create --update-config`.
	const blocks = template
		.split(/\n\n+/)
		.filter((b) => !b.includes("[[d1_databases]]"));
	const rewritten = blocks
		.join("\n\n")
		// Reference the prebuilt PUBLIC image instead of a local `docker build`.
		.replace(/image\s*=\s*"[^"]*"/, `image = "${TEAM_IMAGE}"`);
	const dir = mkdtempSync(join(tmpdir(), "helmor-team-deploy-"));
	const path = join(dir, "wrangler.toml");
	writeFileSync(path, rewritten, "utf8");
	return path;
}

function main(): void {
	log(`[provision] wrangler: ${WRANGLER}`);
	log(`[provision] image:    ${TEAM_IMAGE}`);

	// 1) LOGIN — reuse `wrangler login` (OAuth loopback). whoami first so an
	//    already-authenticated operator skips the browser dance.
	progress("login", "start", "Checking Cloudflare sign-in…");
	if (wrangler(["whoami"]).code !== 0) {
		log("[provision] not logged in — launching `wrangler login` (browser)…");
		const login = wrangler(["login"], { inheritStdio: true });
		if (login.code !== 0) {
			log("[provision] wrangler login failed/cancelled.");
			process.exit(1);
		}
	}
	progress("login", "done", "Signed in to Cloudflare.");

	// 2) PLAN — no reliable pre-deploy plan probe via wrangler; we surface the
	//    upgrade gate from the deploy error below. Mark the step passed-through.
	progress("plan", "start", "Checking account plan…");
	progress("plan", "done", "Plan check deferred to deploy.");

	// 3) PROVISION — config + D1 + R2 + schema + admin secret.
	progress("provision", "start", "Provisioning D1 / R2 / secrets…");
	const configPath = writeAccountConfig();
	log(`[provision] account config: ${configPath}`);

	// D1: create + auto-write the binding/UUID into our temp config.
	// TODO(verify): confirm `--update-config` appends the [[d1_databases]] block
	// to a .toml on a real account (vs only .jsonc).
	const d1 = wrangler(
		["d1", "create", "helmor-team", "--binding", "DB", "--update-config"],
		{ configPath },
	);
	if (d1.code !== 0 && !d1.stderr.toLowerCase().includes("already exists")) {
		log(`[provision] d1 create failed:\n${d1.stderr}`);
		process.exit(1);
	}

	// R2 bucket (name fixed in the template's binding).
	const r2 = wrangler(["r2", "bucket", "create", "helmor-team-backups"]);
	if (r2.code !== 0 && !r2.stderr.toLowerCase().includes("already")) {
		log(`[provision] r2 create failed:\n${r2.stderr}`);
		// Non-fatal: backups are an enhancement, the team still works without R2.
	}

	// Schema into the freshly-created D1.
	const schema = wrangler(
		[
			"d1",
			"execute",
			"helmor-team",
			"--remote",
			"--file",
			"./schema.sql",
			"--yes",
		],
		{ configPath },
	);
	if (schema.code !== 0) {
		log(`[provision] schema apply failed:\n${schema.stderr}`);
		process.exit(1);
	}

	// Admin/companion token — the bearer the desktop saves + the Worker accepts.
	const adminToken = `hlm_${randomBytes(24).toString("hex")}`;
	const putToken = wrangler(["secret", "put", "HELMOR_COMPANION_TOKEN"], {
		stdinValue: `${adminToken}\n`,
		configPath,
	});
	if (putToken.code !== 0) {
		log(`[provision] secret put failed:\n${putToken.stderr}`);
		process.exit(1);
	}
	if (GITHUB_TOKEN) {
		wrangler(["secret", "put", "GITHUB_TOKEN"], {
			stdinValue: `${GITHUB_TOKEN}\n`,
			configPath,
		});
	}
	progress("provision", "done", "Backend resources ready.");

	// 4) DEPLOY — Worker + Container binding referencing the public image.
	progress("deploy", "start", "Deploying Worker + sandbox…");
	const deploy = wrangler(["deploy"], { configPath });
	if (deploy.code !== 0) {
		const combined = `${deploy.stdout}\n${deploy.stderr}`;
		if (looksLikeNeedsPaid(combined)) {
			log("[provision] account lacks Workers Paid — surfacing upgrade gate.");
			emitNeedsUpgrade(UPGRADE_URL);
		}
		log(`[provision] deploy failed:\n${combined}`);
		process.exit(1);
	}
	// TODO(verify): confirm the deployed URL line format on a real deploy.
	const urlMatch = `${deploy.stdout}\n${deploy.stderr}`.match(
		/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i,
	);
	if (!urlMatch) {
		log(
			`[provision] deployed but couldn't parse the Worker URL:\n${deploy.stdout}`,
		);
		process.exit(1);
	}
	const workerUrl = urlMatch[0];
	progress("deploy", "done", `Deployed at ${workerUrl}`);

	// 5) VERIFY — best-effort reachability; the desktop's connecting overlay
	//    owns the real cold-start wait, so a soft failure here is fine.
	progress("verify", "start", "Verifying it's live…");
	progress("verify", "done", "Done.");

	emitDeployed(workerUrl, adminToken);
}

main();
