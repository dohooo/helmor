import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AppSettings,
	DEFAULT_SETTINGS,
	SettingsContext,
} from "@/lib/settings";
import { CustomPromptSetting } from "./custom-prompt";

afterEach(cleanup);

function renderWith(overrides: Partial<AppSettings>, updateSettings = vi.fn()) {
	const settings: AppSettings = { ...DEFAULT_SETTINGS, ...overrides };
	render(
		<SettingsContext.Provider
			value={{ settings, isLoaded: true, updateSettings }}
		>
			<CustomPromptSetting />
		</SettingsContext.Provider>,
	);
	return { updateSettings };
}

describe("CustomPromptSetting", () => {
	it("hides the textarea when the toggle is off", () => {
		renderWith({ customPromptEnabled: false });
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	it("shows the textarea with the saved prompt when enabled", () => {
		renderWith({ customPromptEnabled: true, customPrompt: "Be terse." });
		expect(screen.getByRole("textbox")).toHaveValue("Be terse.");
	});

	it("enables the setting when the switch is turned on", () => {
		const { updateSettings } = renderWith({ customPromptEnabled: false });
		fireEvent.click(screen.getByRole("switch"));
		expect(updateSettings).toHaveBeenCalledWith({ customPromptEnabled: true });
	});

	it("persists the edited prompt on blur", () => {
		const { updateSettings } = renderWith({
			customPromptEnabled: true,
			customPrompt: "",
		});
		const textarea = screen.getByRole("textbox");
		fireEvent.change(textarea, { target: { value: "Always use TypeScript." } });
		// No write while typing.
		expect(updateSettings).not.toHaveBeenCalled();
		fireEvent.blur(textarea);
		expect(updateSettings).toHaveBeenCalledWith({
			customPrompt: "Always use TypeScript.",
		});
	});
});
