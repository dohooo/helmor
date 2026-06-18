import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CachedAvatar } from "./cached-avatar";

vi.mock("@/lib/use-cached-avatar", () => ({
	useCachedAvatar: (src: string | null | undefined) => src ?? null,
}));

afterEach(() => {
	cleanup();
});

describe("CachedAvatar", () => {
	it("hides initials while an avatar src is loading", () => {
		render(
			<CachedAvatar src="https://example.com/a.png" alt="Ada" fallback="AL" />,
		);

		expect(screen.getByText("AL")).toHaveClass("opacity-0");
		expect(screen.getByAltText("Ada")).toHaveAttribute(
			"src",
			"https://example.com/a.png",
		);
	});

	it("reveals initials after the avatar image fails", () => {
		render(
			<CachedAvatar src="https://example.com/a.png" alt="Ada" fallback="AL" />,
		);

		fireEvent.error(screen.getByAltText("Ada"));

		expect(screen.getByText("AL")).not.toHaveClass("opacity-0");
		expect(screen.queryByAltText("Ada")).toBeNull();
	});

	it("shows initials when there is no avatar src", () => {
		render(<CachedAvatar src={null} alt="Ada" fallback="AL" />);

		expect(screen.getByText("AL")).not.toHaveClass("opacity-0");
		expect(screen.queryByAltText("Ada")).toBeNull();
	});
});
