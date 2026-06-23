import { describe, expect, it } from "vitest";
import { buildSessionContextPrompt } from "./session-context-prompt";

describe("buildSessionContextPrompt", () => {
	it("returns null when no sessions are selected", () => {
		expect(buildSessionContextPrompt([])).toBeNull();
	});

	it("renders one CLI reading tag per selected session", () => {
		const prompt = buildSessionContextPrompt([
			{
				id: "session-1",
				workspaceId: "workspace-1",
				title: "Plan cache fix",
			},
			{
				id: "session-2",
				workspaceId: "workspace-1",
				title: "Review tests",
			},
		]);

		expect(prompt).toContain("<helmor-session-context>");
		expect(prompt).toContain(
			'<helmor-session-ref session-id="session-1" workspace-id="workspace-1" title="Plan cache fix">',
		);
		expect(prompt).toContain(
			'<helmor-session-ref session-id="session-2" workspace-id="workspace-1" title="Review tests">',
		);
		expect(prompt).toContain(
			"session get-messages session-1 --position tail --limit 12 --body-limit 2000 --json",
		);
		expect(prompt).toContain(
			"session get-messages session-1 --position head --limit 8 --body-limit 2000 --json",
		);
		expect(prompt).toContain(
			"session get-messages session-1 --position tail --limit 5 --body-limit 4000 --body-position end --json",
		);
		expect(prompt).toContain("windowHasMore");
		expect(prompt).toContain("bodyHasMore");
		expect(prompt).toContain("session get-messages --help");
		expect(prompt).toContain("Before giving a substantive answer");
		expect(prompt).toContain("Stop once you have enough context");
	});

	it("deduplicates sessions and escapes XML-sensitive title text", () => {
		const prompt = buildSessionContextPrompt([
			{
				id: "session-1",
				workspaceId: "workspace-1",
				title: 'Auth <fix> "final"',
			},
			{
				id: "session-1",
				workspaceId: "workspace-1",
				title: "Duplicate",
			},
		]);

		expect(prompt?.match(/<helmor-session-ref/g)).toHaveLength(1);
		expect(prompt).toContain('title="Auth &lt;fix&gt; &quot;final&quot;"');
		expect(prompt).toContain('prior session "Auth &lt;fix&gt; "final""');
	});
});
