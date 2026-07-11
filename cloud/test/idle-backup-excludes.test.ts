import { describe, expect, it } from "vitest";
import { BACKUP_EXCLUDES, idleBackupOptions } from "../src/index";

// P1-3b: the idle (pre-sleep) backup once carried its own inline exclude
// list, which silently drifted from BACKUP_EXCLUDES — it lost `.codex/.tmp`
// (the Codex plugin-marketplace clone cache, 76MB+), re-inflating idle
// archives and re-opening the R3-D restore-OOM wedge for any Codex team that
// slept via the idle path. There must be exactly ONE exclude list.
describe("P1-3b idle backup excludes", () => {
	it("references BACKUP_EXCLUDES itself — same array, not a copy", () => {
		// toBe (identity), NOT toEqual: a copied array that happens to match
		// today can drift again tomorrow. Referencing the constant cannot.
		expect(idleBackupOptions("t").excludes).toBe(BACKUP_EXCLUDES);
	});

	it("keeps the R3-D OOM guard: .codex/.tmp is excluded", () => {
		expect(idleBackupOptions("t").excludes).toContain(".codex/.tmp");
	});

	it("matches the post-turn backup's dir/ttl/localBucket shape", () => {
		const options = idleBackupOptions("2026-07-11T00:00:00.000Z");
		expect(options.dir).toBe("/home/helmor");
		expect(options.localBucket).toBe(true);
		expect(options.ttl).toBe(259200);
		expect(options.name).toBe("helmor-idle-2026-07-11T00:00:00.000Z");
	});
});
