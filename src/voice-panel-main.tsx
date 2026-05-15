import "./App.css";
import "./voice-panel.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { voiceDiag } from "@/features/voice-mode/voice-diag";
import { VoiceModeBar } from "@/features/voice-mode/voice-mode-bar";
import {
	useVoiceModeActive,
	voiceModeStore,
} from "@/features/voice-mode/voice-mode-store";
import {
	useVoiceSession,
	VoiceSessionProvider,
} from "@/features/voice-mode/voice-session-provider";
import type { VoiceDispatchActionKind } from "@/lib/api";
import { createHelmorQueryClient } from "@/lib/query-client";
import { initDevReactScan } from "./lib/dev-react-scan";

initDevReactScan();

/** Standalone React Query client for the voice-panel webview.
 *  Each webview is a separate JS runtime, so the panel can't share the
 *  main window's QueryClient instance. We need our own so
 *  `useRealtimeSequence` (which calls `useQueryClient()` for cache
 *  invalidation after tool calls) has a provider to read from. */
const queryClient = createHelmorQueryClient();

/** Storage key for the OpenAI Realtime API key. Mirrors
 *  `SETTINGS_KEY_MAP.openAiRealtimeApiKey` in `lib/settings.ts` — kept
 *  here as a string literal so this entry point doesn't have to drag
 *  the full settings module (and its React context bootstrap) into the
 *  voice-panel bundle just to read one boolean. */
const OPENAI_REALTIME_API_KEY_SETTING = "app.openai_realtime_api_key";

/** Window-level event names emitted by the Rust global-hotkey handler
 *  and by this panel back to the main window. Stay-in-sync targets:
 *  `src-tauri/src/global_hotkey.rs::VOICE_ACTIVE_WINDOW_EVENT` and the
 *  matching listeners in `App.tsx`. */
const VOICE_ACTIVE_WINDOW_EVENT = "helmor://voice-active-window";
const VOICE_PANEL_NAVIGATE_EVENT = "helmor://voice-panel-navigate-workspace";
const VOICE_PANEL_DISPATCH_ACTION_EVENT =
	"helmor://voice-panel-dispatch-workspace-action";

/** Tag every voice-panel webview-level event with the `panel.`
 *  namespace. Dispatcher events use the `dispatcher.` namespace via
 *  the dispatcher's own helper. See `voice-diag.ts`. */
function diag(event: string, data?: Record<string, unknown>) {
	voiceDiag(`panel.${event}`, data);
}

function VoicePanelApp() {
	useEffect(() => {
		diag("mount");
		return () => {
			diag("unmount");
		};
	}, []);

	// Mirror what the main window does: voice can't start until we know
	// whether the user has an OpenAI Realtime API key configured. We
	// fetch settings exactly once on mount — the panel is a short-lived
	// surface, so we don't bother re-fetching on settings change. If
	// the user updates the key while the panel is alive they can hide
	// + re-show it.
	const [hasApiKey, setHasApiKey] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const raw = await invoke<Record<string, string>>("get_app_settings");
				if (cancelled) return;
				const key = raw[OPENAI_REALTIME_API_KEY_SETTING]?.trim() ?? "";
				diag("settings-loaded", { hasApiKey: key.length > 0 });
				setHasApiKey(key.length > 0);
			} catch (error) {
				if (cancelled) return;
				diag("settings-load-failed", { error: String(error) });
				console.warn("[voice-panel] failed to load settings", error);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Rust broadcasts `helmor://voice-active-window` with payload
	// `"none" | "panel" | "main"` to indicate which webview should own
	// the WebRTC peer right now. The panel only mounts its session
	// while the payload is exactly `"panel"`; on `"main"` or `"none"`
	// it tears the peer down (so the main-window sidebar bar — or
	// nothing at all — takes over the mic).
	useEffect(() => {
		// React StrictMode (dev) intentionally mount → unmount → mount
		// every effect. `listen(...)` is async, so the naive
		// `listen().then(stop => unlisten = stop)` pattern races: cleanup
		// runs before the `then` resolves, `unlisten` is still
		// undefined, and the first listener is orphaned in the Tauri
		// backend. Result: every broadcast fires every queued listener.
		// The `cancelled` flag flips on cleanup so a late-resolving
		// `then` can still invoke `stop()` and free its slot.
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void listen<string>(VOICE_ACTIVE_WINDOW_EVENT, (event) => {
			diag("voice-active-window", { payload: event.payload });
			voiceModeStore.setActive(event.payload === "panel");
		}).then((stop) => {
			if (cancelled) {
				stop();
				return;
			}
			unlisten = stop;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	// Forward navigation hints from the voice agent's tool envelope
	// over to the main window. The panel itself has no workspace list
	// to drive, so without this forward the user would hear "created
	// in helmor" but find the main window still parked on the
	// previously selected workspace. `emit` (not `emit_to`) broadcasts;
	// the main window picks it up via its own `App.tsx` listener.
	const handleNavigateToWorkspace = (workspaceId: string) => {
		diag("navigate", { workspaceId });
		void emit(VOICE_PANEL_NAVIGATE_EVENT, workspaceId).catch((error) => {
			console.warn("[voice-panel] navigate emit failed", error);
		});
	};

	// Same idea for run_workspace_action's agent-dispatched four kinds
	// (commit-and-push / create-pr / fix / resolve-conflicts) — the
	// main window has to be the one to run handleInspectorCommitAction
	// because that's where the commit-button state machine lives.
	const handleDispatchWorkspaceAction = (
		workspaceId: string,
		actionKind: VoiceDispatchActionKind,
	) => {
		diag("dispatch-action", { workspaceId, actionKind });
		void emit(VOICE_PANEL_DISPATCH_ACTION_EVENT, {
			workspaceId,
			actionKind,
		}).catch((error) => {
			console.warn("[voice-panel] dispatch-action emit failed", error);
		});
	};

	// When the model invokes `end_session` ("拜拜" / "see ya."), the
	// provider already flips the voice store off; we additionally need
	// to hide the panel's OS window so the always-on-top frame goes
	// away. The Rust command handles the broadcast back to the main
	// window so its sidebar voice (if any) also stands down.
	const handleEndSession = () => {
		diag("end-session");
		void invoke("hide_voice_panel").catch((error) => {
			console.warn("[voice-panel] hide_voice_panel failed", error);
		});
	};

	return (
		<VoiceSessionProvider
			hasApiKey={hasApiKey}
			onNavigateToWorkspace={handleNavigateToWorkspace}
			onDispatchWorkspaceAction={handleDispatchWorkspaceAction}
			onEndSession={handleEndSession}
		>
			<VoicePanelPhaseDiag />
			<main aria-label="Helmor voice panel" className="voice-panel-root">
				<div className="voice-panel-bar-frame">
					<VoiceModeBar className="bg-muted" forceActive gap={0} height={32} />
				</div>
			</main>
		</VoiceSessionProvider>
	);
}

/** Watches the live voice session state from inside the provider tree
 *  and reports every PHASE change (listening → connecting → speaking
 *  → …) into the Rust log. Audio-level micro-updates are deliberately
 *  filtered out — they fire 30+ times per second and would drown out
 *  the signals we care about. Renders nothing. */
function VoicePanelPhaseDiag() {
	const active = useVoiceModeActive();
	const session = useVoiceSession();
	useEffect(() => {
		diag("voice-state", {
			active,
			phase: session.phase,
			label: session.label ?? null,
			tone: session.tone ?? null,
		});
	}, [active, session.phase, session.label, session.tone]);
	return null;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<QueryClientProvider client={queryClient}>
			<VoicePanelApp />
		</QueryClientProvider>
	</React.StrictMode>,
);
