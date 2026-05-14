import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "./reasoning";

function setup(lifecycle: "streaming" | "just-finished" | "historical") {
	return render(
		<Reasoning lifecycle={lifecycle}>
			<ReasoningTrigger />
			<ReasoningContent>{"some thought text"}</ReasoningContent>
		</Reasoning>,
	);
}

describe("<Reasoning />", () => {
	afterEach(() => {
		cleanup();
	});

	it("defaults open while streaming", () => {
		const { container } = setup("streaming");
		const trigger = within(container).getByRole("button");
		expect(trigger.getAttribute("data-state")).toBe("open");
	});

	// Previously `just-finished` defaulted open, with an effect that
	// collapsed it only when the user observed the live `streaming →
	// !streaming` transition. Switching to another session and coming
	// back left the block expanded — both surprising the user and
	// inflating the layout estimator by `textHeight` per block.
	it("defaults closed once streaming finished, regardless of mount path", () => {
		const { container } = setup("just-finished");
		const trigger = within(container).getByRole("button");
		expect(trigger.getAttribute("data-state")).toBe("closed");
	});

	it("defaults closed for historical reloads", () => {
		const { container } = setup("historical");
		const trigger = within(container).getByRole("button");
		expect(trigger.getAttribute("data-state")).toBe("closed");
	});
});
