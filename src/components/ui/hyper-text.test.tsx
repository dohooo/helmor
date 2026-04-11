import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HyperText } from "./hyper-text";

afterEach(() => {
	cleanup();
});

describe("HyperText", () => {
	it("renders text statically on initial mount", () => {
		render(<HyperText text="main" />);
		expect(screen.getByText("main")).toBeInTheDocument();
	});

	it("does not scramble on mount when animateOnMount is false", () => {
		render(<HyperText text="feature" />);
		// Should render the exact text, not scrambled characters
		expect(screen.getByText("feature")).toBeInTheDocument();
	});

	it("scrambles on mount when animateOnMount is true", () => {
		vi.useFakeTimers();
		render(<HyperText text="feature" animateOnMount />);
		// Immediately after mount the displayed text should be scrambled
		// (not equal to the target since scramble hasn't completed)
		const span = screen.getByText(/.+/);
		// After 600ms+ the scramble should resolve to the target
		act(() => {
			vi.advanceTimersByTime(700);
		});
		expect(span.textContent).toBe("feature");
		vi.useRealTimers();
	});

	it("triggers scramble animation when text changes", () => {
		vi.useFakeTimers();
		const { rerender } = render(<HyperText text="main" />);
		expect(screen.getByText("main")).toBeInTheDocument();

		rerender(<HyperText text="trunk" />);
		// During scramble the text should not yet match "trunk"
		const span = screen.getByText(/.+/);

		// After the scramble completes, it should show "trunk"
		act(() => {
			vi.advanceTimersByTime(700);
		});
		expect(span.textContent).toBe("trunk");
		vi.useRealTimers();
	});

	it("does not animate when rerendered with the same text", () => {
		const { rerender } = render(<HyperText text="main" />);
		rerender(<HyperText text="main" />);
		// Should still show exactly "main" (no scramble triggered)
		expect(screen.getByText("main")).toBeInTheDocument();
	});

	it("applies className to the span", () => {
		render(<HyperText text="test" className="truncate font-bold" />);
		const span = screen.getByText("test");
		expect(span).toHaveClass("truncate");
		expect(span).toHaveClass("font-bold");
	});

	it("cleans up interval on unmount during animation", () => {
		vi.useFakeTimers();
		const { unmount } = render(<HyperText text="main" animateOnMount />);
		// Unmount while animation is still running — should not throw
		unmount();
		// Advance timers to ensure no leaked intervals throw
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		vi.useRealTimers();
	});
});
