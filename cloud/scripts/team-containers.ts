#!/usr/bin/env bun
//
// Dev-tools helper: list / delete the operator's Cloudflare Containers via
// wrangler. Backs the Developer settings "Team cloud" group (list / delete the
// remote sandboxes you stood up). Thin on purpose — the Rust command just runs
// this and hands the output to the UI.
//
//   list            -> prints `wrangler containers list --json` to stdout
//   delete <id>     -> deletes the container, prints {"ok":true}
//
// Human-readable wrangler chatter goes to stderr; only the machine payload is
// on stdout. wrangler is self-resolved from the node_modules next to this
// script (repo cloud/ in dev, staged vendor/team-cloud in a release bundle) and
// run under our own runtime — same contract as provision-team.ts
// (HELMOR_WRANGLER_BIN stays as a manual override).

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cloudRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_BIN_OVERRIDE = process.env.HELMOR_WRANGLER_BIN || "";
const WRANGLER_JS = resolve(cloudRoot, "node_modules/wrangler/bin/wrangler.js");

function wrangler(args: string[], input?: string) {
	// cwd: never cloudRoot — it's read-only inside a release bundle.
	return spawnSync(
		WRANGLER_BIN_OVERRIDE || process.execPath,
		WRANGLER_BIN_OVERRIDE ? args : [WRANGLER_JS, ...args],
		{
			cwd: tmpdir(),
			input,
			encoding: "utf8",
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		},
	);
}

const [action, id] = process.argv.slice(2);

if (action === "list") {
	const r = wrangler(["containers", "list", "--json"]);
	if (r.status !== 0) {
		process.stderr.write(r.stderr ?? "");
		process.exit(1);
	}
	process.stdout.write((r.stdout ?? "[]").trim() || "[]");
} else if (action === "delete") {
	if (!id) {
		process.stderr.write("delete requires an <id>\n");
		process.exit(1);
	}
	// `containers delete` has no documented --yes flag; with no TTY wrangler
	// runs non-interactively, but pipe a confirmation as belt-and-suspenders in
	// case a future version prompts on stdin.
	const r = wrangler(["containers", "delete", id], "y\n");
	if (r.status !== 0) {
		process.stderr.write(r.stderr ?? "");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify({ ok: true }));
} else {
	process.stderr.write(`unknown action: ${action ?? "(none)"}\n`);
	process.exit(1);
}
