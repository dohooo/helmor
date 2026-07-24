// Duplicate-tolerant D1 migration runner logic (round6 P1-4c). The classifier
// is the safety hinge: "duplicate column name" (fresh DB / re-run) must pass,
// everything else must fail the provision loudly.
import { describe, expect, it } from "vitest";
import {
	classifyMigrationError,
	D1_MIGRATIONS,
} from "../scripts/d1-migrations";

describe("classifyMigrationError", () => {
	it("classifies SQLite's duplicate-column error as already-applied", () => {
		// Raw engine string…
		expect(
			classifyMigrationError("duplicate column name: cloud_identity_member_id"),
		).toBe("already-applied");
		// …and the wrangler-wrapped shape, VERBATIM as captured from a live
		// re-run against a real D1 (wrangler 4.100.0, 2026-07):
		expect(
			classifyMigrationError(
				"✘ [ERROR] A request to the Cloudflare API (/accounts/…/d1/database/…/query) failed.\n\n  duplicate column name: cloud_identity_member_id: SQLITE_ERROR [code: 7500]",
			),
		).toBe("already-applied");
		expect(classifyMigrationError("DUPLICATE COLUMN NAME: x")).toBe(
			"already-applied",
		);
	});

	it("classifies everything else as fatal — never continue on an unknown DB shape", () => {
		expect(classifyMigrationError("no such table: teams")).toBe("fatal");
		expect(
			classifyMigrationError(
				"✘ [ERROR] A request to the Cloudflare API failed (network)",
			),
		).toBe("fatal");
		expect(classifyMigrationError("")).toBe("fatal");
		// "no such column" is the SYMPTOM the migration fixes — if it shows up
		// while migrating, something is genuinely wrong.
		expect(
			classifyMigrationError("no such column: cloud_identity_member_id"),
		).toBe("fatal");
	});
});

describe("D1_MIGRATIONS list shape", () => {
	it("has unique, non-empty ids and non-empty additive SQL", () => {
		const ids = D1_MIGRATIONS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const m of D1_MIGRATIONS) {
			expect(m.id.length).toBeGreaterThan(0);
			// The duplicate-tolerant runner is only sound for additive columns —
			// anything else needs the versioned-table upgrade documented in
			// d1-migrations.ts.
			expect(m.sql).toMatch(/^ALTER TABLE \w+ ADD COLUMN /);
		}
	});
});
