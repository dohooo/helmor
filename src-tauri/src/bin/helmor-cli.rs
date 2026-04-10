//! helmor CLI — workspace and session management from the terminal.
//!
//! Reuses the same Rust domain logic as the Tauri GUI, reading from / writing
//! to the same SQLite database and worktree layout.
//!
//! Cargo binary name is `helmor-cli` (to avoid conflicting with the Tauri GUI
//! binary). The install process copies it as `helmor` to the user's PATH.

use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use helmor_lib::agents::AgentStreamEvent;
use helmor_lib::pipeline::types::{ExtendedMessagePart, MessagePart};
use helmor_lib::service;

// ---------------------------------------------------------------------------
// CLI argument definitions
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(name = "helmor", about = "Helmor workspace & session CLI")]
struct Cli {
    /// Output as JSON instead of human-readable text
    #[arg(long, global = true)]
    json: bool,

    /// Override the data directory (default: ~/helmor or ~/helmor-dev)
    #[arg(long, global = true)]
    data_dir: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Data directory info
    Data {
        #[command(subcommand)]
        action: DataAction,
    },
    /// Repository management
    Repo {
        #[command(subcommand)]
        action: RepoAction,
    },
    /// Workspace management
    Workspace {
        #[command(subcommand)]
        action: WorkspaceAction,
    },
    /// Session management
    Session {
        #[command(subcommand)]
        action: SessionAction,
    },
    /// Send a prompt to an AI agent
    Send {
        /// Workspace UUID or repo-name/directory-name
        #[arg(long)]
        workspace: String,
        /// Session UUID (default: active session)
        #[arg(long)]
        session: Option<String>,
        /// Model ID (default: opus-1m)
        #[arg(long)]
        model: Option<String>,
        /// The prompt to send
        prompt: String,
    },
    /// Run as MCP (Model Context Protocol) server over stdio
    Mcp,
}

#[derive(Subcommand)]
enum DataAction {
    /// Show data directory, database path, and mode
    Info,
}

#[derive(Subcommand)]
enum RepoAction {
    /// List known repositories
    List,
    /// Register a local Git repository (creates first workspace automatically)
    Add {
        /// Path to the repository root
        path: String,
    },
}

#[derive(Subcommand)]
enum WorkspaceAction {
    /// List active workspaces grouped by status
    List,
    /// Show details for a workspace
    Show {
        /// Workspace UUID or repo-name/directory-name
        #[arg(name = "ref")]
        workspace_ref: String,
    },
    /// Create a new workspace for a repository
    New {
        /// Repository UUID or name
        #[arg(long)]
        repo: String,
    },
}

#[derive(Subcommand)]
enum SessionAction {
    /// List sessions in a workspace
    List {
        /// Workspace UUID or repo-name/directory-name
        #[arg(long)]
        workspace: String,
    },
    /// Create a new session in a workspace
    New {
        /// Workspace UUID or repo-name/directory-name
        #[arg(long)]
        workspace: String,
    },
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() -> ExitCode {
    let cli = Cli::parse();

    if let Some(ref dir) = cli.data_dir {
        // SAFETY: called in main() before any threads are spawned.
        unsafe { std::env::set_var("HELMOR_DATA_DIR", dir) };
    }

    match run(&cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            if cli.json {
                let msg = serde_json::json!({ "error": format!("{e:#}") });
                eprintln!("{msg}");
            } else {
                eprintln!("error: {e:#}");
            }
            ExitCode::FAILURE
        }
    }
}

fn run(cli: &Cli) -> Result<()> {
    helmor_lib::data_dir::ensure_directory_structure()?;

    let db_path = helmor_lib::data_dir::db_path()?;
    let conn = rusqlite::Connection::open(&db_path)
        .with_context(|| format!("Failed to open database at {db_path:?}"))?;
    helmor_lib::schema_init(&conn);
    drop(conn);

    match &cli.command {
        Commands::Data { action } => match action {
            DataAction::Info => cmd_data_info(cli.json),
        },
        Commands::Repo { action } => match action {
            RepoAction::List => cmd_repo_list(cli.json),
            RepoAction::Add { path } => cmd_repo_add(path, cli.json),
        },
        Commands::Workspace { action } => match action {
            WorkspaceAction::List => cmd_workspace_list(cli.json),
            WorkspaceAction::Show { workspace_ref } => cmd_workspace_show(workspace_ref, cli.json),
            WorkspaceAction::New { repo } => cmd_workspace_new(repo, cli.json),
        },
        Commands::Session { action } => match action {
            SessionAction::List { workspace } => cmd_session_list(workspace, cli.json),
            SessionAction::New { workspace } => cmd_session_new(workspace, cli.json),
        },
        Commands::Send {
            workspace,
            session,
            model,
            prompt,
        } => cmd_send(workspace, session.clone(), prompt, model.clone(), cli.json),
        Commands::Mcp => helmor_lib::mcp::run_mcp_server(),
    }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

fn cmd_data_info(json: bool) -> Result<()> {
    let info = service::get_data_info()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&info)?);
    } else {
        println!("Mode:     {}", info.data_mode);
        println!("Data dir: {}", info.data_dir);
        println!("Database: {}", info.db_path);
    }
    Ok(())
}

fn cmd_repo_list(json: bool) -> Result<()> {
    let repos = service::list_repositories()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&repos)?);
    } else if repos.is_empty() {
        println!("No repositories.");
    } else {
        for repo in &repos {
            println!("{}\t{}", repo.id, repo.name);
        }
    }
    Ok(())
}

fn cmd_repo_add(path: &str, json: bool) -> Result<()> {
    let response = service::add_repository_from_local_path(path)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&response)?);
    } else {
        if response.created_repository {
            println!("Created repository {}", response.repository_id);
        } else {
            println!("Repository already exists: {}", response.repository_id);
        }
        if let Some(ref ws_id) = response.created_workspace_id {
            println!("Created workspace  {ws_id}");
        }
        println!("Selected workspace {}", response.selected_workspace_id);
    }
    Ok(())
}

fn cmd_workspace_list(json: bool) -> Result<()> {
    let groups = service::list_workspace_groups()?;
    if json {
        println!("{}", serde_json::to_string_pretty(&groups)?);
    } else {
        let mut any = false;
        for group in &groups {
            if group.rows.is_empty() {
                continue;
            }
            any = true;
            println!("{}:", group.label);
            for row in &group.rows {
                println!(
                    "  {}/{}\t{}\t{}",
                    row.repo_name, row.directory_name, row.id, row.derived_status
                );
            }
        }
        if !any {
            println!("No workspaces.");
        }
    }
    Ok(())
}

fn cmd_workspace_show(workspace_ref: &str, json: bool) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let detail = service::get_workspace(&workspace_id)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&detail)?);
    } else {
        println!("ID:        {}", detail.id);
        println!("Title:     {}", detail.title);
        println!("Repo:      {}", detail.repo_name);
        println!("Directory: {}", detail.directory_name);
        println!("State:     {}", detail.state);
        println!("Branch:    {}", detail.branch.as_deref().unwrap_or("-"));
        println!("Status:    {}", detail.derived_status);
        if let Some(ref pr) = detail.pr_title {
            println!("PR:        {pr}");
        }
        println!("Sessions:  {}", detail.session_count);
        println!("Messages:  {}", detail.message_count);
    }
    Ok(())
}

fn cmd_workspace_new(repo_ref: &str, json: bool) -> Result<()> {
    let repo_id = service::resolve_repo_ref(repo_ref)?;
    let response = service::create_workspace_from_repo_impl(&repo_id)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&response)?);
    } else {
        println!("Created workspace: {}", response.created_workspace_id);
        println!("Directory:         {}", response.directory_name);
        println!("Branch:            {}", response.branch);
        println!("State:             {}", response.created_state);
    }
    Ok(())
}

fn cmd_session_list(workspace_ref: &str, json: bool) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let sessions = service::list_workspace_sessions(&workspace_id)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
    } else if sessions.is_empty() {
        println!("No sessions.");
    } else {
        for session in &sessions {
            let active = if session.active { " *" } else { "" };
            println!(
                "{}\t{}\t{}{}",
                session.id, session.title, session.status, active
            );
        }
    }
    Ok(())
}

fn cmd_session_new(workspace_ref: &str, json: bool) -> Result<()> {
    let workspace_id = service::resolve_workspace_ref(workspace_ref)?;
    let response = service::create_session(&workspace_id, None)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&response)?);
    } else {
        println!("Created session: {}", response.session_id);
    }
    Ok(())
}

fn cmd_send(
    workspace: &str,
    session: Option<String>,
    prompt: &str,
    model: Option<String>,
    json: bool,
) -> Result<()> {
    use std::io::Write;

    let params = service::SendMessageParams {
        workspace_ref: workspace.to_string(),
        session_id: session,
        prompt: prompt.to_string(),
        model,
        permission_mode: Some("auto".to_string()),
    };

    let mut stdout = std::io::stdout().lock();

    let result = service::send_message(params, &mut |event| {
        if json {
            if let Ok(line) = serde_json::to_string(event) {
                let _ = writeln!(stdout, "{line}");
                let _ = stdout.flush();
            }
            return;
        }

        match event {
            AgentStreamEvent::StreamingPartial { message } => {
                for part in &message.content {
                    if let ExtendedMessagePart::Basic(MessagePart::Text { text }) = part {
                        let _ = write!(stdout, "{text}");
                        let _ = stdout.flush();
                    }
                }
            }
            AgentStreamEvent::Done {
                provider,
                resolved_model,
                session_id,
                ..
            } => {
                let _ = writeln!(stdout);
                let _ = writeln!(stdout, "---");
                let _ = writeln!(
                    stdout,
                    "Done ({provider}/{resolved_model}) session={}",
                    session_id.as_deref().unwrap_or("-")
                );
            }
            AgentStreamEvent::Aborted { reason, .. } => {
                let _ = writeln!(stdout);
                let _ = writeln!(stdout, "---");
                let _ = writeln!(stdout, "Aborted: {reason}");
            }
            AgentStreamEvent::Error { message, .. } => {
                eprintln!("Error: {message}");
            }
            _ => {}
        }
    })?;

    if !json {
        eprintln!(
            "[session: {} | model: {}/{}]",
            result.session_id, result.provider, result.model
        );
    }

    Ok(())
}
