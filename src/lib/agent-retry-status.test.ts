import { describe, expect, it } from "vitest";
import {
	clearAgentRetryStatus,
	getAgentRetryStatus,
	trackAgentRetryStatus,
} from "./agent-retry-status";

describe("agent-retry-status (R2-A transient footer state)", () => {
	it("retryStatus sets, any other stream event clears", () => {
		trackAgentRetryStatus("s1", {
			kind: "retryStatus",
			attempt: 2,
			maxRetries: 5,
		});
		expect(getAgentRetryStatus("s1")).toEqual({ attempt: 2, maxRetries: 5 });

		// A later retry updates in place.
		trackAgentRetryStatus("s1", {
			kind: "retryStatus",
			attempt: 4,
			maxRetries: 5,
		});
		expect(getAgentRetryStatus("s1")).toEqual({ attempt: 4, maxRetries: 5 });

		// Traffic = the retry resolved — transient status must clear.
		trackAgentRetryStatus("s1", { kind: "streamingPartial" });
		expect(getAgentRetryStatus("s1")).toBeNull();
	});

	it("is per-session and clearable", () => {
		trackAgentRetryStatus("a", {
			kind: "retryStatus",
			attempt: 1,
			maxRetries: 3,
		});
		trackAgentRetryStatus("b", {
			kind: "retryStatus",
			attempt: 2,
			maxRetries: 3,
		});
		clearAgentRetryStatus("a");
		expect(getAgentRetryStatus("a")).toBeNull();
		expect(getAgentRetryStatus("b")).toEqual({ attempt: 2, maxRetries: 3 });
		clearAgentRetryStatus("b");
	});
});
