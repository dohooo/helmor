import { describe, expect, test } from "bun:test";

import { buildCodexAppServerArgs } from "../src/codex-app-server.js";

describe("buildCodexAppServerArgs", () => {
	test("enables goals and disables native notify hooks for embedded app-server sessions", () => {
		expect(buildCodexAppServerArgs()).toEqual([
			"app-server",
			"--enable",
			"goals",
			"-c",
			"notify=[]",
		]);
	});
});
