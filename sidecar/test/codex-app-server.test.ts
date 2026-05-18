import { describe, expect, test } from "bun:test";

import { buildCodexAppServerArgs } from "../src/codex-app-server.js";

describe("buildCodexAppServerArgs", () => {
	test("disables native notify hooks for embedded app-server sessions", () => {
		expect(buildCodexAppServerArgs()).toEqual([
			"app-server",
			"-c",
			"notify=[]",
		]);
	});
});
