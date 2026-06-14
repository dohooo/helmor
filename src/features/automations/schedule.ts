import type { AutomationSchedule, AutomationStatus } from "@/lib/api";

export const WEEKDAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

const MONTH_NAMES = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

/** Wall-clock time used whenever a daily/weekly schedule needs a default. */
export const DEFAULT_TIME = "09:00";

/** Default interval for newly created automations: "Daily at 9:00 AM". */
export const DEFAULT_SCHEDULE: AutomationSchedule = {
	kind: "daily",
	time: DEFAULT_TIME,
};

/** "Hourly" / "Daily at 09:00" / "Weekly on Monday at 09:00" / "Every 15m". */
export function scheduleSummary(schedule: AutomationSchedule): string {
	switch (schedule.kind) {
		case "hourly":
			return "Hourly";
		case "daily":
			return `Daily at ${schedule.time}`;
		case "weekly":
			return `Weekly on ${WEEKDAY_NAMES[schedule.weekday] ?? "Sunday"} at ${schedule.time}`;
		case "every":
			return `Every ${schedule.amount}${schedule.unit === "minutes" ? "m" : "h"}`;
	}
}

/** Right-aligned list-row label: "Hourly" / "Daily" / "Weekly" / "Every 15m". */
export function scheduleShortLabel(schedule: AutomationSchedule): string {
	switch (schedule.kind) {
		case "hourly":
			return "Hourly";
		case "daily":
			return "Daily";
		case "weekly":
			return "Weekly";
		case "every":
			return scheduleSummary(schedule);
	}
}

function formatClockTime(date: Date): string {
	const hours24 = date.getHours();
	const hour12 = ((hours24 + 11) % 12) + 1;
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const meridiem = hours24 < 12 ? "AM" : "PM";
	return `${hour12}:${minutes} ${meridiem}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

/** "Today at 11:37 AM" / "Yesterday at 9:00 PM" / "Jun 12 at 8:15 AM" — all
 *  in the user's local timezone. Falls back to the raw input when the
 *  timestamp doesn't parse. */
export function formatRunTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const clock = formatClockTime(date);
	const now = new Date();
	if (isSameLocalDay(date, now)) return `Today at ${clock}`;
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (isSameLocalDay(date, yesterday)) return `Yesterday at ${clock}`;
	return `${MONTH_NAMES[date.getMonth()]} ${date.getDate()} at ${clock}`;
}

export function statusDotClass(status: AutomationStatus): string {
	return status === "active" ? "bg-emerald-500" : "bg-muted-foreground/40";
}

export function statusLabel(status: AutomationStatus): string {
	return status === "active" ? "Active" : "Paused";
}
