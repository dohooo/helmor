// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `helmor serve` runs the headless companion host (windowless Wry); any
    // other invocation (including none) launches the desktop GUI. The richer
    // `helmor` CLI lives in a separate binary; this fork is intentionally a
    // single positional check so the GUI launch path stays untouched.
    let is_serve = std::env::args_os()
        .nth(1)
        .map(|arg| arg.to_str() == Some("serve"))
        .unwrap_or(false);
    if is_serve {
        helmor_lib::serve();
    } else {
        helmor_lib::run();
    }
}
