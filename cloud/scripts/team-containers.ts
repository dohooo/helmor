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
// on stdout. Uses the on-demand / repo wrangler (HELMOR_WRANGLER_BIN override).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const cloudRoot = resolve(new URL(".", import.meta.url).pathname, "..");
const WRANGLER =
	process.env.HELMOR_WRANGLER_BIN ||
	resolve(cloudRoot, "node_modules/.bin/wrangler");

function wrangler(args: string[], input?: string) {
	return spawnSync(WRANGLER, args, {
		cwd: cloudRoot,
		input,
		encoding: "utf8",
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	});
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
