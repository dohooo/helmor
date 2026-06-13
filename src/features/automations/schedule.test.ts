import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatRunTime,
	scheduleShortLabel,
	scheduleSummary,
	statusDotClass,
} from "./schedule";

describe("scheduleSummary", () => {
	it("formats hourly", () => {
		expect(scheduleSummary({ kind: "hourly" })).toBe("Hourly");
	});

	it("formats daily with the raw HH:MM time", () => {
		expect(scheduleSummary({ kind: "daily", time: "09:00" })).toBe(
			"Daily at 09:00",
		);
	});

	it("formats weekly with weekday name", () => {
		expect(scheduleSummary({ kind: "weekly", weekday: 1, time: "09:00" })).toBe(
			"Weekly on Monday at 09:00",
		);
	});

	it("formats custom minute intervals", () => {
		expect(
			scheduleSummary({ kind: "every", amount: 15, unit: "minutes" }),
		).toBe("Every 15m");
	});

	it("formats custom hour intervals", () => {
		expect(scheduleSummary({ kind: "every", amount: 2, unit: "hours" })).toBe(
			"Every 2h",
		);
	});
});

describe("scheduleShortLabel", () => {
	it("uses one-word labels for fixed cadences", () => {
		expect(scheduleShortLabel({ kind: "hourly" })).toBe("Hourly");
		expect(scheduleShortLabel({ kind: "daily", time: "09:00" })).toBe("Daily");
		expect(
			scheduleShortLabel({ kind: "weekly", weekday: 3, time: "12:30" }),
		).toBe("Weekly");
	});

	it("keeps the full summary for custom intervals", () => {
		expect(
			scheduleShortLabel({ kind: "every", amount: 45, unit: "minutes" }),
		).toBe("Every 45m");
	});
});

describe("formatRunTime", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Local-time constructor (no trailing Z) so the today/yesterday
		// boundaries are deterministic regardless of the host timezone.
		vi.setSystemTime(new Date(2026, 5, 11, 15, 0, 0));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("formats a same-day timestamp as Today", () => {
		const iso = new Date(2026, 5, 11, 11, 37, 0).toISOString();
		expect(formatRunTime(iso)).toBe("Today at 11:37 AM");
	});

	it("formats afternoon times with PM", () => {
		const iso = new Date(2026, 5, 11, 23, 5, 0).toISOString();
		expect(formatRunTime(iso)).toBe("Today at 11:05 PM");
	});

	it("formats midnight as 12:00 AM", () => {
		const iso = new Date(2026, 5, 11, 0, 0, 0).toISOString();
		expect(formatRunTime(iso)).toBe("Today at 12:00 AM");
	});

	it("formats the previous local day as Yesterday", () => {
		const iso = new Date(2026, 5, 10, 21, 0, 0).toISOString();
		expect(formatRunTime(iso)).toBe("Yesterday at 9:00 PM");
	});

	it("formats other days as 'Mon D at …'", () => {
		const iso = new Date(2026, 5, 12, 8, 15, 0).toISOString();
		expect(formatRunTime(iso)).toBe("Jun 12 at 8:15 AM");
	});

	it("falls back to the raw input when unparseable", () => {
		expect(formatRunTime("not-a-date")).toBe("not-a-date");
	});
});

describe("statusDotClass", () => {
	it("maps active to green and paused to gray", () => {
		expect(statusDotClass("active")).toContain("emerald");
		expect(statusDotClass("paused")).toContain("muted");
	});
});
