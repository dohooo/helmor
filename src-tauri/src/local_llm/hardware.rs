//! Local-machine snapshot for the Local LLM settings panel.
//!
//! `detect()` returns a cached `HardwareSnapshot` so re-renders of the
//! panel don't re-shell-out to `sw_vers`. RAM / CPU brand don't change
//! mid-process and the OS version effectively doesn't either; OnceLock
//! is correct here.
//!
//! macOS-only — we read `hw.memsize` and `machdep.cpu.brand_string`
//! via `sysctlbyname` (cheap, no shell), and `productVersion` via the
//! `sw_vers` CLI (no clean sysctl path for it on Apple Silicon).

use std::ffi::CString;
use std::sync::OnceLock;

use serde::Serialize;

use super::catalog::{self, CatalogEntry, ModelKind};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareSnapshot {
    pub cpu_brand: String,
    pub total_ram_gb: u8,
    pub os_label: String,
    pub arch: &'static str,
    /// `id` of the catalog entry the hardware tier maps to. Frontend
    /// uses this to paint the "Recommended" badge on exactly one card.
    /// `None` only if the catalog is unexpectedly empty.
    pub recommended_entry_id: Option<String>,
}

static SNAPSHOT: OnceLock<HardwareSnapshot> = OnceLock::new();

pub fn detect() -> HardwareSnapshot {
    SNAPSHOT.get_or_init(do_detect).clone()
}

#[cfg(target_os = "macos")]
fn do_detect() -> HardwareSnapshot {
    let total_bytes = sysctl_u64("hw.memsize").unwrap_or(0);
    let total_gb = bytes_to_rounded_gb(total_bytes);
    let cpu_brand =
        sysctl_string("machdep.cpu.brand_string").unwrap_or_else(|| "Unknown CPU".to_string());
    let os_label = read_macos_version()
        .map(|v| format!("macOS {v}"))
        .unwrap_or_else(|| "macOS".to_string());

    HardwareSnapshot {
        cpu_brand,
        total_ram_gb: total_gb,
        os_label,
        arch: arch_label(),
        recommended_entry_id: recommend_for_ram(total_gb),
    }
}

#[cfg(not(target_os = "macos"))]
fn do_detect() -> HardwareSnapshot {
    // Helmor only ships on macOS today, but keep the non-macOS branch
    // compilable so unit tests and future Linux/Windows ports don't
    // explode. Backend returns a "best-effort unknown" snapshot; the
    // frontend already handles that gracefully (no recommended badge,
    // muted "Your Mac" row).
    HardwareSnapshot {
        cpu_brand: "Unknown CPU".to_string(),
        total_ram_gb: 0,
        os_label: std::env::consts::OS.to_string(),
        arch: arch_label(),
        recommended_entry_id: None,
    }
}

fn arch_label() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        "unknown"
    }
}

fn bytes_to_rounded_gb(bytes: u64) -> u8 {
    let gb = (bytes as f64) / 1_073_741_824.0;
    // u8 ceiling (255 GB) is comfortably above any current shipping
    // Mac (Studio Ultra tops out at 512 GB but it's vanishingly rare
    // among Helmor users; we'd promote to u16 in the same week one
    // shows up).
    gb.round().clamp(0.0, u8::MAX as f64) as u8
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &str) -> Option<u64> {
    let name_c = CString::new(name).ok()?;
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    let ret = unsafe {
        libc::sysctlbyname(
            name_c.as_ptr(),
            std::ptr::from_mut::<u64>(&mut value).cast::<std::ffi::c_void>(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (ret == 0).then_some(value)
}

#[cfg(target_os = "macos")]
fn sysctl_string(name: &str) -> Option<String> {
    let name_c = CString::new(name).ok()?;
    // Two-call protocol: first probe the length, then read.
    let mut size: usize = 0;
    let ret = unsafe {
        libc::sysctlbyname(
            name_c.as_ptr(),
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret != 0 || size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    let ret = unsafe {
        libc::sysctlbyname(
            name_c.as_ptr(),
            buf.as_mut_ptr().cast::<std::ffi::c_void>(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if ret != 0 {
        return None;
    }
    if let Some(&0) = buf.last() {
        buf.pop();
    }
    String::from_utf8(buf).ok()
}

#[cfg(target_os = "macos")]
fn read_macos_version() -> Option<String> {
    let output = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

/// Walk the catalog ascending by `recommended_for_gb` and keep the
/// highest entry whose recommendation fits inside the machine's RAM.
/// If even the smallest entry doesn't fit (very low-RAM machine), we
/// still return the smallest so the panel has something to highlight —
/// the user opts in by clicking through the "Needs N GB free" warning.
fn recommend_for_ram(total_gb: u8) -> Option<String> {
    let entries = catalog::catalog();
    // STT entries share the catalog but are NOT chat brains — never
    // recommend one as the user's default brain just because it fits.
    let llm_entries: Vec<&CatalogEntry> = entries
        .iter()
        .filter(|e| e.kind == ModelKind::Llm)
        .collect();
    let mut best: Option<&CatalogEntry> = None;
    for entry in &llm_entries {
        if entry.recommended_for_gb <= total_gb {
            best = Some(entry);
        }
    }
    best.or_else(|| llm_entries.first().copied())
        .map(|e| e.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_to_rounded_gb_handles_typical_macs() {
        // 16 GB unified memory (Apple counts 1 GB = 1024^3).
        assert_eq!(bytes_to_rounded_gb(17_179_869_184), 16);
        // 48 GB.
        assert_eq!(bytes_to_rounded_gb(51_539_607_552), 48);
        // 96 GB.
        assert_eq!(bytes_to_rounded_gb(103_079_215_104), 96);
        // 0 / unknown.
        assert_eq!(bytes_to_rounded_gb(0), 0);
    }

    #[test]
    fn recommend_for_ram_picks_highest_fitting_tier() {
        // 16 GB → smallest 16-GB entry.
        let id = recommend_for_ram(16).expect("catalog has entries");
        assert_eq!(id, "qwen35-4b-q4");
        // 24 GB → 9B.
        assert_eq!(recommend_for_ram(24).as_deref(), Some("qwen35-9b-q4"));
        // 32 GB → last 32-GB-tier entry (catalog order).
        let id_32 = recommend_for_ram(32).expect("32 gb matches");
        assert!(
            id_32 == "qwen36-27b-q4" || id_32 == "qwen36-35b-a3b-q4",
            "expected a 32-GB tier entry, got {id_32}",
        );
        // 48 GB → 35B-A3B Q8 (the sweet spot).
        assert_eq!(recommend_for_ram(48).as_deref(), Some("qwen36-35b-a3b-q8"));
        // 96 GB → 122B-A10B.
        assert_eq!(
            recommend_for_ram(96).as_deref(),
            Some("qwen35-122b-a10b-q4")
        );
        // 128 GB → still the largest (capped at top).
        assert_eq!(
            recommend_for_ram(128).as_deref(),
            Some("qwen35-122b-a10b-q4")
        );
    }

    #[test]
    fn recommend_for_ram_falls_back_to_smallest_when_below_floor() {
        // 4 GB machine — below every entry. Still hand back the
        // smallest so the panel has something to flag.
        assert_eq!(recommend_for_ram(4).as_deref(), Some("qwen35-4b-q4"));
    }

    #[test]
    fn detect_returns_a_snapshot_without_panicking() {
        let snapshot = detect();
        // Identity should be the same instance on repeat calls (OnceLock).
        let second = detect();
        assert_eq!(snapshot.arch, second.arch);
        assert_eq!(snapshot.total_ram_gb, second.total_ram_gb);
    }
}
