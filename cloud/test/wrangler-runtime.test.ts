// Which runtime spawns wrangler's JS entry (round6 F-A). The bug under test:
// bun 1.3.2 running wrangler 4.100 swallows its output (banner only, exit 0,
// no body) → provision's URL parsing dies on the dev default path. wrangler
// must run under node whenever one is available; bun stays the orchestration
// runtime for the scripts themselves.
import { describe, expect, it } from "vitest";
import {
	decideWranglerCommand,
	findNodeOnPath,
} from "../scripts/wrangler-runtime";

const BASE = {
	overrideBin: "",
	wranglerJs: "/repo/cloud/node_modules/wrangler/bin/wrangler.js",
	execPath: "/usr/local/bin/bun",
	isBun: true,
	nodeHint: "",
	pathNode: null as string | null,
};

describe("decideWranglerCommand", () => {
	it("HELMOR_WRANGLER_BIN override wins over everything, spawned directly", () => {
		const cmd = decideWranglerCommand({
			...BASE,
			overrideBin: "/opt/custom/wrangler",
			nodeHint: "/vendor/node/node",
			pathNode: "/usr/bin/node",
		});
		expect(cmd).toEqual({
			argv0: "/opt/custom/wrangler",
			prefixArgs: [],
		});
	});

	it("under bun, the HELMOR_WRANGLER_NODE hint (vendored node) is preferred", () => {
		const cmd = decideWranglerCommand({
			...BASE,
			nodeHint: "/app/target/debug/vendor/node/node",
			pathNode: "/usr/bin/node",
		});
		expect(cmd.argv0).toBe("/app/target/debug/vendor/node/node");
		expect(cmd.prefixArgs).toEqual([BASE.wranglerJs]);
		expect(cmd.warning).toBeUndefined();
	});

	it("under bun with no hint, falls back to a PATH node", () => {
		const cmd = decideWranglerCommand({ ...BASE, pathNode: "/usr/bin/node" });
		expect(cmd.argv0).toBe("/usr/bin/node");
		expect(cmd.prefixArgs).toEqual([BASE.wranglerJs]);
		expect(cmd.warning).toBeUndefined();
	});

	it("under bun with no node at all, falls back to execPath WITH a loud warning", () => {
		const cmd = decideWranglerCommand(BASE);
		expect(cmd.argv0).toBe(BASE.execPath);
		expect(cmd.prefixArgs).toEqual([BASE.wranglerJs]);
		expect(cmd.warning).toContain("bun");
		expect(cmd.warning).toContain("node");
	});

	it("under node, keeps execPath (release path — vendored node already runs us)", () => {
		const cmd = decideWranglerCommand({
			...BASE,
			execPath: "/app/vendor/node/node",
			isBun: false,
			// Even with a hint set, a node execPath needs no redirection.
			nodeHint: "/somewhere/else/node",
		});
		expect(cmd.argv0).toBe("/app/vendor/node/node");
		expect(cmd.prefixArgs).toEqual([BASE.wranglerJs]);
		expect(cmd.warning).toBeUndefined();
	});
});

describe("findNodeOnPath", () => {
	it("returns the first PATH entry containing a node executable", () => {
		const isFile = (p: string) => p === "/usr/local/bin/node";
		expect(
			findNodeOnPath("/opt/none:/usr/local/bin:/usr/bin", false, isFile),
		).toBe("/usr/local/bin/node");
	});

	it("uses node.exe and ; on Windows", () => {
		const isFile = (p: string) => p === "C:\\tools\\node\\node.exe";
		expect(findNodeOnPath("C:\\other;C:\\tools\\node", true, isFile)).toBe(
			"C:\\tools\\node\\node.exe",
		);
	});

	it("returns null for an empty/undefined PATH or no hit", () => {
		expect(findNodeOnPath(undefined, false, () => true)).toBeNull();
		expect(findNodeOnPath("", false, () => true)).toBeNull();
		expect(findNodeOnPath("/a:/b", false, () => false)).toBeNull();
	});
});
