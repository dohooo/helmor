import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isMac } from "@/lib/platform";
import { KbdKey } from "./kbd-key";

describe("KbdKey (baseline rendering)", () => {
	it("renders plain text for an unknown key name", () => {
		const { container } = render(<KbdKey name="Esc" />);
		const kbd = container.querySelector("kbd");
		expect(kbd).not.toBeNull();
		// Unknown keys fall back to the <span>{name}</span> branch.
		expect(container.querySelector("kbd span")?.textContent).toBe("Esc");
		expect(container.querySelector("kbd svg")).toBeNull();
	});

	it("'command' renders as ⌘ icon on macOS, 'Ctrl' text elsewhere", () => {
		const { container } = render(<KbdKey name="command" />);
		if (isMac()) {
			expect(container.querySelector("kbd svg")).not.toBeNull();
			expect(container.querySelector("kbd span")).toBeNull();
		} else {
			expect(container.querySelector("kbd svg")).toBeNull();
			expect(container.querySelector("kbd span")?.textContent).toBe("Ctrl");
		}
	});

	it("'option' renders as ⌥ icon on macOS, 'Alt' text elsewhere", () => {
		const { container } = render(<KbdKey name="option" />);
		if (isMac()) {
			expect(container.querySelector("kbd svg")).not.toBeNull();
			expect(container.querySelector("kbd span")).toBeNull();
		} else {
			expect(container.querySelector("kbd svg")).toBeNull();
			expect(container.querySelector("kbd span")?.textContent).toBe("Alt");
		}
	});

	it("'shift' renders as ArrowBigUp icon on every OS", () => {
		const { container } = render(<KbdKey name="shift" />);
		expect(container.querySelector("kbd svg")).not.toBeNull();
	});

	it("is case-insensitive on lookup for 'command'", () => {
		const { container: lower } = render(<KbdKey name="command" />);
		const { container: upper } = render(<KbdKey name="COMMAND" />);
		const { container: symbol } = render(<KbdKey name="⌘" />);
		// Whichever representation the OS uses, all three aliases must be identical.
		const lowerHtml = lower.querySelector("kbd")?.innerHTML;
		const upperHtml = upper.querySelector("kbd")?.innerHTML;
		const symbolHtml = symbol.querySelector("kbd")?.innerHTML;
		expect(lowerHtml).toBe(upperHtml);
		expect(lowerHtml).toBe(symbolHtml);
	});

	it("renders an svg icon for 'enter' and its aliases on every OS", () => {
		for (const name of ["enter", "return", "⏎"]) {
			const { container } = render(<KbdKey name={name} />);
			expect(
				container.querySelector("kbd svg"),
				`key "${name}" should render an icon`,
			).not.toBeNull();
		}
	});

	it("renders the kbd element with the data-slot attribute", () => {
		const { container } = render(<KbdKey name="A" />);
		const kbd = container.querySelector("kbd");
		expect(kbd?.getAttribute("data-slot")).toBe("kbd");
	});
});
