import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsRow } from "./settings-row";

describe("SettingsRow", () => {
	it("stacks controls on narrow screens and keeps the desktop row layout", () => {
		const { container } = render(
			<SettingsRow
				title="Example setting"
				description="Explains the setting."
				controlClassName="custom-control"
			>
				<button type="button">Control</button>
			</SettingsRow>,
		);

		const row = container.firstElementChild;
		expect(row).toHaveClass("flex-col", "sm:flex-row", "sm:justify-between");
		expect(screen.getByText("Control").parentElement).toHaveClass(
			"min-w-0",
			"custom-control",
		);
	});
});
