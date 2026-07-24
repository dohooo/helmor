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

	// R2-F4a (Codex half, live-autopsied at the class3+4 rollout): the
	// container's older squashfs-tools drops the ENTIRE parent directory of a
	// nested "dir/sub" exclude — `.codex/.tmp` in the list made mksquashfs
	// drop the whole `.codex` session-thread tree, so Codex resume came back
	// empty after every sleep. The OOM guard moved container-side: the serve
	// prunes `$CODEX_HOME/.tmp` with finally semantics after every turn
	// (src-tauri cloud_autopush::CodexTmpPruneGuard); the exclude list must
	// stay top-level-only forever.
	it("contains NO nested dir/sub patterns (old mksquashfs drops the parent tree)", () => {
		for (const pattern of BACKUP_EXCLUDES) {
			expect(
				pattern,
				`nested exclude pattern "${pattern}" would make the container's mksquashfs drop its parent tree`,
			).not.toMatch(/\//);
		}
	});

	it("no longer excludes .codex/.tmp (pruned container-side instead)", () => {
		expect(idleBackupOptions("t").excludes).not.toContain(".codex/.tmp");
	});

	it("matches the post-turn backup's dir/ttl/localBucket shape", () => {
		const options = idleBackupOptions("2026-07-11T00:00:00.000Z");
		expect(options.dir).toBe("/home/helmor");
		expect(options.localBucket).toBe(true);
		expect(options.ttl).toBe(259200);
		expect(options.name).toBe("helmor-idle-2026-07-11T00:00:00.000Z");
	});
});
