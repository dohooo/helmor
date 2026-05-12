import { describe, expect, it } from "vitest";
import type { SlashCommandEntry } from "@/lib/api";
import { filterCommands, rankCommand } from "./slash-command-plugin";

function command(name: string): SlashCommandEntry {
	return {
		name,
		description: `${name} command`,
		source: "builtin",
	};
}

describe("rankCommand", () => {
	it("scores literal prefix matches highest", () => {
		expect(rankCommand(command("add-dir"), "add")).toBe(5);
	});

	it("scores literal substring matches above normalized matches", () => {
		expect(rankCommand(command("open-add-dir"), "add")).toBe(4);
		expect(rankCommand(command("add-dir"), "addd")).toBe(3);
	});

	it("matches hyphenated names with separators omitted", () => {
		expect(rankCommand(command("add-dir"), "adddir")).toBe(3);
	});

	it("matches obvious typos as ordered fuzzy matches", () => {
		expect(rankCommand(command("add-dir"), "addir")).toBe(1);
		expect(rankCommand(command("add-dir"), "adir")).toBe(1);
	});

	it("returns 0 when the query cannot match in order", () => {
		expect(rankCommand(command("add-dir"), "zz")).toBe(0);
	});
});

describe("filterCommands", () => {
	const commands = [
		command("open-add-dir"),
		command("add-dir"),
		command("compact"),
		command("commit"),
	];

	it("keeps literal prefix and substring matches ahead of fuzzy matches", () => {
		const result = filterCommands(commands, "add");
		expect(result.map((entry) => entry.name)).toEqual([
			"add-dir",
			"open-add-dir",
		]);
	});

	it("suggests add-dir when the user types addd", () => {
		const result = filterCommands(commands, "addd");
		expect(result.map((entry) => entry.name)).toContain("add-dir");
	});

	it("preserves upstream order within the same rank bucket", () => {
		const result = filterCommands(commands, "co");
		expect(result.map((entry) => entry.name)).toEqual(["compact", "commit"]);
	});
});
