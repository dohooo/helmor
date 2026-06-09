import { describe, expect, test } from "bun:test";
import { matchesOrphanedServe, matchesServeOnPort } from "./opencode-server.js";

const HELMOR_BIN =
	"/Applications/Helmor.app/Contents/Resources/vendor/opencode/opencode";
const USER_BIN = "/opt/homebrew/bin/opencode";

describe("matchesServeOnPort (teardown reaper)", () => {
	test("matches our serve pinned by the exact port", () => {
		expect(
			matchesServeOnPort({
				command: `${HELMOR_BIN} serve --hostname=127.0.0.1 --port=51234`,
				binaryPath: HELMOR_BIN,
				hostname: "127.0.0.1",
				port: 51234,
			}),
		).toBe(true);
	});

	test("rejects a different port", () => {
		expect(
			matchesServeOnPort({
				command: `${HELMOR_BIN} serve --hostname=127.0.0.1 --port=49999`,
				binaryPath: HELMOR_BIN,
				hostname: "127.0.0.1",
				port: 51234,
			}),
		).toBe(false);
	});

	test("rejects a non-serve command on the same port string", () => {
		expect(
			matchesServeOnPort({
				command: `${HELMOR_BIN} run --port=51234`,
				binaryPath: HELMOR_BIN,
				hostname: "127.0.0.1",
				port: 51234,
			}),
		).toBe(false);
	});
});

describe("matchesOrphanedServe (startup reaper — no friendly fire)", () => {
	test("matches an orphaned (ppid=1) serve from our binary path", () => {
		expect(
			matchesOrphanedServe({
				command: `${HELMOR_BIN} serve --hostname=127.0.0.1 --port=51234`,
				ppid: 1,
				binaryPath: HELMOR_BIN,
			}),
		).toBe(true);
	});

	test("rejects a live sibling Helmor's server (ppid != 1)", () => {
		expect(
			matchesOrphanedServe({
				command: `${HELMOR_BIN} serve --hostname=127.0.0.1 --port=51234`,
				ppid: 4242,
				binaryPath: HELMOR_BIN,
			}),
		).toBe(false);
	});

	test("rejects a user's own opencode install (different path) even when orphaned", () => {
		expect(
			matchesOrphanedServe({
				command: `${USER_BIN} serve --hostname=127.0.0.1 --port=51234`,
				ppid: 1,
				binaryPath: HELMOR_BIN,
			}),
		).toBe(false);
	});

	test("rejects a non-serve command", () => {
		expect(
			matchesOrphanedServe({
				command: `${HELMOR_BIN} tui`,
				ppid: 1,
				binaryPath: HELMOR_BIN,
			}),
		).toBe(false);
	});

	test("skips when the binary is a bare name (cannot tell ours apart)", () => {
		expect(
			matchesOrphanedServe({
				command: "opencode serve --hostname=127.0.0.1 --port=51234",
				ppid: 1,
				binaryPath: "opencode",
			}),
		).toBe(false);
	});
});
