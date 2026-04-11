import { describe, expect, it } from "vitest";
import {
	buildComposerPreviewInsertItem,
	COMPOSER_PREVIEW_BADGE_THRESHOLD,
} from "./composer-insert";

describe("buildComposerPreviewInsertItem", () => {
	it("returns null for short content under the preview threshold", () => {
		expect(
			buildComposerPreviewInsertItem({
				content: "x".repeat(COMPOSER_PREVIEW_BADGE_THRESHOLD - 1),
			}),
		).toBeNull();
	});

	it("builds a code preview badge for long code-like content", () => {
		const longCode = "const failure = true;\n".repeat(12);

		expect(
			buildComposerPreviewInsertItem({
				content: longCode,
			}),
		).toEqual({
			kind: "custom-tag",
			label: "const failure = true;",
			submitText: longCode,
			preview: {
				kind: "code",
				title: "const failure = true;",
				language: "ts",
				code: longCode,
			},
		});
	});

	it("builds a text preview badge for long non-code content", () => {
		const longText =
			"This is a long plain-text note without code syntax. ".repeat(6);

		expect(
			buildComposerPreviewInsertItem({
				content: longText,
			}),
		).toEqual({
			kind: "custom-tag",
			label: "This is a long plain-text note without …",
			submitText: longText,
			preview: {
				kind: "text",
				title: "This is a long plain-text note without …",
				text: longText,
			},
		});
	});
});
