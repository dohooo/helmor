// Typed shell event bus. Replaces ad-hoc `window.dispatchEvent("helmor:foo")`
// strings with a single discriminated union, so emitters and listeners share
// one source of truth.
//
// The transport is still `window.dispatchEvent` so existing
// `addEventListener("helmor:foo")` callsites in features/* keep working
// during the gradual migration.
import { useEffect, useRef } from "react";
import type { SettingsSection } from "@/features/settings/types";

export type ShellEvent =
	| { type: "open-settings"; section?: SettingsSection }
	| { type: "reload-settings" }
	| { type: "open-model-picker" }
	| { type: "open-new-workspace" }
	| { type: "open-add-repository" }
	| { type: "open-sidebar-filter" }
	| { type: "run-script" }
	| { type: "focus-composer" }
	| { type: "toggle-context-panel" }
	| { type: "focus-active-terminal" };

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
