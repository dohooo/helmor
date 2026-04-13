import { describe, expect, it } from "vitest";
import { buildPendingElicitation } from "./pending-elicitation";

describe("pending elicitation helpers", () => {
	it("falls back to the caller model id when the event modelId is missing", () => {
		const elicitation = buildPendingElicitation(
			{
				kind: "elicitationRequest",
				provider: "claude",
				modelId: "",
				resolvedModel: "opus-1m",
				sessionId: "provider-session-1",
				workingDirectory: "/tmp/helmor",
				elicitationId: "elicitation-1",
				serverName: "design-server",
				message: "Need more input",
				mode: "form",
				requestedSchema: {
					type: "object",
					properties: {},
				},
			},
			"opus-1m",
		);

		expect(elicitation).toEqual(
			expect.objectContaining({
				modelId: "opus-1m",
				elicitationId: "elicitation-1",
			}),
		);
	});

	it("returns null when elicitationId or model id is missing", () => {
		expect(
			buildPendingElicitation(
				{
					kind: "elicitationRequest",
					provider: "claude",
					modelId: "",
					resolvedModel: "opus-1m",
					sessionId: "provider-session-1",
					workingDirectory: "/tmp/helmor",
					elicitationId: "",
					serverName: "design-server",
					message: "Need more input",
					mode: "form",
					requestedSchema: {
						type: "object",
						properties: {},
					},
				},
				null,
			),
		).toBeNull();
	});
});
