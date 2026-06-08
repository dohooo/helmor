import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanesGrid } from "./grid";
import { PanesProvider } from "./provider";

describe("PanesGrid", () => {
	it("renders one cell per main-target pane in single-pane mode", () => {
		render(
			<PanesProvider>
				<PanesGrid>
					{(pane) => <div data-testid={`cell-${pane.id}`}>cell:{pane.id}</div>}
				</PanesGrid>
			</PanesProvider>,
		);
		const cells = screen.getAllByTestId(/^cell-/);
		expect(cells).toHaveLength(1);
		expect(cells[0].textContent).toBe("cell:default");
	});

	it("uses a 1x1 grid layout class for one pane", () => {
		const { container } = render(
			<PanesProvider>
				<PanesGrid>{() => <div />}</PanesGrid>
			</PanesProvider>,
		);
		// Outermost wrapper exposes the layout via data-attribute so the test
		// doesn't depend on Tailwind class names.
		expect(container.querySelector("[data-panes-layout]")).toHaveAttribute(
			"data-panes-layout",
			"1x1",
		);
	});
});
