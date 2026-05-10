import { describe, expect, it } from "vitest";
import { generateBeamCSS } from "./styles";

const baseOptions = {
	id: "test",
	borderRadius: 16,
	borderWidth: 1,
	duration: 2.4,
	strokeOpacity: 0.72,
	innerOpacity: 0.7,
	bloomOpacity: 0.8,
	innerShadow: "rgba(255, 255, 255, 0.1)",
	size: "line" as const,
	colorVariant: "colorful" as const,
	staticColors: false,
	brightness: 1.3,
	saturation: 1.2,
	hueRange: 13,
	theme: "dark" as const,
	travelDirection: "normal" as const,
};

describe("border beam styles", () => {
	it("generates a right-edge-only line variant", () => {
		const css = generateBeamCSS({ ...baseOptions, side: "right" });

		expect(css).toContain("--beam-y-test");
		expect(css).toContain("at 100% calc(var(--beam-y-test) * 100%)");
		expect(css).not.toContain("--beam-x-test");
	});

	it("generates a top-edge-only line variant", () => {
		const css = generateBeamCSS({ ...baseOptions, side: "top" });

		expect(css).toContain("--beam-x-test");
		expect(css).toContain("at calc(var(--beam-x-test) * 100%) 0%");
		expect(css).toContain("calc(0% - 2px)");
		expect(css).not.toContain("--beam-y-test");
	});

	it("can alternate single-edge travel direction", () => {
		const css = generateBeamCSS({
			...baseOptions,
			side: "bottom",
			travelDirection: "alternate",
		});

		expect(css).toContain(
			"beam-travel-test 2.4s ease-in-out infinite alternate",
		);
		expect(css).not.toContain("beam-edge-fade-test 2.4s linear infinite");
	});
});
