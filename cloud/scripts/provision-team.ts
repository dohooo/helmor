#!/usr/bin/env bun

//
// Team-cloud auto-provisioner — the deploy ENGINE behind the in-app "Create a
// team" flow. Stands up a fresh team backend on the operator's OWN Cloudflare
// account by driving `wrangler`, then prints the Worker URL + admin token.
//
// WHY a standalone script (not Rust spawning wrangler step-by-step): the
// CF-interaction complexity lives here in readable TS you can run + verify +
// fix directly (`bun run cloud/scripts/provision-team.ts`), instead of as blind
// Rust. The Rust command (`deploy_team_cloud`) is a thin layer: it locates this
// script (repo `cloud/scripts/*.ts` in dev; the staged
// `vendor/team-cloud/scripts/provision-team.mjs` in a release bundle) plus a JS
// runtime (PATH `bun` in dev; the vendored Node in release), runs it, and
// forwards the progress JSON to the UI. `wrangler` is NOT expected on the
// operator's machine: it ships inside the same payload next to this script and
// is self-resolved below (see WRANGLER_JS).
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
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideBrokerKeyAction, toSecretListOutcome } from "./broker-key";
import { classifyMigrationError, D1_MIGRATIONS } from "./d1-migrations";

// fileURLToPath (not URL.pathname) so Windows paths don't keep the leading
// slash (`/C:/…`), which breaks resolve/join.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const cloudRoot = resolve(scriptDir, "..");

/** `wrangler` to invoke. HELMOR_WRANGLER_BIN (manual override / harness) is
 *  spawned directly; otherwise we run wrangler's JS entry from the
 *  node_modules NEXT TO this script (repo `cloud/node_modules` in dev, staged
 *  `vendor/team-cloud/node_modules` in a release bundle) under OUR OWN runtime
 *  (`process.execPath` — bun in dev, the vendored Node in release). Spawning
 *  the JS entry instead of the `.bin/wrangler` shim matters: the shim's
 *  `#!/usr/bin/env node` shebang needs a PATH `node`, and a Finder-launched
 *  app has no such PATH. */
const WRANGLER_BIN_OVERRIDE = process.env.HELMOR_WRANGLER_BIN || "";
const WRANGLER_JS = resolve(cloudRoot, "node_modules/wrangler/bin/wrangler.js");

/** Writable working directory for every wrangler invocation. wrangler scratches
 *  under its project dir (`.wrangler/`), and in a release bundle `cloudRoot`
 *  lives in the app's READ-ONLY Resources — so wrangler must never run with its
 *  cwd there. */
const workDir = mkdtempSync(join(tmpdir(), "helmor-team-wrangler-"));

/** Optional image OVERRIDE. Empty ⇒ deploy the tag committed in `wrangler.toml`
 *  — the SINGLE source of truth, kept in lockstep with publish-team-image.yml.
 *  A hard-coded default here previously OVERWROTE wrangler.toml's tag, so every
 *  in-app provision shipped a STALE image (a `:0.1.0` frozen while the repo /
 *  Worker moved to `:0.1.1`), diverging the container from the Worker it runs
 *  under (team-cloud-stabilize WP6). CF Containers still reject `:latest`, so an
 *  override MUST be a pinned tag. */
const TEAM_IMAGE_OVERRIDE = process.env.HELMOR_TEAM_IMAGE || "";

/** The image tag actually deployed: the override, else wrangler.toml's committed
 *  `image = "…"`. Used for logging + kept identical to what `writeAccountConfig`
 *  writes so the two never drift. */
function resolveImage(): string {
	if (TEAM_IMAGE_OVERRIDE) return TEAM_IMAGE_OVERRIDE;
	const template = readFileSync(join(cloudRoot, "wrangler.toml"), "utf8");
	return template.match(/image\s*=\s*"([^"]*)"/)?.[1] ?? "(from wrangler.toml)";
}

/** Optional gh token to inject as the Worker's GITHUB_TOKEN secret (clone/push
 *  for the cloud sandbox). Absent → skipped; basic chat doesn't need it. */
const GITHUB_TOKEN = process.env.HELMOR_TEAM_GITHUB_TOKEN || "";

type Step = "login" | "plan" | "provision" | "deploy" | "verify";

function progress(
	step: Step,
	status: "start" | "done" | "error",
	message: string,
): void {
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
	const result = spawnSync(
		WRANGLER_BIN_OVERRIDE || process.execPath,
		WRANGLER_BIN_OVERRIDE ? fullArgs : [WRANGLER_JS, ...fullArgs],
		{
			cwd: workDir,
			input: opts.stdinValue,
			stdio: opts.inheritStdio
				? ["inherit", "inherit", "inherit"]
				: ["pipe", "pipe", "pipe"],
			encoding: "utf8",
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		},
	);
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
 *   - drop the hard-coded D1 block (its id is our dev account's; the caller
 *     injects THIS account's id),
 *   - swap the local Dockerfile build for the PUBLIC image,
 *   - make `main` ABSOLUTE — wrangler resolves `main` relative to the config
 *     file, and ours lives in a temp dir, so a relative `src/index.ts` 404s
 *     ("entry-point file … not found"). Returns the temp config path. */
function writeAccountConfig(): string {
	const template = readFileSync(join(cloudRoot, "wrangler.toml"), "utf8");
	// TOML blocks are blank-line separated; drop the committed D1 block.
	const blocks = template
		.split(/\n\n+/)
		.filter((b) => !b.includes("[[d1_databases]]"));
	let rewritten = blocks
		.join("\n\n")
		.replace(
			/^main\s*=\s*"[^"]*"/m,
			`main = "${join(cloudRoot, "src/index.ts")}"`,
		);
	// Keep wrangler.toml's committed image tag UNLESS explicitly overridden — the
	// tag is the single source of truth (WP6). Only rewrite for HELMOR_TEAM_IMAGE.
	if (TEAM_IMAGE_OVERRIDE) {
		rewritten = rewritten.replace(
			/image\s*=\s*"[^"]*"/,
			`image = "${TEAM_IMAGE_OVERRIDE}"`,
		);
	}
	const dir = mkdtempSync(join(tmpdir(), "helmor-team-deploy-"));
	const path = join(dir, "wrangler.toml");
	writeFileSync(path, rewritten, "utf8");
	return path;
}

/** Resolve a D1 database's id by name via `d1 list --json` (works whether it
 *  was just created or already existed). Empty string if not found. */
function findD1Id(name: string): string {
	const res = wrangler(["d1", "list", "--json"]);
	if (res.code !== 0) return "";
	try {
		const dbs = JSON.parse(res.stdout) as Array<{
			uuid?: string;
			name?: string;
		}>;
		return dbs.find((db) => db.name === name)?.uuid ?? "";
	} catch {
		return "";
	}
}

/** Cold-start ceiling for the REAL verify below (matches the Worker's own
 *  SERVE_READY_TIMEOUT_MS). A first boot of the GTK/WebKit stack is slow. */
const VERIFY_TIMEOUT_MS = 180_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One authenticated probe. Never throws — a network error is `{ ok:false }` so
 *  the caller keeps polling (cold start) or reports the failing stage. Reads the
 *  Worker's structured body so a `permanent` container error is surfaced. */
async function probeVerify(
	url: string,
	token: string,
	method: "GET" | "POST" = "GET",
): Promise<{
	ok: boolean;
	status?: number;
	permanent?: boolean;
	message?: string;
}> {
	try {
		const res = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
			},
			...(method === "POST" ? { body: "{}" } : {}),
		});
		if (res.ok) return { ok: true, status: res.status };
		const body = (await res.json().catch(() => ({}))) as {
			permanent?: boolean;
			message?: string;
		};
		return {
			ok: false,
			status: res.status,
			permanent: body.permanent === true,
			message: body.message,
		};
	} catch (error) {
		return { ok: false, message: (error as Error).message };
	}
}

/** REAL end-to-end verify (WP6, S3): Worker auth → the container actually STARTS
 *  (`/v1/health` goes through the Worker's `ensureServe`) → the model catalog
 *  returns. Returns a human error NAMING the failing stage, or null on success.
 *  A permanent container error or a cold start that never finishes is a HARD fail
 *  — setup must not go green on a backend that can't run a turn (the old VERIFY
 *  step was a no-op progress marker). Agent-identity readiness isn't checked here
 *  (this runs pre-authorize on the admin token); the create-flow's Finish gate
 *  owns that. */
/** WP6.1: POST `/admin/destroy-sandbox` so any WARM container (holding the
 *  PREVIOUS companion token) is scaled to zero before verify — the next request
 *  cold-starts and injects the freshly-rotated token, so a Reset→re-provision no
 *  longer 401s and recovery needs no manual `wrangler`. Best-effort: a non-2xx or
 *  network error is logged and swallowed (verify still catches a token mismatch). */
async function destroyWarmContainer(
	workerUrl: string,
	token: string,
): Promise<void> {
	const base = workerUrl.replace(/\/+$/, "");
	try {
		const res = await fetch(`${base}/admin/destroy-sandbox`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		log(
			res.ok
				? "[provision] destroyed any warm container (next request cold-starts fresh)"
				: `[provision] destroy-sandbox HTTP ${res.status} (non-fatal; verify is the backstop)`,
		);
	} catch (error) {
		log(
			`[provision] destroy-sandbox failed (non-fatal): ${
				error instanceof Error ? error.message : error
			}`,
		);
	}
}

async function verifyLive(
	workerUrl: string,
	token: string,
): Promise<string | null> {
	const base = workerUrl.replace(/\/+$/, "");
	// (a) Container start — poll /v1/health (through ensureServe) up to the ceiling.
	const deadline = Date.now() + VERIFY_TIMEOUT_MS;
	for (;;) {
		const health = await probeVerify(`${base}/v1/health`, token);
		if (health.ok) break;
		if (health.permanent) {
			return `Container start: ${health.message ?? "permanent error"}`;
		}
		if (health.status === 401 || health.status === 403) {
			return `Worker auth: the admin token was rejected (HTTP ${health.status}).`;
		}
		if (Date.now() >= deadline) {
			return "Container start: the sandbox didn't finish starting in time.";
		}
		await sleep(3000);
	}
	// (b) Model catalog — the composer's blocking query; proves the serve host
	//     answers RPC, not just /v1/health.
	const models = await probeVerify(
		`${base}/rpc/list_agent_model_sections`,
		token,
		"POST",
	);
	if (!models.ok) {
		return models.permanent
			? `Model catalog: ${models.message ?? "permanent error"}`
			: `Model catalog: the serve host didn't return models (HTTP ${
					models.status ?? "network error"
				}).`;
	}
	return null;
}

async function main(): Promise<void> {
	if (!WRANGLER_BIN_OVERRIDE && !existsSync(WRANGLER_JS)) {
		log(
			`[provision] fatal: wrangler is missing from this build (expected ${WRANGLER_JS}). ` +
				"In a release bundle that means vendor/team-cloud/node_modules didn't ship — reinstall Helmor. " +
				"In a repo checkout, run `bun install` in cloud/ first.",
		);
		process.exit(1);
	}
	log(
		`[provision] wrangler: ${WRANGLER_BIN_OVERRIDE || `${process.execPath} ${WRANGLER_JS}`}`,
	);
	log(`[provision] image:    ${resolveImage()}`);

	// 1) LOGIN — reuse `wrangler login` (OAuth loopback). whoami first so an
	//    already-authenticated operator skips the browser dance. Detected by
	//    OUTPUT, not exit code: wrangler 4.100 `whoami` exits 0 even when
	//    logged out (it prints "You are not authenticated…"), so exit-code-only
	//    detection silently skipped the browser login on every fresh machine
	//    and provisioning face-planted later at the first authed call
	//    (round6 P1-1a, caught by the dimension-1 clean-shell smoke).
	progress("login", "start", "Checking Cloudflare sign-in…");
	const who = wrangler(["whoami"]);
	const needsLogin =
		who.code !== 0 || /not authenticated/i.test(`${who.stdout}\n${who.stderr}`);
	if (needsLogin) {
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

	// D1: ensure it exists, then write its REAL id into the config. (`d1 create
	// --update-config` silently skips the binding when the DB already exists,
	// leaving the deploy with no DB binding; resolving the id explicitly also
	// handles re-running against an account that's already set up.)
	wrangler(["d1", "create", "helmor-team"]); // best-effort; "already exists" ok
	const dbId = findD1Id("helmor-team");
	if (!dbId) {
		log("[provision] couldn't resolve the helmor-team D1 id.");
		process.exit(1);
	}
	appendFileSync(
		configPath,
		`\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "helmor-team"\ndatabase_id = "${dbId}"\n`,
	);

	// R2 bucket (name fixed in the template's binding).
	const r2 = wrangler(["r2", "bucket", "create", "helmor-team-backups"]);
	if (r2.code !== 0 && !r2.stderr.toLowerCase().includes("already")) {
		log(`[provision] r2 create failed:\n${r2.stderr}`);
		// Non-fatal: backups are an enhancement, the team still works without R2.
	}

	// Schema into the freshly-created D1. Absolute path — wrangler's cwd is a
	// temp workDir (never cloudRoot, which is read-only in a release bundle).
	const schema = wrangler(
		[
			"d1",
			"execute",
			"helmor-team",
			"--remote",
			"--file",
			join(cloudRoot, "schema.sql"),
			"--yes",
		],
		{ configPath },
	);
	if (schema.code !== 0) {
		log(`[provision] schema apply failed:\n${schema.stderr}`);
		process.exit(1);
	}

	// One-time migrations for PRE-EXISTING databases (P1-4c): schema.sql only
	// shapes fresh DBs (CREATE TABLE IF NOT EXISTS never backfills a column),
	// so additive columns are applied here on every provision, tolerating
	// SQLite's "duplicate column name" — the expected outcome on a fresh DB.
	// List + rationale + upgrade path live in d1-migrations.ts.
	for (const migration of D1_MIGRATIONS) {
		const applied = wrangler(
			[
				"d1",
				"execute",
				"helmor-team",
				"--remote",
				"--command",
				migration.sql,
				"--yes",
			],
			{ configPath },
		);
		if (applied.code === 0) {
			log(`[provision] migration ${migration.id}: applied`);
			continue;
		}
		const combined = `${applied.stdout}\n${applied.stderr}`;
		if (classifyMigrationError(combined) === "already-applied") {
			log(`[provision] migration ${migration.id}: already applied — skipped`);
			continue;
		}
		log(`[provision] migration ${migration.id} failed:\n${combined}`);
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

	// BROKER_ENC_KEY — the AES-256-GCM key the identity brokers (Codex /
	// Claude / Forge DOs) encrypt member credentials with. A fresh account
	// never had it (P1-1b: authorize threw on the undefined key → blind 500),
	// so provision generates it — but ⚠️ ONLY when it is confidently absent:
	// rotating an existing key bricks every stored identity. Decision logic +
	// its four branches live in broker-key.ts (unit-tested); inconclusive
	// checks FAIL the run rather than guess.
	const secretList = wrangler(["secret", "list"], { configPath });
	const brokerKeyAction = decideBrokerKeyAction(
		toSecretListOutcome(secretList),
	);
	if (brokerKeyAction === "fail") {
		log(
			`[provision] couldn't determine whether BROKER_ENC_KEY already exists (secret list failed):\n${secretList.stderr || secretList.stdout}`,
		);
		log(
			"[provision] refusing to write it blindly — overwriting an existing key would invalidate every stored agent identity. Check connectivity/login and retry.",
		);
		process.exit(1);
	}
	if (brokerKeyAction === "put") {
		// 32 random bytes, standard base64 — exactly what the DOs' atob-based
		// base64ToBytes expects for AES-256. The value is never logged.
		const brokerKey = randomBytes(32).toString("base64");
		const putBrokerKey = wrangler(["secret", "put", "BROKER_ENC_KEY"], {
			stdinValue: `${brokerKey}\n`,
			configPath,
		});
		if (putBrokerKey.code !== 0) {
			log(`[provision] BROKER_ENC_KEY put failed:\n${putBrokerKey.stderr}`);
			process.exit(1);
		}
		log("[provision] generated BROKER_ENC_KEY (was not set).");
	} else {
		log(
			"[provision] BROKER_ENC_KEY already set — left untouched (rotating would invalidate stored identities).",
		);
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

	// 4.5) RESET WARM CONTAINER (WP6.1): a re-provision just rotated
	//      HELMOR_COMPANION_TOKEN, but a container still WARM from a prior run
	//      caches the OLD token (injected at its startProcess) and 401s every
	//      proxied rpc. Force-destroy it so verify's cold-start injects the NEW
	//      token. Best-effort — never blocks provision; verify is the backstop.
	await destroyWarmContainer(workerUrl, adminToken);

	// 5) VERIFY — REAL end-to-end (WP6, fixes S3 "green but broken"): the Worker
	//    must auth, the container must actually START, and the model catalog must
	//    return. A green here PROVES the backend can run a turn — not just that the
	//    Worker deployed. A failing stage exits non-zero with a stage-named error.
	progress("verify", "start", "Waking the sandbox to verify it starts…");
	const verifyErr = await verifyLive(workerUrl, adminToken);
	if (verifyErr) {
		progress("verify", "error", verifyErr);
		log(`[provision] verify failed: ${verifyErr}`);
		process.exit(1);
	}
	progress("verify", "done", "Sandbox starts and the model catalog is live.");

	emitDeployed(workerUrl, adminToken);
}

main().catch((error) => {
	log(`[provision] fatal: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
