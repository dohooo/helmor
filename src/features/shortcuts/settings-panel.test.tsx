import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsSettingsPanel } from "./settings-panel";

describe("ShortcutsSettingsPanel", () => {
	afterEach(() => {
		cleanup();
	});

	it("keeps the global hotkey pinned when search does not match it", async () => {
		const user = userEvent.setup();
		render(<ShortcutsSettingsPanel overrides={{}} onChange={vi.fn()} />);

		expect(screen.getByText("Global")).toBeInTheDocument();
		expect(screen.getByText("Global hotkey")).toBeInTheDocument();

		await user.type(
			screen.getByPlaceholderText("Search shortcuts"),
			"no match",
		);

		expect(screen.getByText("Global hotkey")).toBeInTheDocument();
		expect(screen.queryByText("Create PR")).not.toBeInTheDocument();
	});
});
