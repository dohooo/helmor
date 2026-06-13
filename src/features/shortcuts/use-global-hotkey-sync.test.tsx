import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShortcutOverrides } from "@/lib/settings";

const apiMocks = vi.hoisted(() => ({
	syncGlobalHotkey: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api")>();
	return {
		...actual,
		syncGlobalHotkey: apiMocks.syncGlobalHotkey,
	};
});

vi.mock("sonner", () => ({
	toast: toastMocks,
}));

import { useGlobalHotkeySync } from "./use-global-hotkey-sync";

function Harness({
	shortcuts,
	updateShortcuts,
}: {
	shortcuts: ShortcutOverrides;
	updateShortcuts: (shortcuts: ShortcutOverrides) => void;
}) {
	useGlobalHotkeySync({
		isLoaded: true,
		shortcuts,
		updateShortcuts,
	});
	return null;
}

describe("useGlobalHotkeySync", () => {
	beforeEach(() => {
		apiMocks.syncGlobalHotkey.mockReset();
		toastMocks.error.mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it("syncs every OS-level hotkey, including registry defaults", async () => {
		apiMocks.syncGlobalHotkey.mockResolvedValue(undefined);

		render(<Harness shortcuts={{}} updateShortcuts={vi.fn()} />);

		await waitFor(() => {
			// No overrides stored: global.hotkey has no default (null), the
			// quick panel ships bound to Shift+Alt+Space.
			expect(apiMocks.syncGlobalHotkey).toHaveBeenCalledWith(
				"global.hotkey",
				null,
			);
			expect(apiMocks.syncGlobalHotkey).toHaveBeenCalledWith(
				"quickPanel.hotkey",
				"Shift+Alt+Space",
			);
		});
	});

	it("clears a persisted global hotkey when registration fails", async () => {
		apiMocks.syncGlobalHotkey.mockRejectedValue(
			new Error("Hotkey unavailable"),
		);
		const updateShortcuts = vi.fn();

		render(
			<Harness
				shortcuts={{ "global.hotkey": "Mod+Shift+Space" }}
				updateShortcuts={updateShortcuts}
			/>,
		);

		await waitFor(() => {
			// global.hotkey override removed (its default is null)…
			expect(updateShortcuts).toHaveBeenCalledWith({});
			// …and the default-bound quick panel hotkey unbound explicitly.
			expect(updateShortcuts).toHaveBeenCalledWith({
				"global.hotkey": "Mod+Shift+Space",
				"quickPanel.hotkey": null,
			});
		});
		expect(toastMocks.error).toHaveBeenCalledWith("Hotkey unavailable");
	});
});
