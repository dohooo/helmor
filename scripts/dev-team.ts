#!/usr/bin/env bun
// One-command local Team dev, in TWO sequential phases so the (verbose, slow)
// image build runs to completion with clean output BEFORE the desktop's
// vite/tauri logs start interleaving:
//
//   1. Build the image + (re)create the container — runs to completion.
//   2. Start the long-running proxy + desktop concurrently.
//
// Ctrl-C (or either long-running process exiting) tears everything down.
import { type ChildProcess, spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const cloud = `${root}cloud`;

const children: ChildProcess[] = [];
let shuttingDown = false;

function shutdown(code = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const child of children) {
		if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
	}
	// Give children a beat to flush, then exit.
	setTimeout(() => process.exit(code), 600);
}

function spawnStep(
	cwd: string,
	args: string[],
	extraEnv?: Record<string, string>,
): ChildProcess {
	const child = spawn("bun", args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, ...extraEnv },
	});
	children.push(child);
	return child;
}

/** Phase 1: run a step to completion. Resolves with its exit code. */
function runToCompletion(
	name: string,
	cwd: string,
	args: string[],
	extraEnv?: Record<string, string>,
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawnStep(cwd, args, extraEnv);
		child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
		child.on("error", (error) => {
			console.error(`[dev:team] ${name} failed to start:`, error.message);
			resolve(1);
		});
	});
}

/** Phase 2: start a long-running step; its exit tears the rest down. */
function runLongRunning(name: string, cwd: string, args: string[]): void {
	const child = spawnStep(cwd, args, { HELMOR_LOCAL_TEAM_BUILD: "0" });
	child.on("exit", (code, signal) => {
		console.log(
			`\n[dev:team] ${name} exited (${code ?? signal ?? "?"}) — stopping the rest`,
		);
		shutdown(code ?? 0);
	});
	child.on("error", (error) => {
		console.error(`[dev:team] ${name} failed to start:`, error.message);
		shutdown(1);
	});
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Phase 1 — build + container, to completion (clean, un-interleaved output).
console.log("[dev:team] 1/2 — building the local Team image + container…");
const setupCode = await runToCompletion("setup", cloud, ["run", "dev:docker"], {
	HELMOR_LOCAL_TEAM_SETUP_ONLY: "1",
});
if (setupCode !== 0) {
	console.error("[dev:team] image/container setup failed — aborting");
	shutdown(setupCode);
} else {
	// Phase 2 — long-running proxy + desktop, concurrently (build already done,
	// so the proxy skips it via HELMOR_LOCAL_TEAM_BUILD=0).
	console.log("[dev:team] 2/2 — starting the proxy + desktop…");
	runLongRunning("proxy", cloud, ["run", "dev:docker"]);
	runLongRunning("desktop", root, ["run", "dev"]);
}
