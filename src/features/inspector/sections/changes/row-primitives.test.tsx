import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LineStats, ShinyFlash } from "./row-primitives";

vi.mock("@/components/ui/number-ticker", () => ({
	NumberTicker: ({
		value,
		animateOnMount = true,
		className,
	}: {
		value: number;
		animateOnMount?: boolean;
		className?: string;
	}) => (
		<span
			className={className}
			data-animate-on-mount={String(animateOnMount)}
			data-testid={`number-ticker-${value}`}
		>
			{value}
		</span>
	),
}));

describe("ShinyFlash", () => {
	it("does not replay the same flash key after a virtualized row remounts", async () => {
		const flashKey = `row-remount:${Date.now()}`;

		const firstRender = render(
			<ShinyFlash active flashKey={flashKey}>
				file.ts
			</ShinyFlash>,
		);

		await waitFor(() =>
			expect(screen.getByText("file.ts")).toHaveClass("animate-shiny-text"),
		);

		firstRender.unmount();

		render(
			<ShinyFlash active flashKey={flashKey}>
				file.ts
			</ShinyFlash>,
		);

		expect(screen.getByText("file.ts")).not.toHaveClass("animate-shiny-text");
	});

	it("plays again when the flash key changes", async () => {
		cleanup();

		render(
			<ShinyFlash active flashKey={`new-change:${Date.now()}`}>
				file.ts
			</ShinyFlash>,
		);

		await waitFor(() =>
			expect(screen.getByText("file.ts")).toHaveClass("animate-shiny-text"),
		);
	});

	it("clears shimmer when the animation fallback expires", () => {
		cleanup();
		vi.useFakeTimers();

		try {
			render(
				<ShinyFlash active flashKey="animation-fallback">
					file.ts
				</ShinyFlash>,
			);
			expect(screen.getByText("file.ts")).toHaveClass("animate-shiny-text");

			act(() => {
				vi.advanceTimersByTime(3500);
			});

			expect(screen.getByText("file.ts")).not.toHaveClass("animate-shiny-text");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("LineStats", () => {
	it("does not replay number mount animation for the same line stats key after remount", () => {
		cleanup();
		const animationKey = `line-stats-remount:${Date.now()}`;

		const firstRender = render(
			<LineStats insertions={12} deletions={0} animationKey={animationKey} />,
		);

		expect(screen.getByTestId("number-ticker-12")).toHaveAttribute(
			"data-animate-on-mount",
			"true",
		);

		firstRender.unmount();

		render(
			<LineStats insertions={12} deletions={0} animationKey={animationKey} />,
		);

		expect(screen.getByTestId("number-ticker-12")).toHaveAttribute(
			"data-animate-on-mount",
			"false",
		);
	});

	it("plays number mount animation when the line stats key changes", () => {
		cleanup();

		render(
			<LineStats
				insertions={12}
				deletions={0}
				animationKey={`line-stats-new:${Date.now()}`}
			/>,
		);

		expect(screen.getByTestId("number-ticker-12")).toHaveAttribute(
			"data-animate-on-mount",
			"true",
		);
	});
});
