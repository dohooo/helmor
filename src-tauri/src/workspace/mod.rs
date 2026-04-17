pub(crate) mod archive;
pub(crate) mod branching;
pub mod files;
pub mod helpers;
pub(crate) mod lifecycle;
pub mod workspaces;

// The Unix script runner uses openpty/setsid/TIOCSCTTY/killpg which have no
// direct Windows equivalent. On Windows we use a cmd.exe /C + piped-stdio
// implementation that covers the vast majority of setup/run-script use
// cases without the complexity of a full ConPTY port. Known limitation:
// grandchild processes may leak on kill() because we do not attach a
// Windows Job Object — documented follow-up work.
#[cfg(unix)]
pub mod scripts;

#[cfg(not(unix))]
#[path = "scripts_windows.rs"]
pub mod scripts;
