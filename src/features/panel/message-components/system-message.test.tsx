import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SystemNoticePart } from "@/lib/api";
import {
	COMPACTED_LABEL,
	COMPACTING_LABEL,
	SystemNotice,
} from "./system-message";

afterEach(cleanup);

function notice(overrides: Partial<SystemNoticePart> = {}): SystemNoticePart {
	return {
		type: "system-notice",
		id: "sn-1",
		severity: "info",
		label: "Notice",
		...overrides,
	};
}

describe("SystemNotice — compact lifecycle", () => {
	it("renders the Compacting context label with a spinning loader icon", () => {
		const { container } = render(
			<SystemNotice part={notice({ label: COMPACTING_LABEL })} />,
		);
		expect(screen.getByText(COMPACTING_LABEL)).toBeInTheDocument();
		expect(container.querySelector(".lucide-loader-circle")).not.toBeNull();
		expect(container.querySelector(".animate-spin")).not.toBeNull();
	});

	it("renders the Context compacted label with a check icon (no spin)", () => {
		const { container } = render(
			<SystemNotice part={notice({ label: COMPACTED_LABEL })} />,
		);
		expect(screen.getByText(COMPACTED_LABEL)).toBeInTheDocument();
		expect(container.querySelector(".lucide-check")).not.toBeNull();
		expect(container.querySelector(".animate-spin")).toBeNull();
	});

	it("renders a plain info notice with the info icon", () => {
		const { container } = render(
			<SystemNotice
				part={notice({ label: "Context cleared", severity: "info" })}
			/>,
		);
		expect(container.querySelector(".lucide-info")).not.toBeNull();
		expect(container.querySelector(".lucide-loader-circle")).toBeNull();
		expect(container.querySelector(".lucide-check")).toBeNull();
	});
});
