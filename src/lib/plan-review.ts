import type { ThreadMessageLike } from "./api";

/** True when the last plan-review card has no user message after it. */
export function hasUnresolvedPlanReview(
	messages: ThreadMessageLike[],
): boolean {
	let lastPlanIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].content?.some((p) => p.type === "plan-review")) {
			lastPlanIdx = i;
			break;
		}
	}
	if (lastPlanIdx === -1) return false;
	for (let i = lastPlanIdx + 1; i < messages.length; i++) {
		if (messages[i].role === "user") return false;
	}
	return true;
}
