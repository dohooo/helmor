import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { BaseTooltip } from "./base-tooltip";
import { TooltipProvider } from "./tooltip";

describe("BaseTooltip", () => {
	it("applies compact styling by default", async () => {
		const user = userEvent.setup();

		render(
			<TooltipProvider delay={0}>
				<BaseTooltip content={<span>Add repository</span>}>
					<button type="button">Trigger</button>
				</BaseTooltip>
			</TooltipProvider>,
		);

		await user.hover(screen.getByRole("button", { name: "Trigger" }));

		await waitFor(() => {
			expect(
				document.body.querySelector('[data-slot="tooltip-content"]'),
			).not.toBeNull();
		});

		const tooltip = document.body.querySelector(
			'[data-slot="tooltip-content"]',
		);

		expect(tooltip).not.toBeNull();
		expect(tooltip).toHaveTextContent("Add repository");
	});
});
