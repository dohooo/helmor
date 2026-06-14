-- Helmor Team Cloud Sandbox — D1 control-plane schema (Phase 3 / action item ①).
--
-- D1 is the team REGISTRY only: a denormalized, read-only mirror for the
-- sidebar + the identity anchor for author attribution. The sandbox's own
-- SQLite remains the source of truth for workspaces/sessions/messages — D1
-- never feeds back into the sandbox for correctness.
--
-- Apply (one-time, after `wrangler d1 create`):
--   bunx wrangler d1 execute helmor-team --remote --file ./schema.sql
-- Idempotent: safe to re-run.

-- Team members. Keyed to the GitHub NUMERIC id (a login can be renamed; the
-- numeric id is stable). login + avatar are cached for display only.
CREATE TABLE IF NOT EXISTS members (
  id           TEXT PRIMARY KEY,   -- GitHub numeric id (as string)
  github_login TEXT NOT NULL,
  avatar_url   TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL
);

-- One row per team. `sandbox_id` is the Worker's routing key (Phase 0/1: one
-- team -> one sandbox). `backup_handle` is reserved for Phase 2b (R2 sleep
-- persistence) and stays unused here.
CREATE TABLE IF NOT EXISTS teams (
  id            TEXT PRIMARY KEY,
  sandbox_id    TEXT NOT NULL,
  backup_handle TEXT
);

-- Denormalized, read-only mirror of the sandbox's workspaces (fed by a sync
-- write / lazy pull). `id` is the SAME id as the sandbox workspace row.
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  name       TEXT NOT NULL,   -- directory / display name
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Invite link = capability token (trust-on-first-use). The token doubles as
-- the accepted member's bearer: client -> Worker uses this token, the Worker
-- maps it to `member_id` (and swaps in the shared companion token for the
-- Worker -> companion hop). `member_id` is NULL until the invite is accepted.
CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,   -- random; becomes the member's bearer on accept
  team_id    TEXT NOT NULL,
  member_id  TEXT,               -- NULL until accepted, then -> members.id
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invites_member ON invites(member_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_team ON workspaces(team_id);
