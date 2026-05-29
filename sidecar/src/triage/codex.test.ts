import { describe, expect, it } from "bun:test";
import { parseCodexDecision } from "./codex";

describe("parseCodexDecision", () => {
	it("extracts proposals, skips, and summary from fenced JSON", () => {
		const parsed = parseCodexDecision(`Here is the decision:

\`\`\`json
{
  "proposals": [
    {
      "candidateId": "slack:C1",
      "taskAnchor": "1717000000.000100",
      "repoId": "repo-1",
      "title": "Fix login crash",
      "branchName": "fix-login-crash",
      "planMessage": "## Source\\nSlack report"
    }
  ],
  "skips": [
    { "candidateId": "gh:2", "reason": "The issue was already closed." }
  ],
  "summary": "One proposal, one skip."
}
\`\`\``);

		expect(parsed.proposals).toEqual([
			{
				candidateId: "slack:C1",
				taskAnchor: "1717000000.000100",
				repoId: "repo-1",
				title: "Fix login crash",
				branchName: "fix-login-crash",
				planMessage: "## Source\nSlack report",
			},
		]);
		expect(parsed.skips).toEqual([
			{ candidateId: "gh:2", reason: "The issue was already closed." },
		]);
		expect(parsed.summary).toBe("One proposal, one skip.");
	});

	it("drops malformed entries without rejecting the whole decision", () => {
		const parsed = parseCodexDecision(
			JSON.stringify({
				proposals: [{ candidateId: "missing-fields" }],
				skips: [{ candidateId: "slack:C1", reason: "No task remains." }],
			}),
		);

		expect(parsed.proposals).toEqual([]);
		expect(parsed.skips).toEqual([
			{ candidateId: "slack:C1", reason: "No task remains." },
		]);
		expect(parsed.summary).toBeNull();
	});
});
