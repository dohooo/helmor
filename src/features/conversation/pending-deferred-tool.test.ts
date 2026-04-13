import { describe, expect, it } from "vitest";
import {
	buildPendingDeferredTool,
	getDeferredToolResumeModelId,
} from "./pending-deferred-tool";

describe("pending deferred tool helpers", () => {
	it("falls back to the caller model id when the event modelId is missing", () => {
		const deferred = buildPendingDeferredTool(
			{
				kind: "deferredToolUse",
				provider: "claude",
				modelId: "",
				resolvedModel: "opus-1m",
				sessionId: "provider-session-1",
				workingDirectory: "/tmp/helmor",
				permissionMode: "plan",
				toolUseId: "tool-1",
				toolName: "AskUserQuestion",
				toolInput: { question: "Pick one" },
			},
			"opus-1m",
		);

		expect(deferred).toEqual(
			expect.objectContaining({
				modelId: "opus-1m",
				toolUseId: "tool-1",
			}),
		);
	});

	it("returns null when neither the event nor caller has a model id", () => {
		expect(
			buildPendingDeferredTool(
				{
					kind: "deferredToolUse",
					provider: "claude",
					modelId: "",
					resolvedModel: "opus-1m",
					sessionId: "provider-session-1",
					workingDirectory: "/tmp/helmor",
					permissionMode: "plan",
					toolUseId: "tool-1",
					toolName: "AskUserQuestion",
					toolInput: { question: "Pick one" },
				},
				null,
			),
		).toBeNull();
	});

	it("keeps the stored deferred model id for resume", () => {
		expect(
			getDeferredToolResumeModelId(
				{
					provider: "claude",
					modelId: "opus-1m",
					resolvedModel: "opus-1m",
					providerSessionId: "provider-session-1",
					workingDirectory: "/tmp/helmor",
					permissionMode: "plan",
					toolUseId: "tool-1",
					toolName: "AskUserQuestion",
					toolInput: { question: "Pick one" },
				},
				"gpt-5.4",
			),
		).toBe("opus-1m");
	});
});
