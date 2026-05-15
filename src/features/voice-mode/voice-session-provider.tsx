import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
} from "react";
import type { VoiceDispatchActionKind } from "@/lib/api";
import { useRealtimeSequence } from "./use-realtime-sequence";
import { useDemoSequence, type VoiceUiState } from "./voice-mode-state";
import { useVoiceModeActive, voiceModeStore } from "./voice-mode-store";

/** Voice-mode session anchor. Hosts the WebRTC peer + UI state machine
 *  once, near the top of the app tree, and republishes the resulting
 *  `VoiceUiState` to anyone who needs it via React context.
 *
 *  This provider exists to break a regression: when the voice bar
 *  itself owned `useRealtimeSequence`, switching `workspaceViewMode`
 *  between `"start"` and `"conversation"` unmounted the bar's parent
 *  subtree (the two branches in `App.tsx` are mutually exclusive) and
 *  tore the WebRTC session down with it. The bar then re-mounted on
 *  the other side and spent another 1-3 s in "Connecting" while the
 *  macOS mic indicator blinked off and on. Hoisting the session above
 *  the conditional render keeps it alive across view switches; the bar
 *  becomes a passive consumer that simply reads the latest state.
 *
 *  Source switching:
 *  - With an OpenAI Realtime API key configured, drive the bar from
 *    real Realtime events via `useRealtimeSequence`.
 *  - Without a key, fall back to the 12 s scripted `useDemoSequence`
 *    so the UI stays iterable for designers / debugging.
 *  Both hooks run unconditionally (React hook rules) but the `active`
 *  flag gates whether either does any actual work.
 */

const VoiceSessionContext = createContext<VoiceUiState | null>(null);

type VoiceSessionProviderProps = {
	children: ReactNode;
	/** API key is owned by settings, which itself sits behind a hook —
	 *  passing it as a prop keeps this provider settings-agnostic and
	 *  lets `App.tsx` use its already-loaded `useSettings()` result. */
	hasApiKey: boolean;
	/** Triggered after `create_workspace`, `send_prompt`, or
	 *  `select_workspace` complete successfully. Caller wires this to
	 *  the same workspace-selection handler the sidebar uses, so the UI
	 *  follows the voice agent's action instead of stranding the user
	 *  on the previous view. Must accept a workspace UUID (not a slug);
	 *  the dispatcher resolves slugs internally before calling.
	 *
	 *  Stable identity (memoize at the caller) — the underlying
	 *  realtime session is restarted whenever this changes, which
	 *  reopens WebRTC + remints the OpenAI client secret. */
	onNavigateToWorkspace?: (workspaceId: string) => void;
	/** Triggered after `run_workspace_action` resolves with one of the
	 *  four agent-dispatched action kinds. Caller should route through
	 *  the GUI's `handleInspectorCommitAction` so the canned prompts +
	 *  post-stream verifier behavior stay identical between voice and
	 *  click. Direct actions (`merge_pr` / `pull_latest`) execute
	 *  inline in Rust and do NOT fire this. */
	onDispatchWorkspaceAction?: (
		workspaceId: string,
		actionKind: VoiceDispatchActionKind,
	) => void;
	/** Extra side-effect to run when the model invokes `end_session`,
	 *  alongside the unconditional `voiceModeStore.setActive(false)`.
	 *  Used by the desktop voice-panel webview to also hide the
	 *  always-on-top OS window — the main window doesn't need this
	 *  (its sidebar bar collapses purely from the store flipping). */
	onEndSession?: () => void;
};

export function VoiceSessionProvider({
	children,
	hasApiKey,
	onNavigateToWorkspace,
	onDispatchWorkspaceAction,
	onEndSession,
}: VoiceSessionProviderProps) {
	const active = useVoiceModeActive();
	// Synthetic `end_session` tool: the model invokes it after wrapping
	// up verbally ("拜拜" / "see ya."), and the dispatcher's
	// audio-flush delay has already elapsed by the time this fires —
	// so flipping the store directly here is safe to terminate the
	// session without clipping the goodbye reply. The optional
	// `onEndSession` prop lets callers attach an extra teardown step
	// (e.g. the voice-panel webview hides its OS window).
	const handleEndSession = useCallback(() => {
		voiceModeStore.setActive(false);
		onEndSession?.();
	}, [onEndSession]);
	const realState = useRealtimeSequence(
		active && hasApiKey,
		onNavigateToWorkspace,
		handleEndSession,
		onDispatchWorkspaceAction,
	);
	const demoState = useDemoSequence(active && !hasApiKey);
	const state = hasApiKey ? realState : demoState;
	return (
		<VoiceSessionContext.Provider value={state}>
			{children}
		</VoiceSessionContext.Provider>
	);
}

/** Read the current voice-mode UI state. Returns a stable inert
 *  `listening / level 0` state when the provider isn't mounted, so
 *  components that render with or without voice mode wired up don't
 *  have to branch on null. */
export function useVoiceSession(): VoiceUiState {
	const ctx = useContext(VoiceSessionContext);
	// useMemo so the fallback identity is stable across renders — keeps
	// downstream effects from re-running when context is genuinely null.
	const fallback = useMemo<VoiceUiState>(
		() => ({ phase: "listening", level: 0 }),
		[],
	);
	return ctx ?? fallback;
}
