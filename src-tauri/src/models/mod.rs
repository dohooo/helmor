pub mod db;
pub mod repos;
pub mod sessions;
pub mod settings;
pub mod workspaces;

// Keep the models namespace focused on persistence-facing code. Workflow and
// integration logic live in sibling domain modules (`workspace`, `github`,
// `git`, `commands`).
