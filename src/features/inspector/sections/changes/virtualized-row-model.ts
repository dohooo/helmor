import {
	buildChangeTree,
	type ChangeTreeNode,
	changePathSignature,
	collectFolderPaths,
	flattenTreeRows,
	type TreeFileRow,
	type TreeFolderRow,
} from "./tree-model";
import type { ChangeGroupId, ChangeListGroup, ChangeRow } from "./types";

export type ExpansionEntry = {
	signature: string;
	expanded: Set<string>;
};

export type TreeDataEntry = {
	tree: ChangeTreeNode;
	signature: string;
	allFolders: Set<string>;
};

export type ChangePanelRow =
	| { kind: "group-header"; group: ChangeListGroup }
	| { kind: "loading"; groupId: ChangeGroupId }
	| { kind: "empty" }
	| TreeFolderRow
	| TreeFileRow
	| { kind: "flat-file"; groupId: ChangeGroupId; file: ChangeRow };

export function buildTreeData(groups: ChangeListGroup[]) {
	const next = new Map<ChangeGroupId, TreeDataEntry>();
	for (const group of groups) {
		if (!group.open || !group.treeView) {
			continue;
		}
		const tree = buildChangeTree(group.changes);
		next.set(group.id, {
			tree,
			signature: changePathSignature(group.changes),
			allFolders: new Set(collectFolderPaths(tree)),
		});
	}
	return next;
}

export function buildGroupLookup(groups: ChangeListGroup[]) {
	return new Map(groups.map((group) => [group.id, group]));
}

export function createChangePanelRows({
	groups,
	treeData,
	expansionByGroup,
}: {
	groups: ChangeListGroup[];
	treeData: Map<ChangeGroupId, TreeDataEntry>;
	expansionByGroup: Partial<Record<ChangeGroupId, ExpansionEntry>>;
}) {
	if (groups.length === 0) {
		return [{ kind: "empty" } satisfies ChangePanelRow];
	}

	const rows: ChangePanelRow[] = [];
	for (const group of groups) {
		rows.push({ kind: "group-header", group });
		if (!group.open) continue;

		if (group.loading && group.changes.length === 0) {
			rows.push({ kind: "loading", groupId: group.id });
			continue;
		}

		if (group.treeView) {
			const data = treeData.get(group.id);
			if (!data) continue;
			const expanded =
				expansionByGroup[group.id]?.signature === data.signature
					? expansionByGroup[group.id]?.expanded
					: data.allFolders;
			rows.push(
				...flattenTreeRows(group.id, data.tree, expanded ?? data.allFolders),
			);
			continue;
		}

		for (const file of group.changes) {
			rows.push({ kind: "flat-file", groupId: group.id, file });
		}
	}
	return rows;
}

export function estimateChangeRowHeight(row: ChangePanelRow | undefined) {
	switch (row?.kind) {
		case "group-header":
			return 24;
		case "empty":
			return 44;
		case "loading":
			return 32;
		default:
			return 21;
	}
}

export function getChangeRowKey(row: ChangePanelRow | undefined) {
	if (!row) return "__missing__";
	switch (row.kind) {
		case "group-header":
			return `group:${row.group.id}`;
		case "loading":
			return `loading:${row.groupId}`;
		case "empty":
			return "empty";
		case "tree-folder":
			return `folder:${row.groupId}:${row.node.path}`;
		case "tree-file":
			return `tree-file:${row.groupId}:${row.file.path}`;
		case "flat-file":
			return `flat-file:${row.groupId}:${row.file.path}`;
	}
}
