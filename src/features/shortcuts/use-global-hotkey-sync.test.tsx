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
			expect(updateShortcuts).toHaveBeenCalledWith({});
		});
		expect(toastMocks.error).toHaveBeenCalledWith("Hotkey unavailable");
	});
});
