import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsReleaseBadge } from "./release-marker";

describe("SettingsReleaseBadge", () => {
	it("renders nothing when no marker is supplied", () => {
		const { container } = render(<SettingsReleaseBadge />);
		expect(container).toBeEmptyDOMElement();
	});

	it("renders 'New feature' for the feature kind", () => {
		const { getByText } = render(
			<SettingsReleaseBadge marker={{ kind: "feature" }} />,
		);
		expect(getByText("New feature")).toBeInTheDocument();
	});

	it("renders 'New update' for the update kind", () => {
		const { getByText } = render(
			<SettingsReleaseBadge marker={{ kind: "update" }} />,
		);
		expect(getByText("New update")).toBeInTheDocument();
	});

	it("forwards a custom className onto the rendered badge", () => {
		const { container } = render(
			<SettingsReleaseBadge
				marker={{ kind: "feature" }}
				className="custom-extra-class"
			/>,
		);
		expect(container.querySelector(".custom-extra-class")).not.toBeNull();
	});
});
