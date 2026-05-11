import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	publishShellEvent,
	type ShellEvent,
	shellEventName,
	useShellEvent,
} from "./event-bus";

function Harness<T extends ShellEvent["type"]>({
	type,
	onEvent,
}: {
	type: T;
	onEvent: (event: Extract<ShellEvent, { type: T }>) => void;
}) {
	useShellEvent(type, onEvent);
	return null;
}

describe("shell event bus", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("publishShellEvent dispatches a CustomEvent with `helmor:` prefix", () => {
		const listener = vi.fn();
		window.addEventListener("helmor:focus-composer", listener);
		publishShellEvent({ type: "focus-composer" });
		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener("helmor:focus-composer", listener);
	});

	it("useShellEvent receives the typed event when published", () => {
		const onEvent = vi.fn();
		render(<Harness type="open-new-workspace" onEvent={onEvent} />);
		publishShellEvent({ type: "open-new-workspace" });
		expect(onEvent).toHaveBeenCalledWith({ type: "open-new-workspace" });
	});

	it("useShellEvent decodes payload fields from CustomEvent.detail", () => {
		const onEvent = vi.fn();
		render(<Harness type="open-settings" onEvent={onEvent} />);
		publishShellEvent({ type: "open-settings", section: "inbox" });
		expect(onEvent).toHaveBeenCalledWith({
			type: "open-settings",
			section: "inbox",
		});
	});

	it("useShellEvent ignores events of other types", () => {
		const onEvent = vi.fn();
		render(<Harness type="open-settings" onEvent={onEvent} />);
		publishShellEvent({ type: "focus-composer" });
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("legacy listeners using the raw `helmor:foo` name still receive events", () => {
		const listener = vi.fn();
		window.addEventListener("helmor:open-model-picker", listener);
		publishShellEvent({ type: "open-model-picker" });
		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener("helmor:open-model-picker", listener);
	});

	it("publishShellEvent + legacy CustomEvent dispatcher are interoperable", () => {
		const onEvent = vi.fn();
		render(<Harness type="open-settings" onEvent={onEvent} />);
		// Simulate a legacy emitter (e.g. features/settings/panels/inbox.tsx).
		window.dispatchEvent(
			new CustomEvent("helmor:open-settings", {
				detail: { section: "account" },
			}),
		);
		expect(onEvent).toHaveBeenCalledWith({
			type: "open-settings",
			section: "account",
		});
	});

	it("shellEventName prefixes type with `helmor:`", () => {
		expect(shellEventName("focus-composer")).toBe("helmor:focus-composer");
	});

	it("useShellEvent unsubscribes on unmount", () => {
		const onEvent = vi.fn();
		const { unmount } = render(
			<Harness type="open-model-picker" onEvent={onEvent} />,
		);
		unmount();
		publishShellEvent({ type: "open-model-picker" });
		expect(onEvent).not.toHaveBeenCalled();
	});

	it("useShellEvent updates handler reference without re-binding listener", () => {
		const firstHandler = vi.fn();
		const secondHandler = vi.fn();
		const { rerender } = render(
			<Harness type="run-script" onEvent={firstHandler} />,
		);
		rerender(<Harness type="run-script" onEvent={secondHandler} />);
		publishShellEvent({ type: "run-script" });
		expect(firstHandler).not.toHaveBeenCalled();
		expect(secondHandler).toHaveBeenCalledTimes(1);
	});
});
