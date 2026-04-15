import { describe, expect, it } from "vitest";
import { helmorQueryKeys } from "./query-client";

describe("helmorQueryKeys.slashCommands", () => {
	it("ignores model id for claude keys", () => {
		expect(
			helmorQueryKeys.slashCommands("claude", "/tmp/workspace", "default"),
		).toEqual(
			helmorQueryKeys.slashCommands("claude", "/tmp/workspace", "opus-1m"),
		);
	});

	it("ignores model id for codex keys", () => {
		expect(
			helmorQueryKeys.slashCommands("codex", "/tmp/workspace", "gpt-5.4"),
		).toEqual(
			helmorQueryKeys.slashCommands("codex", "/tmp/workspace", "gpt-5"),
		);
	});
});
