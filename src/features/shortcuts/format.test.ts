import { describe, expect, it } from "vitest";
import {
	normalizeShortcutEvent,
	shortcutToInlineLabel,
	shortcutToKeys,
} from "./format";

describe("shortcut formatting", () => {
	it("normalizes Option plus letter from the physical key code", () => {
		const event = new KeyboardEvent("keydown", {
			altKey: true,
			code: "KeyL",
			key: "¬",
		});

		expect(normalizeShortcutEvent(event)).toBe("Alt+L");
	});

	it("keeps legacy macOS Option glyphs readable", () => {
		expect(shortcutToKeys("Alt+˙")).toEqual(["option", "H"]);
		expect(shortcutToKeys("Alt+¬")).toEqual(["option", "L"]);
	});

	it("formats compact tooltip labels", () => {
		expect(shortcutToInlineLabel("Mod+,")).toBe("⌘,");
		expect(shortcutToInlineLabel("Mod+Alt+ArrowRight")).toBe("⌘⌥→");
	});
});
