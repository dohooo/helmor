// Versionless, duplicate-tolerant D1 migrations for PRE-EXISTING team
// databases (round6 P1-4c). schema.sql's `CREATE TABLE IF NOT EXISTS` only
// shapes FRESH databases — it never backfills a column onto an
// already-bootstrapped table — and D1/SQLite has no `ALTER TABLE … ADD COLUMN
// IF NOT EXISTS`. So additive columns land here, and provision-team.ts
// executes every entry against the live D1 on each provision / re-provision:
//
//   fresh DB (column already in the CREATE TABLE) → "duplicate column name"
//     → classified already-applied, skipped
//   pre-existing DB missing the column           → the ALTER applies it
//   anything else                                → fatal; the provision fails
//
// Adding a migration: append an entry with a unique id, keep it additive and
// duplicate-classifiable, and add the column to schema.sql's CREATE TABLE too
// (fresh DBs read only that file). If migrations ever stop fitting this shape
// (backfills, type changes, data moves), upgrade to a versioned
// schema_migrations table instead of stretching this list past its design.

export type D1Migration = { id: string; sql: string };

export const D1_MIGRATIONS: readonly D1Migration[] = [
	{
		// Phase 1 cloud-run identity anchor. Teams whose D1 predates the column
		// (long-lived dev DBs; re-provision onto an already-set-up account, where
		// `d1 create` and the schema apply both no-op) hit "no such column" on
		// team.ts's INSERT/SELECT without it.
		id: "0001-teams-cloud-identity-member-id",
		sql: "ALTER TABLE teams ADD COLUMN cloud_identity_member_id TEXT",
	},
];

/** Classify a failed `wrangler d1 execute --command` output. SQLite's
 *  "duplicate column name" means the column is already there (a fresh DB, or a
 *  re-run) — that's the desired end state, not an error. Anything else is
 *  fatal: the provision must fail loudly rather than continue against a DB in
 *  an unknown shape. */
export function classifyMigrationError(
	output: string,
): "already-applied" | "fatal" {
	return /duplicate column name/i.test(output) ? "already-applied" : "fatal";
}
