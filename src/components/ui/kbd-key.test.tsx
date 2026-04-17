import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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

	it("renders an svg icon for 'command'", () => {
		const { container } = render(<KbdKey name="command" />);
		const svg = container.querySelector("kbd svg");
		expect(svg).not.toBeNull();
		expect(container.querySelector("kbd span")).toBeNull();
	});

	it("renders an svg icon for 'shift'", () => {
		const { container } = render(<KbdKey name="shift" />);
		expect(container.querySelector("kbd svg")).not.toBeNull();
	});

	it("is case-insensitive on lookup", () => {
		const { container: lower } = render(<KbdKey name="command" />);
		const { container: upper } = render(<KbdKey name="COMMAND" />);
		const { container: symbol } = render(<KbdKey name="⌘" />);
		expect(lower.querySelector("kbd svg")).not.toBeNull();
		expect(upper.querySelector("kbd svg")).not.toBeNull();
		expect(symbol.querySelector("kbd svg")).not.toBeNull();
	});

	it("renders an svg icon for 'enter' and its aliases", () => {
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
