//! Clap argument definitions for every installed Helmor CLI subcommand.
//!
//! Split out from `mod.rs` so dispatch logic and argument schema evolve
//! independently — adding a new flag only touches this file plus the
//! command body.

use clap::{Args, Parser, Subcommand, ValueEnum};

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
