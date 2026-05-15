//! Runtime registry — the lookup table the command layer consults
//! when deciding which [`RemoteRuntime`] to dispatch a call to.
//!
//! Today the registry holds:
//!
//! - One built-in [`LocalRuntime`] entry under the reserved name
//!   `"local"`, registered at registry-construction time.
//! - Zero or more named remotes registered at runtime via
//!   `connect_remote_runtime` (typically an [`super::client::RemoteSshRuntime`]
//!   wrapped in `Arc`).
//!
//! The frontend addresses runtimes by their string name when it
//! invokes a runtime-bound command. `None` / `"local"` route to
//! the local entry; any other name does a registry lookup.
//!
//! The registry is shared via [`tauri::State`] so every command
//! reads the same `Arc<RuntimeRegistry>`. Concurrent `connect` /
//! `disconnect` while another thread is dispatching a call is
//! intentionally safe — the lookup clones the `Arc` out of the
//! map and releases the lock before invoking the trait method,
//! so a `disconnect` doesn't unblock until in-flight calls return
//! (the inner `Arc` keeps the runtime alive).

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use anyhow::{anyhow, bail, Result};

use super::runtime::{LocalRuntime, RemoteRuntime};

/// Reserved name for the built-in local runtime. Frontend code can
/// pass `"local"` explicitly or omit the name — both route here.
pub const LOCAL_RUNTIME_NAME: &str = "local";

/// Process-wide registry. Held inside `Arc` and exposed via
/// `tauri::State` so the command layer can clone a handle per
/// dispatch without growing a global static.
pub struct RuntimeRegistry {
    local: Arc<dyn RemoteRuntime>,
    remotes: RwLock<HashMap<String, Arc<dyn RemoteRuntime>>>,
}

impl Default for RuntimeRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl RuntimeRegistry {
    /// Build a registry with a fresh [`LocalRuntime`] in the
    /// reserved `"local"` slot. Tests can use [`Self::with_local`]
    /// to inject a stub instead.
    pub fn new() -> Self {
        Self::with_local(Arc::new(LocalRuntime::new()))
    }

    /// Construct with a caller-supplied local runtime. Used by tests
    /// so the reserved slot can be a stub that doesn't shell out
    /// to `uname` or `git`.
    pub fn with_local(local: Arc<dyn RemoteRuntime>) -> Self {
        Self {
            local,
            remotes: RwLock::new(HashMap::new()),
        }
    }

    /// Resolve a runtime by name. `None` and the reserved name
    /// `"local"` both return the local entry. Unknown names return
    /// an error so the command layer can surface "no such remote"
    /// to the UI without panicking.
    pub fn lookup(&self, name: Option<&str>) -> Result<Arc<dyn RemoteRuntime>> {
        match name {
            None | Some("") | Some(LOCAL_RUNTIME_NAME) => Ok(Arc::clone(&self.local)),
            Some(n) => {
                let remotes = self.remotes.read().expect("registry rwlock poisoned");
                remotes
                    .get(n)
                    .cloned()
                    .ok_or_else(|| anyhow!("unknown runtime `{n}`"))
            }
        }
    }

    /// Register a runtime under `name`. Rejects the reserved
    /// `"local"` name (it's owned by the registry itself) and
    /// rejects duplicates so callers have to explicitly disconnect
    /// before reconnecting — that surfaces stale-state bugs
    /// instead of silently shadowing them.
    pub fn register(&self, name: impl Into<String>, runtime: Arc<dyn RemoteRuntime>) -> Result<()> {
        let name = name.into();
        if name.is_empty() {
            bail!("runtime name must not be empty");
        }
        if name == LOCAL_RUNTIME_NAME {
            bail!("`{LOCAL_RUNTIME_NAME}` is reserved for the built-in local runtime");
        }
        let mut remotes = self.remotes.write().expect("registry rwlock poisoned");
        if remotes.contains_key(&name) {
            bail!("runtime `{name}` is already registered; disconnect first to replace it");
        }
        remotes.insert(name, runtime);
        Ok(())
    }

    /// Remove a runtime by name. Returns the removed `Arc` so the
    /// caller can decide whether to drop it immediately (the SSH
    /// child gets killed on drop via [`super::client::RpcClient`]'s
    /// drop impl) or hand it off elsewhere.
    pub fn unregister(&self, name: &str) -> Result<Arc<dyn RemoteRuntime>> {
        if name == LOCAL_RUNTIME_NAME {
            bail!("cannot disconnect the built-in local runtime");
        }
        let mut remotes = self.remotes.write().expect("registry rwlock poisoned");
        remotes
            .remove(name)
            .ok_or_else(|| anyhow!("unknown runtime `{name}`"))
    }

    /// Snapshot of the registered names, sorted alphabetically.
    /// The local runtime is always included as the first entry so
    /// the frontend can render a complete list without special-
    /// casing it.
    pub fn names(&self) -> Vec<String> {
        let remotes = self.remotes.read().expect("registry rwlock poisoned");
        let mut out: Vec<String> = remotes.keys().cloned().collect();
        out.sort();
        let mut all = vec![LOCAL_RUNTIME_NAME.to_string()];
        all.extend(out);
        all
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::runtime::{RuntimeHealth, RuntimeKind};
    use std::path::Path;

    /// Distinguishable stand-in so tests can prove `lookup` returned
    /// the right entry. Each instance carries an opaque tag the test
    /// asserts on after a round-trip through the trait.
    struct TaggedRuntime(&'static str);

    impl RemoteRuntime for TaggedRuntime {
        fn runtime_health(&self) -> Result<RuntimeHealth> {
            Ok(RuntimeHealth {
                kind: RuntimeKind::Local,
                hostname: self.0.to_string(),
                version: "test".to_string(),
            })
        }
        fn workspace_status(
            &self,
            _: &Path,
        ) -> Result<crate::remote::methods::WorkspaceStatusResult> {
            unreachable!("registry tests don't exercise workspace_status")
        }
    }

    fn registry_with_local_tag() -> RuntimeRegistry {
        RuntimeRegistry::with_local(Arc::new(TaggedRuntime("local-tag")))
    }

    #[test]
    fn lookup_none_returns_local_runtime() {
        let registry = registry_with_local_tag();
        let runtime = registry.lookup(None).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().hostname, "local-tag");
    }

    #[test]
    fn lookup_local_name_returns_local_runtime() {
        let registry = registry_with_local_tag();
        let runtime = registry.lookup(Some("local")).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().hostname, "local-tag");
    }

    #[test]
    fn lookup_empty_name_routes_to_local() {
        // Frontend code that sends `""` from an uninitialised input
        // shouldn't accidentally hit "unknown runtime". Treat empty
        // as "no name supplied".
        let registry = registry_with_local_tag();
        let runtime = registry.lookup(Some("")).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().hostname, "local-tag");
    }

    #[test]
    fn lookup_unknown_name_errors() {
        let registry = registry_with_local_tag();
        let err = registry
            .lookup(Some("not-registered"))
            .err()
            .expect("unknown name should error");
        assert!(format!("{err}").contains("not-registered"));
    }

    #[test]
    fn register_and_lookup_round_trip() {
        let registry = registry_with_local_tag();
        registry
            .register("dev.box", Arc::new(TaggedRuntime("dev-box-tag")))
            .unwrap();
        let runtime = registry.lookup(Some("dev.box")).unwrap();
        assert_eq!(runtime.runtime_health().unwrap().hostname, "dev-box-tag");
    }

    #[test]
    fn register_rejects_reserved_local_name() {
        let registry = registry_with_local_tag();
        let err = registry
            .register("local", Arc::new(TaggedRuntime("hijack")))
            .unwrap_err();
        assert!(format!("{err}").contains("reserved"));
    }

    #[test]
    fn register_rejects_empty_name() {
        let registry = registry_with_local_tag();
        let err = registry
            .register("", Arc::new(TaggedRuntime("x")))
            .unwrap_err();
        assert!(format!("{err}").contains("must not be empty"));
    }

    #[test]
    fn register_rejects_duplicate_name_until_disconnected() {
        let registry = registry_with_local_tag();
        registry
            .register("dev.box", Arc::new(TaggedRuntime("first")))
            .unwrap();
        let err = registry
            .register("dev.box", Arc::new(TaggedRuntime("second")))
            .unwrap_err();
        assert!(format!("{err}").contains("already registered"));

        registry.unregister("dev.box").unwrap();
        registry
            .register("dev.box", Arc::new(TaggedRuntime("second")))
            .expect("re-register after disconnect should succeed");
    }

    #[test]
    fn unregister_returns_the_runtime_so_drop_order_is_caller_controlled() {
        let registry = registry_with_local_tag();
        registry
            .register("dev.box", Arc::new(TaggedRuntime("dev-box-tag")))
            .unwrap();
        let removed = registry.unregister("dev.box").unwrap();
        // The removed Arc still works — tests rely on this to inspect
        // a runtime's final state before it goes away.
        assert_eq!(removed.runtime_health().unwrap().hostname, "dev-box-tag");
    }

    #[test]
    fn unregister_refuses_to_drop_the_local_slot() {
        let registry = registry_with_local_tag();
        let err = registry
            .unregister("local")
            .err()
            .expect("local slot must be undroppable");
        assert!(format!("{err}").contains("cannot disconnect"));
    }

    #[test]
    fn names_always_includes_local_first() {
        let registry = registry_with_local_tag();
        assert_eq!(registry.names(), vec!["local".to_string()]);

        registry
            .register("dev.box", Arc::new(TaggedRuntime("dev")))
            .unwrap();
        registry
            .register("alpha", Arc::new(TaggedRuntime("a")))
            .unwrap();
        assert_eq!(
            registry.names(),
            vec![
                "local".to_string(),
                "alpha".to_string(),
                "dev.box".to_string(),
            ],
            "local must be first; remotes sorted alphabetically",
        );
    }

    #[test]
    fn lookup_holds_arc_after_concurrent_disconnect() {
        // The contract: a thread that has already cloned a runtime
        // Arc via `lookup` is free to keep using it even if another
        // thread disconnects the same name. Proves the Drop of the
        // last Arc is deferred until both holders release.
        let registry = registry_with_local_tag();
        registry
            .register("dev.box", Arc::new(TaggedRuntime("dev-box-tag")))
            .unwrap();
        let handle = registry.lookup(Some("dev.box")).unwrap();
        let _ = registry.unregister("dev.box").unwrap();

        // The handle is still functional — the inner Arc kept it
        // alive past the unregister.
        assert_eq!(handle.runtime_health().unwrap().hostname, "dev-box-tag");
    }
}
