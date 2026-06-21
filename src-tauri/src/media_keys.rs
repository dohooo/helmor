//! macOS media-key passthrough.
//!
//! WKWebView (which Tauri uses for the webview) intercepts the
//! `NSSystemDefined` events macOS posts when the user presses the
//! transport keys on an Apple keyboard or Touch Bar (play/pause,
//! next, previous, fast, rewind). Helmor doesn't handle them, so the
//! responder chain falls through to the default no-op which emits
//! the "pop" NSBeep — and Spotify / Apple Music never see the press.
//!
//! Fix: install an `NSEvent` *local* monitor (process-wide, no extra
//! permissions, no `CGEventTap`) that swallows the transport-key
//! events before they reach the webview. Returning `nil` from the
//! handler suppresses the event for our app; macOS then routes the
//! HID-level media key to the next responder in the system, which is
//! the "Now Playing" app (Spotify, Music, etc.).
//!
//! We deliberately ignore mute / volume up / volume down — those
//! have direct system behaviour and are not reported as being
//! swallowed by Helmor. Re-introduce them only after verifying the
//! same beep.

#![cfg(target_os = "macos")]

use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventSubtype, NSEventType};

// Apple's IOKit `ev_keymap.h` constants for the aux-control sub-event
// keycodes that ride inside an `NSSystemDefined` event with subtype 8.
const NX_KEYTYPE_PLAY: u16 = 16;
const NX_KEYTYPE_NEXT: u16 = 17;
const NX_KEYTYPE_PREVIOUS: u16 = 18;
const NX_KEYTYPE_FAST: u16 = 19;
const NX_KEYTYPE_REWIND: u16 = 20;

// `NX_SUBTYPE_AUX_CONTROL_BUTTONS` — the `NSSystemDefined` subtype
// that carries the media-key keycode inside `data1`.
const AUX_CONTROL_BUTTONS_SUBTYPE: i16 = 8;

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Install the media-key passthrough. Safe to call more than once;
/// subsequent calls are no-ops. Must be called on the main thread
/// (Tauri's `setup` hook satisfies this).
pub fn install() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }

    let block = RcBlock::new(|event: core::ptr::NonNull<NSEvent>| -> *mut NSEvent {
        let event_ref = unsafe { event.as_ref() };
        if should_swallow(event_ref) {
            ptr::null_mut()
        } else {
            event.as_ptr()
        }
    });

    // SAFETY: `addLocalMonitorForEventsMatchingMask:handler:` requires
    // the block's return be a valid `NSEvent*` or null — our handler
    // returns either the original event pointer or null. The monitor
    // token is leaked intentionally: AppKit removes the monitor when
    // the token is released, which would silently regress the fix.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::SystemDefined, &block)
    };

    match monitor {
        Some(token) => {
            // Process-lifetime monitor.
            std::mem::forget(token);
        }
        None => {
            tracing::warn!("Failed to install macOS media-key passthrough monitor");
            // Allow a future call to retry.
            INSTALLED.store(false, Ordering::SeqCst);
        }
    }
}

/// Returns `true` if the event is a transport-key press/release that
/// we want to hide from the webview so macOS can route it to the
/// system "Now Playing" app.
fn should_swallow(event: &NSEvent) -> bool {
    if event.r#type() != NSEventType::SystemDefined {
        return false;
    }
    if event.subtype() != NSEventSubtype(AUX_CONTROL_BUTTONS_SUBTYPE) {
        return false;
    }

    // `data1` layout for aux-control events:
    //   bits 31..16  keycode
    //   bits 15..0   key flags (state in upper byte: 0x0A=down, 0x0B=up)
    //
    // We swallow both down and up — eating only key-down would still
    // leave the unmatched key-up to trigger the NSBeep "pop". The
    // state decode is kept so future hooks (logging, metrics, custom
    // shortcuts) can act on key-down only.
    let data1 = event.data1();
    let keycode = ((data1 & 0xFFFF_0000) >> 16) as u16;
    let _is_key_down = ((data1 & 0xFF00) >> 8) as u8 == 0x0A;

    matches!(
        keycode,
        NX_KEYTYPE_PLAY
            | NX_KEYTYPE_NEXT
            | NX_KEYTYPE_PREVIOUS
            | NX_KEYTYPE_FAST
            | NX_KEYTYPE_REWIND
    )
}
