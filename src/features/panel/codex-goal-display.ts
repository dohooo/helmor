import type { CodexGoalState } from "@/lib/api";

export function formatGoalElapsedSeconds(value: number): string {
	const seconds = Math.max(0, Math.trunc(value));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.trunc(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.trunc(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours >= 24) {
		const days = Math.trunc(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h ${remainingMinutes}m`;
	}

	if (remainingMinutes === 0) return `${hours}h`;
	return `${hours}h ${remainingMinutes}m`;
}

export function formatGoalTokens(value: number): string {
	const safeValue = Math.max(0, Math.trunc(value));
	if (safeValue === 0) return "0";
	if (safeValue < 1_000) return safeValue.toString();

	let scaled: number;
	let suffix: string;
	if (safeValue >= 1_000_000_000_000) {
		scaled = safeValue / 1_000_000_000_000;
		suffix = "T";
	} else if (safeValue >= 1_000_000_000) {
		scaled = safeValue / 1_000_000_000;
		suffix = "B";
	} else if (safeValue >= 1_000_000) {
		scaled = safeValue / 1_000_000;
		suffix = "M";
	} else {
		scaled = safeValue / 1_000;
		suffix = "K";
	}

	const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
	let formatted = scaled.toFixed(decimals);
	if (formatted.includes(".")) {
		formatted = formatted.replace(/0+$/, "").replace(/\.$/, "");
	}
	return `${formatted}${suffix}`;
}

export function goalStatusLabel(status: CodexGoalState["status"]): string {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "blocked":
			return "blocked";
		case "usageLimited":
			return "usage limited";
		case "budgetLimited":
			return "limited by budget";
		case "complete":
			return "complete";
	}
}

export function goalStatusIndicatorText(goal: CodexGoalState): string {
	switch (goal.status) {
		case "active":
			return `Pursuing goal (${activeGoalUsage(goal)})`;
		case "paused":
			return "Goal paused (/goal resume)";
		case "blocked":
			return "Goal blocked (/goal resume)";
		case "usageLimited":
			return "Goal hit usage limits (/goal resume)";
		case "budgetLimited":
			return budgetLimitedGoalText(goal);
		case "complete":
			return `Goal achieved (${completedGoalUsage(goal)})`;
	}
}

function activeGoalUsage(goal: CodexGoalState): string {
	if (goal.tokenBudget != null) {
		return `${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(
			goal.tokenBudget,
		)}`;
	}
	return formatGoalElapsedSeconds(goal.timeUsedSeconds);
}

function budgetLimitedGoalText(goal: CodexGoalState): string {
	if (goal.tokenBudget != null) {
		return `Goal unmet (${formatGoalTokens(goal.tokensUsed)} / ${formatGoalTokens(
			goal.tokenBudget,
		)} tokens)`;
	}
	return "Goal abandoned";
}

function completedGoalUsage(goal: CodexGoalState): string {
	if (goal.tokenBudget != null) {
		return `${formatGoalTokens(goal.tokensUsed)} tokens`;
	}
	return formatGoalElapsedSeconds(goal.timeUsedSeconds);
}
