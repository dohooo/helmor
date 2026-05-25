//! Clap argument definitions for every installed Helmor CLI subcommand.
//!
//! Split out from `mod.rs` so dispatch logic and argument schema evolve
//! independently — adding a new flag only touches this file plus the
//! command body.
//!
//! ## `EXAMPLES_*` `after_help` blocks
//!
//! The clap derive on each high-traffic subcommand uses
//! `#[command(after_help = EXAMPLES_*)]` to append a literal
//! `EXAMPLES:` section underneath the standard `--help` output. These
//! blocks are the single source of truth for "how do I use this
//! command in practice" — both human users and AI agents working
//! inside Helmor are pointed at them by the system prompt instead of
//! getting a command cheat-sheet baked into every turn's preamble.
//!
//! Command strings in the examples use the literal name `helmor`.
//! That's the right copy for release users (the binary on their PATH
//! IS `helmor`). Dev users invoke the CLI through an absolute path
//! handed to them by Helmor's system prompt, and the prompt's trust
//! signal already tells the agent to call its path verbatim — so we
//! intentionally don't try to runtime-rewrite `helmor` to the dev
//! binary name inside these strings.

use clap::{Args, Parser, Subcommand, ValueEnum};

// ---------------------------------------------------------------------------
// after_help example blocks (rendered as the `EXAMPLES:` section under each
// subcommand's `--help`)
// ---------------------------------------------------------------------------

const EXAMPLES_WORKSPACE_NEW: &str = "EXAMPLES (substitute `helmor` with the binary name in the Usage line above if it differs):
    # Create a workspace on a repo by name (matches the repo column in `workspace list`)
    helmor workspace new --repo dohooo/hello

    # Repo argument also accepts a UUID
    helmor workspace new --repo 7f3e9b2a-1234-5678-90ab-cdef12345678

    # Pre-stage a prompt into the new workspace's session without sending
    NEW_WS_ID=$(helmor workspace new --repo dohooo/hello --json | jq -r .id)
    helmor send --workspace \"$NEW_WS_ID\" --plan 'Analyse the routing layer and propose a refactor.'";

const EXAMPLES_WORKSPACE_LIST: &str =
    "EXAMPLES (substitute `helmor` with the binary name in the Usage line above if it differs):
    # All active workspaces, grouped by status
    helmor workspace list

    # Machine-readable form (for scripting / agent piping)
    helmor workspace list --json

    # Just the ones in a single repo
    helmor workspace list --repo dohooo/hello

    # Filter by kanban status
    helmor workspace list --status review";

const EXAMPLES_WORKSPACE_RUN_ACTION: &str =
    "EXAMPLES (substitute `helmor` with the binary name in the Usage line above if it differs):
    # Dispatch an agent-driven 'commit + push' run against a workspace
    helmor workspace run-action dohooo/hello/feature-x commit-and-push

    # Same shape with a workspace UUID
    helmor workspace run-action 7f3e9b2a-1234-5678-90ab-cdef12345678 create-pr

    # Other agent-dispatched flows
    helmor workspace run-action <ref> fix-errors
    helmor workspace run-action <ref> resolve-conflicts

    # Inline flows (no agent involved; run synchronously)
    helmor workspace run-action <ref> merge-pr
    helmor workspace run-action <ref> pull-latest";

const EXAMPLES_SESSION_SEARCH: &str =
    "EXAMPLES (substitute `helmor` with the binary name in the Usage line above if it differs):
    # Find sessions whose title or messages mention 'auth'
    helmor session search --query auth

    # Restrict to one repo
    helmor session search --query auth --repo dohooo/hello

    # Status-only filter (no keyword needed)
    helmor session search --status streaming

    # Include archived workspaces
    helmor session search --query auth --include-archived --json";

const EXAMPLES_SESSION_GET_MESSAGES: &str =
    "EXAMPLES (substitute `helmor` with the binary name in the Usage line above if it differs):
    # Last 5 messages of a session (default window)
    helmor session get-messages 7f3e9b2a-1234-5678-90ab-cdef12345678

    # Wider tail window
    helmor session get-messages <session-id> --limit 20

    # Oldest messages first (good for reading another agent's plan)
    helmor session get-messages <session-id> --position head --limit 10

    # Truncate long messages to 300 chars from the end
    helmor session get-messages <session-id> --body-limit 300 --body-position end";

const EXAMPLES_SEND: &str =
    "EXAMPLES (substitute `helmor` with the binary name in the Usage line above if it differs):
    # Send a prompt to a workspace's active session (sends immediately)
    helmor send --workspace dohooo/hello/feature-x 'Add a test for the parser edge case.'

    # Target a specific session by UUID
    helmor send --workspace <ws-ref> --session <session-id> 'Continue from where you left off.'

    # Plan mode (shortcut for --permission-mode plan)
    helmor send --workspace <ws-ref> --plan 'Sketch the refactor before changing anything.'

    # Read the prompt body from stdin (useful for long / piped prompts)
    cat prompt.md | helmor send --workspace <ws-ref> -";

#[derive(Parser)]
#[command(
    name = "helmor",
    version,
    about = "Helmor workspace, session, and agent CLI",
    long_about = "Remote-control Helmor from the terminal. Works against the same SQLite \
                  database the desktop app uses — run commands even while the app is \
                  running."
)]
pub struct Cli {
    /// Emit JSON instead of human-friendly text.
    #[arg(long, global = true)]
    pub json: bool,

    /// Reduce output to IDs / nothing. Useful for scripting.
    #[arg(long, global = true)]
    pub quiet: bool,

    /// Override the data directory (default: ~/helmor or ~/helmor-dev).
    #[arg(long, global = true, value_name = "DIR")]
    pub data_dir: Option<String>,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Data directory, database, and mode info.
    Data {
        #[command(subcommand)]
        action: DataAction,
    },
    /// App settings stored in `settings` table.
    Settings {
        #[command(subcommand)]
        action: SettingsAction,
    },
    /// Repository registration and configuration.
    Repo {
        #[command(subcommand)]
        action: RepoAction,
    },
    /// Workspace CRUD, branching, syncing, archiving.
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
    },
    /// Session CRUD and inspection.
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// File listing, reading, writing, staging (editor surface).
    Files {
        #[command(subcommand)]
        action: FilesAction,
    },
    /// Send a prompt to an AI agent.
    Send(SendArgs),
    /// List available AI models.
    Models {
        #[command(subcommand)]
        action: ModelsAction,
    },
    /// GitHub integration — auth, PR lookup, merge.
    Github {
        #[command(subcommand)]
        action: GithubAction,
    },
    /// Inspect repo-level setup/run/archive scripts.
    Scripts {
        #[command(subcommand)]
        action: ScriptsAction,
    },
    /// Migrate from Helmor v1 (Conductor).
    Conductor {
        #[command(subcommand)]
        action: ConductorAction,
    },
    /// Shell completion scripts.
    Completions {
        #[arg(value_enum)]
        shell: CompletionShell,
    },
    /// Report whether the current Helmor CLI entrypoint is installed to PATH and which data mode it uses.
    CliStatus,
    /// Ask a running Helmor app to quit (noop when it isn't running).
    Quit,
    /// Run as an MCP (Model Context Protocol) server over stdio.
    Mcp,
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum DataAction {
    /// Print data directory / database path / mode.
    Info,
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum SettingsAction {
    /// Read a single setting value by key.
    Get { key: String },
    /// Set a setting key to a string value.
    Set { key: String, value: String },
    /// List settings. Defaults to `app.*` and `branch_prefix_*`; pass
    /// `--all` for every key.
    List {
        #[arg(long)]
        all: bool,
    },
    /// Delete a setting key.
    Delete { key: String },
}

// ---------------------------------------------------------------------------
// repo
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum RepoAction {
    /// List all registered repositories.
    List,
    /// Show details for a single repository.
    Show {
        #[arg(name = "ref")]
        repo_ref: String,
    },
    /// Register a Git repository at `<path>`. Creates the first workspace.
    Add { path: String },
    /// Delete a repository and all its workspaces, sessions, messages.
    Delete {
        #[arg(name = "ref")]
        repo_ref: String,
    },
    /// Change the default branch saved in the Helmor DB.
    DefaultBranch {
        #[arg(name = "ref")]
        repo_ref: String,
        branch: String,
    },
    /// Change the remote name (also re-resolves default branch).
    Remote {
        #[arg(name = "ref")]
        repo_ref: String,
        remote: String,
    },
    /// List git remotes for this repository.
    Remotes {
        #[arg(name = "ref")]
        repo_ref: String,
    },
    /// Show saved setup/run/archive scripts for a repository.
    Scripts {
        #[arg(name = "ref")]
        repo_ref: String,
        /// Optional workspace_id — scripts resolve from that workspace's
        /// `helmor.json` when present.
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Update one or more repo scripts. Unspecified flags keep their value.
    UpdateScripts {
        #[arg(name = "ref")]
        repo_ref: String,
        #[arg(long)]
        setup: Option<String>,
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        archive: Option<String>,
        /// Clear a script back to NULL (repeatable).
        #[arg(long, value_name = "KIND")]
        clear: Vec<String>,
    },
    /// Show saved per-repo prompt preferences.
    Prefs {
        #[arg(name = "ref")]
        repo_ref: String,
    },
    /// Update custom prompt preferences for a repository.
    UpdatePrefs {
        #[arg(name = "ref")]
        repo_ref: String,
        #[arg(long)]
        create_pr: Option<String>,
        #[arg(long)]
        fix_errors: Option<String>,
        #[arg(long)]
        resolve_conflicts: Option<String>,
        #[arg(long)]
        branch_rename: Option<String>,
        #[arg(long)]
        general: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum WorkspaceAction {
    /// List active workspaces grouped by status.
    #[command(after_help = EXAMPLES_WORKSPACE_LIST)]
    List {
        /// Show archived workspaces instead.
        #[arg(long)]
        archived: bool,
        /// Filter by status (done, review, progress, backlog, canceled).
        #[arg(long)]
        status: Option<String>,
        /// Only list workspaces in the given repo.
        #[arg(long = "repo")]
        repo_ref: Option<String>,
        /// Only list pinned workspaces.
        #[arg(long)]
        pinned: bool,
    },
    /// Show details for a single workspace.
    Show {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Create a new workspace for an existing repository.
    #[command(after_help = EXAMPLES_WORKSPACE_NEW)]
    New {
        /// Repo name or UUID.
        #[arg(long)]
        repo: String,
    },
    /// Permanently delete a workspace (DB rows + git worktree + files).
    Delete {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Archive a workspace — removes the worktree and preserves restore metadata.
    Archive {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Restore a previously archived workspace.
    Restore {
        #[arg(name = "ref")]
        workspace_ref: String,
        /// Override the target branch used for restoration.
        #[arg(long)]
        target_branch: Option<String>,
    },
    /// Show git action status for a workspace (ahead/behind/conflicts).
    Status {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Pin a workspace to the top of the sidebar.
    Pin {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Unpin a workspace.
    Unpin {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Mark a workspace read / unread.
    Mark {
        #[arg(value_enum)]
        state: ReadState,
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Manage the workspace sidebar status.
    SetStatus {
        #[command(subcommand)]
        action: WorkspaceStatusAction,
    },
    /// Branch operations scoped to a workspace.
    Branch {
        #[command(subcommand)]
        action: BranchAction,
    },
    /// Get / set the intended target branch for merges.
    TargetBranch {
        #[command(subcommand)]
        action: TargetBranchAction,
    },
    /// Merge the target branch into this workspace.
    Sync {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Push the workspace's branch to its remote.
    Push {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Prefetch remote refs so the branch picker is current.
    Fetch {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Linked `/add-dir` directories.
    LinkedDirs {
        #[command(subcommand)]
        action: LinkedDirsAction,
    },
    /// Run a ship-flow action against a workspace.
    ///
    /// `merge-pr` and `pull-latest` execute inline. The four
    /// agent-dispatched actions (`commit-and-push`, `create-pr`,
    /// `fix-errors`, `resolve-conflicts`) create a dedicated action
    /// session, queue the same prompt/settings the GUI uses, and return
    /// once the message is queued, not when the agent finishes.
    #[command(after_help = EXAMPLES_WORKSPACE_RUN_ACTION)]
    RunAction {
        #[arg(name = "ref")]
        workspace_ref: String,
        #[arg(value_enum)]
        action: WorkspaceShipAction,
    },
}

#[derive(ValueEnum, Clone, Copy, Debug)]
#[clap(rename_all = "kebab-case")]
pub enum WorkspaceShipAction {
    /// Merge the workspace's open change request via the configured forge.
    MergePr,
    /// Rebase / merge the workspace's target branch into it.
    PullLatest,
    /// Dispatch a "commit + push" prompt to the workspace agent.
    CommitAndPush,
    /// Dispatch a "create PR" prompt to the workspace agent.
    CreatePr,
    /// Dispatch a "fix errors" prompt to the workspace agent.
    FixErrors,
    /// Dispatch a "resolve conflicts" prompt to the workspace agent.
    ResolveConflicts,
}

#[derive(Subcommand)]
pub enum WorkspaceStatusAction {
    /// Set the workspace status.
    Set {
        #[arg(value_enum)]
        status: WorkspaceStatusValue,
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Reset the workspace status to progress.
    Clear {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
}

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum WorkspaceStatusValue {
    Done,
    Review,
    Progress,
    Backlog,
    Canceled,
}

#[derive(Subcommand)]
pub enum BranchAction {
    /// List remote branches available for this workspace.
    List {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Rename the workspace's current branch.
    Rename {
        #[arg(name = "ref")]
        workspace_ref: String,
        new_branch: String,
    },
}

#[derive(Subcommand)]
pub enum TargetBranchAction {
    /// Print the intended target branch.
    Get {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Update the intended target branch.
    Set {
        #[arg(name = "ref")]
        workspace_ref: String,
        branch: String,
    },
}

#[derive(Subcommand)]
pub enum LinkedDirsAction {
    /// List linked directories.
    List {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Replace the linked-directory list.
    Set {
        #[arg(name = "ref")]
        workspace_ref: String,
        directories: Vec<String>,
    },
    /// Add a directory to the existing list.
    Add {
        #[arg(name = "ref")]
        workspace_ref: String,
        directory: String,
    },
    /// Remove a directory from the existing list.
    Remove {
        #[arg(name = "ref")]
        workspace_ref: String,
        directory: String,
    },
    /// List candidate directories suitable for `/add-dir`.
    Candidates {
        /// Exclude a workspace (defaults to none).
        #[arg(long)]
        exclude: Option<String>,
    },
}

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum ReadState {
    Read,
    Unread,
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum SessionAction {
    /// List visible sessions in a workspace.
    List {
        #[arg(long)]
        workspace: String,
    },
    /// List hidden sessions in a workspace.
    Hidden {
        #[arg(long)]
        workspace: String,
    },
    /// Print thread messages for a session.
    Show {
        #[arg(long)]
        workspace: String,
        session: String,
    },
    /// Create a new session.
    New {
        #[arg(long)]
        workspace: String,
        /// Start in plan mode.
        #[arg(long)]
        plan: bool,
        /// Optional action kind (create-pr, commit-and-push, etc.).
        #[arg(long)]
        action_kind: Option<String>,
    },
    /// Rename a session.
    Rename {
        #[arg(long)]
        workspace: String,
        session: String,
        title: String,
    },
    /// Delete a session and all its messages.
    Delete {
        #[arg(long)]
        workspace: String,
        session: String,
    },
    /// Hide a session.
    Hide {
        #[arg(long)]
        workspace: String,
        session: String,
    },
    /// Unhide a session.
    Unhide {
        #[arg(long)]
        workspace: String,
        session: String,
    },
    /// Mark a session read / unread.
    Mark {
        #[arg(long)]
        workspace: String,
        #[arg(value_enum)]
        state: ReadState,
        session: String,
    },
    /// Update per-session settings (model, effort, permission mode).
    UpdateSettings {
        #[arg(long)]
        workspace: String,
        session: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        effort: Option<String>,
        #[arg(long)]
        permission_mode: Option<String>,
    },
    /// Search sessions across all workspaces by title / message content.
    ///
    /// Pass `--query`, `--status`, or both. At least one is required.
    #[command(after_help = EXAMPLES_SESSION_SEARCH)]
    Search {
        /// Case-insensitive substring matched against session title and
        /// message bodies. Optional if `--status` is set.
        #[arg(long)]
        query: Option<String>,
        /// Restrict to a single repo (UUID or name).
        #[arg(long)]
        repo: Option<String>,
        /// Filter by stored session status (e.g. `streaming`, `idle`).
        #[arg(long)]
        status: Option<String>,
        /// Include sessions in archived workspaces.
        #[arg(long)]
        include_archived: bool,
        /// Max rows to return (1-20, default 8).
        #[arg(long, default_value_t = 8)]
        limit: u32,
    },
    /// Fetch a windowed slice of messages from a session.
    ///
    /// Output is a JSON array (one entry per message) with each body
    /// char-bounded by `--body-limit`. Use `--position head` for the
    /// oldest messages, `--position tail` (default) for the newest.
    #[command(after_help = EXAMPLES_SESSION_GET_MESSAGES)]
    GetMessages {
        /// Session UUID (from `session list` or `session search`).
        session: String,
        /// How many messages to return (1-20, default 5).
        #[arg(long, default_value_t = 5)]
        limit: u32,
        /// Where in the session the window starts.
        #[arg(long, value_enum, default_value_t = SessionWindowPosition::Tail)]
        position: SessionWindowPosition,
        /// Per-message body char cap (1-4000, default 800).
        #[arg(long, default_value_t = 800)]
        body_limit: u32,
        /// Which slice of each body to return when it overflows
        /// `--body-limit`.
        #[arg(long, value_enum, default_value_t = SessionBodyPosition::Start)]
        body_position: SessionBodyPosition,
    },
}

#[derive(ValueEnum, Clone, Copy, Debug)]
#[clap(rename_all = "kebab-case")]
pub enum SessionWindowPosition {
    /// Oldest messages first.
    Head,
    /// Newest messages first.
    Tail,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
#[clap(rename_all = "kebab-case")]
pub enum SessionBodyPosition {
    /// Body slice starts at offset 0.
    Start,
    /// Body slice ends at the final character (tail of the message).
    End,
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum FilesAction {
    /// List uncommitted changes in a workspace.
    Changes {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// List files in the workspace (mention-style).
    List {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Print file content. Relative paths resolve against the workspace.
    Show {
        #[arg(name = "ref")]
        workspace_ref: String,
        path: String,
        /// Print the content at a specific git ref instead of working tree.
        #[arg(long)]
        git_ref: Option<String>,
    },
    /// Write content to a file (content read from stdin).
    Write {
        #[arg(name = "ref")]
        workspace_ref: String,
        path: String,
    },
    /// Stage a file (git add).
    Stage {
        #[arg(name = "ref")]
        workspace_ref: String,
        path: String,
    },
    /// Unstage a file (git reset).
    Unstage {
        #[arg(name = "ref")]
        workspace_ref: String,
        path: String,
    },
    /// Discard working-tree changes to a file.
    Discard {
        #[arg(name = "ref")]
        workspace_ref: String,
        path: String,
    },
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

#[derive(Args, Debug, Clone)]
#[command(after_help = EXAMPLES_SEND)]
pub struct SendArgs {
    /// Workspace UUID or repo-name/dir-name.
    #[arg(long)]
    pub workspace: String,
    /// Session UUID. Defaults to the workspace's active session.
    #[arg(long)]
    pub session: Option<String>,
    /// Model ID (default: configured default, else `default`).
    #[arg(long)]
    pub model: Option<String>,
    /// Permission mode (plan, auto, yolo, default).
    #[arg(long)]
    pub permission_mode: Option<String>,
    /// Shortcut for `--permission-mode plan`.
    #[arg(long, conflicts_with = "permission_mode")]
    pub plan: bool,
    /// Add a `/add-dir`-style linked directory (repeatable).
    #[arg(long = "linked-dir", value_name = "DIR")]
    pub linked_dirs: Vec<String>,
    /// Prompt text. Use `-` to read from stdin.
    pub prompt: String,
}

#[derive(Subcommand)]
pub enum ModelsAction {
    /// List model catalog (Claude + Codex sections).
    List,
}

// ---------------------------------------------------------------------------
// github
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum GithubAction {
    /// Pull request operations for a workspace.
    Pr {
        #[command(subcommand)]
        action: GithubPrAction,
    },
}

#[derive(Subcommand)]
pub enum GithubPrAction {
    /// Show the PR linked to this workspace.
    Show {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// CI / action status for the workspace's PR.
    Status {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Merge the workspace's PR.
    Merge {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Close (without merging) the workspace's PR.
    Close {
        #[arg(name = "ref")]
        workspace_ref: String,
    },
}

// ---------------------------------------------------------------------------
// scripts
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum ScriptsAction {
    /// Show effective setup/run/archive scripts.
    Show {
        #[arg(name = "ref")]
        repo_ref: String,
        #[arg(long)]
        workspace: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// conductor
// ---------------------------------------------------------------------------

#[derive(Subcommand)]
pub enum ConductorAction {
    /// Report whether a Conductor data source is available locally.
    Status,
    /// List repositories discovered in the Conductor data source.
    Repos,
    /// List workspaces discovered in the Conductor data source.
    Workspaces,
}

// ---------------------------------------------------------------------------
// completions
// ---------------------------------------------------------------------------

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum CompletionShell {
    Bash,
    Zsh,
    Fish,
    Powershell,
    Elvish,
}
