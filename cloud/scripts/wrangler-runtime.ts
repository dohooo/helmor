// Which JS runtime spawns wrangler's JS entry — pure decision logic, shared by
// provision-team.ts and team-containers.ts, unit-tested in
// cloud/test/wrangler-runtime.test.ts (same pattern as broker-key.ts).
//
// WHY wrangler must not run under bun (round6 F-A, reproduced 100% locally):
// bun 1.3.2 running wrangler 4.100's `deploy` / `deployments list` prints only
// the banner and exits 0 with the body swallowed — provision's Worker-URL
// parsing then dies; `d1 list --json` fails the same way intermittently. The
// same commands under node print complete output. So: wrangler ALWAYS runs
// under node when one can be found; bun stays the runtime for the scripts
// themselves (the vendored node can't execute `.ts`).
//
// Priority (the script self-decides; Rust only passes a hint — same philosophy
// as the wrangler self-resolution in provision-team.ts):
//   1. HELMOR_WRANGLER_BIN — manual override, spawned directly (unchanged);
//   2. running under node already (release: the vendored node runs the staged
//      `.mjs`) — keep process.execPath;
//   3. under bun: HELMOR_WRANGLER_NODE (the vendored node, injected by the
//      Rust spawn points when it exists) → a PATH `node` → last resort:
//      execPath (bun) WITH a loud warning, so the run is no worse than before.

export type WranglerCommand = {
	/** Executable to spawn. */
	argv0: string;
	/** Args to prepend before wrangler's own args ([] for a direct override,
	 *  [wranglerJs] when running the JS entry under a runtime). */
	prefixArgs: string[];
	/** Loud human warning (stderr) when we had to fall back to bun. */
	warning?: string;
};

export function decideWranglerCommand(input: {
	overrideBin: string;
	wranglerJs: string;
	execPath: string;
	isBun: boolean;
	/** Validated HELMOR_WRANGLER_NODE ("" when unset or not a file). */
	nodeHint: string;
	/** A `node` found on PATH, or null. */
	pathNode: string | null;
}): WranglerCommand {
	if (input.overrideBin) {
		return { argv0: input.overrideBin, prefixArgs: [] };
	}
	const prefixArgs = [input.wranglerJs];
	if (!input.isBun) {
		return { argv0: input.execPath, prefixArgs };
	}
	const node = input.nodeHint || input.pathNode;
	if (node) {
		return { argv0: node, prefixArgs };
	}
	return {
		argv0: input.execPath,
		prefixArgs,
		warning:
			"no node runtime found (HELMOR_WRANGLER_NODE unset, no `node` on PATH) — " +
			"running wrangler under bun, which is known to swallow wrangler's output " +
			"(bun 1.3.2 + wrangler 4.100: banner only, no body). If provisioning " +
			"fails to parse wrangler output, install node or set HELMOR_WRANGLER_NODE.",
	};
}

/** Find a `node` executable on PATH. Pure: the caller injects the existence
 *  check (existsSync) so this stays unit-testable without a filesystem. */
export function findNodeOnPath(
	pathVar: string | undefined,
	isWindows: boolean,
	isFile: (path: string) => boolean,
): string | null {
	if (!pathVar) return null;
	const sep = isWindows ? ";" : ":";
	const exe = isWindows ? "node.exe" : "node";
	const dirSep = isWindows ? "\\" : "/";
	for (const dir of pathVar.split(sep)) {
		if (!dir) continue;
		const candidate = `${dir}${dirSep}${exe}`;
		if (isFile(candidate)) return candidate;
	}
	return null;
}
