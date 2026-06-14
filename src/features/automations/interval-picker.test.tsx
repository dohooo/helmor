/**
 * Guards the "Every N" amount input against the controlled-input trap: a plain
 * controlled number input that only accepts valid values snaps back to the old
 * value, so the user can't clear-and-retype. The local draft must allow the
 * empty/intermediate state and clamp up to 1 on blur.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntervalPicker } from "./interval-picker";

afterEach(cleanup);

async function openEveryPicker(amount = 15) {
	const onChange = vi.fn();
	const user = userEvent.setup();
	render(
		<IntervalPicker
			value={{ kind: "every", amount, unit: "minutes" }}
			onChange={onChange}
		/>,
	);
	await user.click(screen.getByRole("button", { name: /Every/ }));
	const input = (await screen.findByLabelText(
		"Interval amount",
	)) as HTMLInputElement;
	return { onChange, user, input };
}

describe("IntervalPicker amount input", () => {
	it("allows clearing the field and clamps up to 1 on blur", async () => {
		const { onChange, user, input } = await openEveryPicker(15);

		await user.clear(input);
		// Empty stays empty instead of snapping back to 15.
		expect(input).toHaveValue(null);

		await user.tab();
		expect(input).toHaveValue(1);
		expect(onChange).toHaveBeenLastCalledWith({
			kind: "every",
			amount: 1,
			unit: "minutes",
		});
	});

	it("commits a valid typed amount", async () => {
		const { onChange, user, input } = await openEveryPicker(15);

		await user.clear(input);
		await user.type(input, "5");

		expect(onChange).toHaveBeenLastCalledWith({
			kind: "every",
			amount: 5,
			unit: "minutes",
		});
	});
});
