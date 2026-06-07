//! Local IPC socket boundary.

use std::io;
use std::path::Path;

#[cfg(unix)]
pub type LocalListener = std::os::unix::net::UnixListener;

#[cfg(unix)]
pub type LocalStream = std::os::unix::net::UnixStream;

#[cfg(unix)]
pub fn bind_listener(path: &Path) -> io::Result<LocalListener> {
    LocalListener::bind(path)
}

#[cfg(unix)]
pub fn connect(path: &Path) -> io::Result<LocalStream> {
    LocalStream::connect(path)
}
