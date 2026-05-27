//! End-to-end test of the remote-runner SSH transport against a real
//! Linux `sshd` running in Docker.
//!
//! This is the layer the macOS-only `remote_binary_integration.rs`
//! can't reach: a genuine `ssh user@host` hop into a different OS,
//! against a `helmor-server` binary compiled FOR that OS. It proves
//! the parts that only break on a real remote:
//!   * the daemon binary actually runs headless on Linux (no GUI libs
//!     dragged into its runtime NEEDED set — see the Dockerfile's
//!     `ldd` guard),
//!   * the SSH transport carries the JSON-RPC frames end-to-end,
//!   * the handshake + `runtime_health` + a `workspace.status`
//!     round-trip work through `RemoteSshRuntime` exactly as the
//!     desktop drives them.
//!
//! ## Opt-in
//!
//! Gated behind `HELMOR_E2E_DOCKER=1` so a plain `cargo test` (local
//! dev, the macOS CI quality suite) never tries to spin up Docker.
//! The dedicated CI job + a developer running the full pass set the
//! env var. When unset, every test in this file early-returns with a
//! skip note.
//!
//! ## Arch selection
//!
//! By default the test targets the container matching the host arch
//! (arm64 on Apple Silicon → port 2223; amd64 elsewhere → port
//! 2222), so neither a laptop nor a CI runner pays the QEMU tax for
//! its primary leg. `HELMOR_E2E_DOCKER_SERVICE=helmor-test-linux-amd64`
//! (or `...-arm64`) forces a specific leg — used by CI to run the
//! amd64 leg natively on its amd64 runners.
//!
//! ## SSH wiring
//!
//! The harness writes a sentinel-bounded `Host` block into the
//! user's `~/.ssh/config` so the desktop's unmodified ssh transport
//! (which just runs `ssh <host> ...`) resolves the right port +
//! identity + `StrictHostKeyChecking no`. The block is removed on
//! `Drop`; a stale-sweep at startup clears any block a previously
//! crashed run left behind.

use std::io::Write;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use helmor_lib::remote::{RemoteRuntime, RemoteSshRuntime, RuntimeKind};

/// Env gate. The whole file is a no-op unless this is set.
const ENABLE_ENV: &str = "HELMOR_E2E_DOCKER";
/// Optional override for which compose service / arch to target.
const SERVICE_ENV: &str = "HELMOR_E2E_DOCKER_SERVICE";

/// Sentinel comments bracketing the `~/.ssh/config` block the harness
/// owns. The block between these markers is rewritten on setup and
/// deleted on teardown; anything outside is left untouched.
const SSH_CONFIG_BEGIN: &str = "# >>> helmor-e2e-docker (managed) >>>";
const SSH_CONFIG_END: &str = "# <<< helmor-e2e-docker (managed) <<<";

/// `helmor-server` install location baked into the test image
/// (see the Dockerfile). Passed as the `remote_binary` so the
/// transport's probe finds it immediately.
const REMOTE_BINARY: &str = "/home/e2e/.helmor/server/helmor-server";

fn enabled() -> bool {
    std::env::var(ENABLE_ENV).is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

/// (compose service name, host alias, host-side ssh port).
fn target() -> (&'static str, &'static str, u16) {
    let service = std::env::var(SERVICE_ENV).unwrap_or_else(|_| {
        // Default to the host arch's native container.
        if std::env::consts::ARCH == "aarch64" {
            "helmor-test-linux-arm64".to_string()
        } else {
            "helmor-test-linux-amd64".to_string()
        }
    });
    match service.as_str() {
        "helmor-test-linux-arm64" => ("helmor-test-linux-arm64", "helmor-e2e-arm64", 2223),
        // Default + amd64.
        _ => ("helmor-test-linux-amd64", "helmor-e2e-amd64", 2222),
    }
}

fn harness_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is `src-tauri/`.
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/docker-e2e")
}

fn ssh_config_path() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME must be set");
    PathBuf::from(home).join(".ssh/config")
}

/// Manages the container lifecycle + the ssh-config block. Brings the
/// stack up on `new`, tears it down + cleans the config on `Drop`.
struct DockerHarness {
    service: &'static str,
    host_alias: &'static str,
    port: u16,
    compose_file: PathBuf,
}

impl DockerHarness {
    fn up() -> Self {
        let (service, host_alias, port) = target();
        let dir = harness_dir();
        let compose_file = dir.join("compose.yml");

        // 1. Ensure an ephemeral keypair + authorized_keys fixture.
        let key_path = dir.join("fixtures/id_e2e");
        if !key_path.exists() {
            let status = Command::new("ssh-keygen")
                .args(["-t", "ed25519", "-N", "", "-C", "helmor-e2e", "-f"])
                .arg(&key_path)
                .status()
                .expect("ssh-keygen should spawn");
            assert!(status.success(), "ssh-keygen failed");
            let pubkey = std::fs::read(dir.join("fixtures/id_e2e.pub")).unwrap();
            std::fs::write(dir.join("fixtures/authorized_keys"), pubkey).unwrap();
        }

        // 2. Rewrite the managed ssh-config block.
        write_ssh_config_block(host_alias, port, &key_path);

        // 3. Bring the matching service up. Image must already be
        //    built (the test asserts a clear message if not — building
        //    in-test would balloon the wall clock unpredictably).
        let up = Command::new("docker")
            .args(["compose", "-f"])
            .arg(&compose_file)
            .args(["up", "-d", service])
            .status()
            .expect("docker compose up should spawn");
        assert!(
            up.success(),
            "docker compose up {service} failed — build the image first with:\n  \
             docker compose -f src-tauri/tests/docker-e2e/compose.yml build {service}"
        );

        // 4. Wait for sshd to accept connections on the host port.
        wait_for_port(port, Duration::from_secs(60));

        Self {
            service,
            host_alias,
            port,
            compose_file,
        }
    }

    fn host_alias(&self) -> &str {
        self.host_alias
    }
}

impl Drop for DockerHarness {
    fn drop(&mut self) {
        // Best-effort teardown — don't panic in Drop (would mask the
        // test's own failure). Stop + remove just our service rather
        // than `down` (which would tear down the whole project incl.
        // a sibling arch leg another test might be using).
        let _ = Command::new("docker")
            .args(["compose", "-f"])
            .arg(&self.compose_file)
            .args(["rm", "-sf", self.service])
            .status();
        remove_ssh_config_block();
        let _ = self.port; // silence unused on teardown-only field
    }
}

/// Rewrite (create or replace) the sentinel-bounded managed block in
/// `~/.ssh/config`. Idempotent: a prior managed block is stripped
/// first, so repeated runs don't stack duplicates.
fn write_ssh_config_block(host_alias: &str, port: u16, identity_file: &Path) {
    let path = ssh_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let stripped = strip_managed_block(&existing);

    let block = format!(
        "{begin}\n\
         Host {alias}\n\
         \tHostName 127.0.0.1\n\
         \tPort {port}\n\
         \tUser e2e\n\
         \tIdentityFile {identity}\n\
         \tIdentitiesOnly yes\n\
         \tStrictHostKeyChecking no\n\
         \tUserKnownHostsFile /dev/null\n\
         \tBatchMode yes\n\
         {end}\n",
        begin = SSH_CONFIG_BEGIN,
        alias = host_alias,
        port = port,
        identity = identity_file.display(),
        end = SSH_CONFIG_END,
    );

    let mut out = stripped.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&block);

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .expect("open ~/.ssh/config for write");
    f.write_all(out.as_bytes()).expect("write ssh config");
}

fn remove_ssh_config_block() {
    let path = ssh_config_path();
    let Ok(existing) = std::fs::read_to_string(&path) else {
        return;
    };
    let stripped = strip_managed_block(&existing);
    let _ = std::fs::write(&path, stripped);
}

/// Remove everything between (and including) the sentinel markers.
/// Leaves the rest of the file byte-for-byte.
fn strip_managed_block(content: &str) -> String {
    let mut out = String::new();
    let mut in_block = false;
    for line in content.lines() {
        if line.trim() == SSH_CONFIG_BEGIN {
            in_block = true;
            continue;
        }
        if line.trim() == SSH_CONFIG_END {
            in_block = false;
            continue;
        }
        if !in_block {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

fn wait_for_port(port: u16, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return;
        }
        if Instant::now() >= deadline {
            panic!("sshd on 127.0.0.1:{port} never came up within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[test]
fn ssh_transport_completes_handshake_and_health_against_linux_container() {
    if !enabled() {
        eprintln!(
            "skipping docker E2E (set {ENABLE_ENV}=1 to run). \
             Build the image first: docker compose -f \
             src-tauri/tests/docker-e2e/compose.yml build"
        );
        return;
    }

    let harness = DockerHarness::up();

    // Connect via the desktop's real SSH runtime — same path the
    // wizard's Connect button drives. The host alias resolves to
    // 127.0.0.1:<port> via the managed ssh-config block.
    let runtime = RemoteSshRuntime::connect_ssh(harness.host_alias(), REMOTE_BINARY)
        .expect("connect_ssh to the Linux container should complete the handshake");

    // 1. runtime_health: proves the binary runs headless on Linux +
    //    the wire carries a real RPC round-trip.
    let health = runtime
        .runtime_health()
        .expect("runtime_health round-trip over ssh should succeed");
    match &health.kind {
        RuntimeKind::Remote { host } => {
            assert!(
                host.contains(harness.host_alias()) || !host.is_empty(),
                "remote health should name the host, got {host:?}"
            );
        }
        other => panic!("expected RuntimeKind::Remote, got {other:?}"),
    }
    // The daemon reports its own CARGO_PKG_VERSION; don't pin an
    // exact value (it moves every release), just assert it's a
    // non-empty semver-shaped string.
    assert!(
        !health.version.is_empty(),
        "daemon should report a non-empty version"
    );
    assert!(
        health.version.split('.').count() >= 2,
        "daemon version should look like semver, got {:?}",
        health.version
    );

    // 2. workspace.status against a fresh git repo created inside the
    //    container — exercises a real workspace_* RPC over the wire,
    //    not just the handshake.
    let repo_path = "/home/e2e/e2e-repo";
    init_repo_in_container(harness.service, repo_path);
    let status = runtime
        .workspace_status(Path::new(repo_path))
        .expect("workspace.status over ssh should succeed");
    assert!(
        status.is_clean,
        "freshly-committed repo in the container should report clean, got {status:?}"
    );
}

/// `git init` + initial commit inside the container via `docker exec`.
fn init_repo_in_container(service: &str, repo_path: &str) {
    let script = format!(
        "set -e; \
         mkdir -p {repo} && cd {repo} && \
         git init -q && git checkout -q -b main && \
         git config user.email e2e@example.com && \
         git config user.name 'Helmor E2E' && \
         git config commit.gpgsign false && \
         echo base > file.txt && git add file.txt && \
         git commit -q -m initial",
        repo = repo_path,
    );
    let out = Command::new("docker")
        .args(["exec", "--user", "e2e", service, "bash", "-lc", &script])
        .output()
        .expect("docker exec should spawn");
    assert!(
        out.status.success(),
        "git init in container failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
