// Typed shell event bus. Replaces ad-hoc `window.dispatchEvent("helmor:foo")`
// strings with a single discriminated union, so emitters and listeners share
// one source of truth.
//
// The transport is still `window.dispatchEvent` so existing
// `addEventListener("helmor:foo")` callsites in features/* keep working
// during the gradual migration.
import { useEffect, useRef } from "react";
import type {
	ContextProviderTab,
	SettingsSection,
} from "@/features/settings/types";
import type { WorkspaceMode } from "@/lib/api";

export type ShellEvent =
	| {
			type: "open-settings";
			section?: SettingsSection;
			// Sub-route for `section: "inbox"` — selects a provider tab inside
			// the Contexts panel. Ignored when section ≠ "inbox".
			inboxProvider?: ContextProviderTab;
	  }
	| { type: "reload-settings" }
	| { type: "open-model-picker" }
	// `mode` is a one-shot override: when set, the start surface forces the
	// composer into that mode for this open without touching the user's
	// persisted default (`startSurfacePreferences`). Unset = honor the
	// persisted default.
	| { type: "open-new-workspace"; mode?: WorkspaceMode }
	| { type: "open-add-repository" }
	| { type: "open-sidebar-filter" }
	| { type: "run-script" }
	| { type: "focus-composer" }
	| { type: "toggle-context-panel" }
	| { type: "focus-active-terminal" }
	// App-scoped ⌘⇧T — the mounted composer flips its terminalMode.
	| { type: "toggle-terminal-mode" }
	// Imperative archive from surfaces outside the sidebar controller (reuses its optimistic path).
	| { type: "request-archive-workspace"; workspaceId: string }
	// Composer Terminal-Mode submit: create a terminal session in the current
	// workspace and boot the provider's TUI with this prompt + composer state.
	| {
			type: "create-terminal-session";
			prompt: string;
			provider: string;
			modelId: string | null;
			effortLevel: string | null;
			permissionMode: string | null;
			addDirs: readonly string[] | null;
			fastMode: boolean;
			/** Explicit target; null = the currently selected workspace. */
			workspaceId: string | null;
			/** The composer's current session — always converted in place (one-way);
			 *  a session that already ran a turn resumes its conversation in the TUI.
			 *  null only when there is no current session to convert. */
			sessionId: string | null;
	  };

export type ShellEventType = ShellEvent["type"];

export type ShellEventOf<T extends ShellEventType> = Extract<
	ShellEvent,
	{ type: T }
>;

const EVENT_PREFIX = "helmor:";

export function shellEventName(type: ShellEventType): string {
	return `${EVENT_PREFIX}${type}`;
}

export function publishShellEvent(event: ShellEvent): void {
	if (typeof window === "undefined") return;
	const { type, ...detail } = event;
	window.dispatchEvent(
		new CustomEvent(shellEventName(type), {
			detail: detail as Record<string, unknown>,
		}),
	);
}

export function useShellEvent<T extends ShellEventType>(
	type: T,
	handler: (event: ShellEventOf<T>) => void,
): void {
	const handlerRef = useRef(handler);
	handlerRef.current = handler;

	useEffect(() => {
		if (typeof window === "undefined") return;

		const onEvent = (rawEvent: Event) => {
			const detail =
				rawEvent instanceof CustomEvent && rawEvent.detail
					? (rawEvent.detail as Record<string, unknown>)
					: {};
			handlerRef.current({
				type,
				...detail,
			} as ShellEventOf<T>);
		};

		const name = shellEventName(type);
		window.addEventListener(name, onEvent);
		return () => window.removeEventListener(name, onEvent);
	}, [type]);
}
