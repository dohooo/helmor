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
-- persistence). `cloud_identity_member_id` (Phase 1) is the GitHub numeric id
-- of the member whose `CodexIdentity` Durable Object backs this team's cloud
-- run identity (v1: one team -> one identity); NULL until a member authorizes.
CREATE TABLE IF NOT EXISTS teams (
  id                       TEXT PRIMARY KEY,
  sandbox_id               TEXT NOT NULL,
  backup_handle            TEXT,
  cloud_identity_member_id TEXT
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

-- Stage B data plane: denormalized, read-only mirror of the sandbox's SESSIONS
-- so the desktop can browse history with the container asleep. `id` /
-- `workspace_id` are the SAME ids as the sandbox rows. Fed by the container's
-- write-through (PUT /team/sync); D1 never feeds back into the sandbox.
-- Browse-essential columns only — fields needed to RESUME a turn (drafts,
-- provider_session_id, fast_mode, unread_count) come from the live container on
-- wake, not the mirror.
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  title                TEXT,
  status               TEXT,
  model                TEXT,
  agent_type           TEXT,
  permission_mode      TEXT,
  effort_level         TEXT,
  action_kind          TEXT,
  session_kind         TEXT,
  is_hidden            INTEGER NOT NULL DEFAULT 0,
  last_user_message_at TEXT,
  created_at           TEXT,
  updated_at           TEXT
);

-- Append-only mirror of the sandbox's session_messages — the chat history the
-- desktop renders by running the SAME `convert_historical` pipeline over these
-- raw rows. `content` is the verbatim message JSON. Rows are immutable once
-- written (matching the sandbox) and cascade-deleted with their session.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT,
  content    TEXT,
  sent_at    TEXT,
  created_at TEXT,
  author_id  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sent_at);

-- ── One-time migrations for PRE-EXISTING databases ───────────────────────────
-- The CREATE TABLE statements above only add new columns to FRESH databases
-- (a `CREATE TABLE IF NOT EXISTS` no-ops if the table already exists, so it
-- never backfills a column onto an already-bootstrapped table). D1/SQLite has
-- NO `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and a bare `ALTER` here would
-- abort this whole re-runnable file on fresh/re-run (the column would already
-- exist). So the ALTER is documented — NOT executed — here; the orchestrator
-- runs it ONCE against the live D1 at deploy. It errors harmlessly ("duplicate
-- column name") if the column already exists, which is the expected outcome on
-- a DB created from the CREATE TABLE above.
--
-- Phase 1 (cloud_identity_member_id): for a team D1 that predates Phase 1, run:
--   wrangler d1 execute helmor-team --remote --command "ALTER TABLE teams ADD COLUMN cloud_identity_member_id TEXT"

-- WP5 (D2): control-plane model-catalog cache. One row per sandbox holding the
-- verbatim `list_agent_model_sections` JSON (AgentModelSection[] — catalog
-- METADATA only, never credentials). Lets the Worker answer the composer's
-- model list + the desktop readiness probe with the container ASLEEP; refreshed
-- on every container cold start and on every live pass of the RPC (no TTL).
-- The Worker's write path also runs this CREATE (self-healing), so a pre-WP5
-- D1 that never re-ran this file gains the table on the first write.
CREATE TABLE IF NOT EXISTS model_catalog (
  sandbox_id TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
