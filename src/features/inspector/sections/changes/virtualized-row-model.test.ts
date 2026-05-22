import { describe, expect, it } from "vitest";
import type { ChangeListGroup, ChangeRow } from "./types";
import { buildTreeData, createChangePanelRows } from "./virtualized-row-model";

const noop = () => {};

describe("virtualized row model", () => {
	it("builds tree data only for open tree-view groups", () => {
		const groups: ChangeListGroup[] = [
			makeGroup("staged", { open: false, treeView: true }),
			makeGroup("unstaged", { open: true, treeView: false }),
			makeGroup("branch", { open: true, treeView: true }),
		];

		const treeData = buildTreeData(groups);

		expect(treeData.has("staged")).toBe(false);
		expect(treeData.has("unstaged")).toBe(false);
		expect(treeData.has("branch")).toBe(true);
	});

	it("keeps flat rows renderable without tree data", () => {
		const groups: ChangeListGroup[] = [
			makeGroup("unstaged", { open: true, treeView: false }),
		];

		const rows = createChangePanelRows({
			groups,
			treeData: buildTreeData(groups),
			expansionByGroup: {},
		});

		expect(rows.map((row) => row.kind)).toEqual(["group-header", "flat-file"]);
	});
});

function makeGroup(
	id: ChangeListGroup["id"],
	patch: Partial<ChangeListGroup>,
): ChangeListGroup {
	return {
		id,
		label: id,
		count: 1,
		open: true,
		changes: [makeChange(`${id}/src/file.ts`)],
		treeView: true,
		onToggle: noop,
		onToggleTreeView: noop,
		...patch,
	};
}

function makeChange(path: string): ChangeRow {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		name,
		path,
		absolutePath: `/tmp/workspace/${path}`,
		status: "M",
		insertions: 1,
		deletions: 0,
		stagedStatus: null,
		unstagedStatus: "M",
		committedStatus: null,
		stagedInsertions: 0,
		stagedDeletions: 0,
		unstagedInsertions: 1,
		unstagedDeletions: 0,
		committedInsertions: 0,
		committedDeletions: 0,
		isBinary: false,
	};
}
