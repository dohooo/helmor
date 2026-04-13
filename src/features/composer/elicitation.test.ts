import { describe, expect, it } from "vitest";
import type { PendingElicitation } from "@/features/conversation/pending-elicitation";
import { normalizeElicitation } from "./elicitation";

function createFormElicitation(
	requestedSchema: Record<string, unknown>,
): PendingElicitation {
	return {
		provider: "claude",
		modelId: "opus-1m",
		resolvedModel: "opus-1m",
		providerSessionId: "provider-session-1",
		workingDirectory: "/tmp/helmor",
		elicitationId: "elicitation-form-1",
		serverName: "design-server",
		message: "Need structured input",
		mode: "form",
		requestedSchema,
	};
}

describe("normalizeElicitation", () => {
	it("normalizes supported form fields into a form view model", () => {
		const result = normalizeElicitation(
			createFormElicitation({
				type: "object",
				properties: {
					name: {
						type: "string",
						title: "Project name",
						description: "Used for the next step.",
					},
					approved: {
						type: "boolean",
						title: "Approved",
					},
					tags: {
						type: "array",
						items: {
							enum: ["sdk", "mcp"],
						},
						default: ["sdk"],
					},
				},
				required: ["name", "approved"],
			}),
		);

		expect(result).toEqual({
			kind: "form",
			elicitationId: "elicitation-form-1",
			serverName: "design-server",
			message: "Need structured input",
			fields: [
				{
					kind: "string",
					key: "name",
					label: "Project name",
					description: "Used for the next step.",
					required: true,
					format: null,
					minLength: null,
					maxLength: null,
					defaultValue: "",
				},
				{
					kind: "boolean",
					key: "approved",
					label: "Approved",
					description: "",
					required: true,
					defaultValue: null,
				},
				{
					kind: "multi-select",
					key: "tags",
					label: "tags",
					description: "",
					required: false,
					options: [
						{ value: "sdk", label: "sdk" },
						{ value: "mcp", label: "mcp" },
					],
					minItems: null,
					maxItems: null,
					defaultValue: ["sdk"],
				},
			],
		});
	});

	it("falls back to unsupported when a required field has an unsupported schema", () => {
		const result = normalizeElicitation(
			createFormElicitation({
				type: "object",
				properties: {
					name: { type: "string" },
					config: {
						type: "object",
						properties: {
							mode: { type: "string" },
						},
					},
				},
				required: ["name", "config"],
			}),
		);

		expect(result).toEqual({
			kind: "unsupported",
			elicitationId: "elicitation-form-1",
			serverName: "design-server",
			message: "Need structured input",
			reason: "Form schema contains unsupported required fields.",
		});
	});

	it("normalizes url elicitation and extracts the host when possible", () => {
		const result = normalizeElicitation({
			provider: "claude",
			modelId: "opus-1m",
			resolvedModel: "opus-1m",
			providerSessionId: "provider-session-1",
			workingDirectory: "/tmp/helmor",
			elicitationId: "elicitation-url-1",
			serverName: "auth-server",
			message: "Finish sign-in in the browser.",
			mode: "url",
			url: "https://example.com/authorize",
			requestedSchema: null,
		});

		expect(result).toEqual({
			kind: "url",
			elicitationId: "elicitation-url-1",
			serverName: "auth-server",
			message: "Finish sign-in in the browser.",
			url: "https://example.com/authorize",
			host: "example.com",
		});
	});
});
