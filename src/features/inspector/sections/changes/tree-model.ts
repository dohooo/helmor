import type { ChangeGroupId, ChangeRow } from "./types";

export type ChangeTreeNode = {
	name: string;
	path: string;
	children: ChangeTreeNode[];
	file?: ChangeRow;
};

export type TreeFolderRow = {
	kind: "tree-folder";
	groupId: ChangeGroupId;
	node: ChangeTreeNode;
	depth: number;
	isOpen: boolean;
};

export type TreeFileRow = {
	kind: "tree-file";
	groupId: ChangeGroupId;
	file: ChangeRow;
	depth: number;
};

type MutableTreeNode = {
	name: string;
	path: string;
	children: Map<string, MutableTreeNode>;
	file?: ChangeRow;
};

export function buildChangeTree(changes: ChangeRow[]): ChangeTreeNode {
	const root: MutableTreeNode = { name: "", path: "", children: new Map() };

	for (const change of changes) {
		const parts = change.path.split("/");
		let current = root;
		for (let index = 0; index < parts.length - 1; index += 1) {
			const part = parts[index];
			const childPath = parts.slice(0, index + 1).join("/");
			let child = current.children.get(part);
			if (!child) {
				child = {
					name: part,
					path: childPath,
					children: new Map(),
				};
				current.children.set(part, child);
			}
			current = child;
		}
		current.children.set(change.name, {
			name: change.name,
			path: change.path,
			children: new Map(),
			file: change,
		});
	}

	return freezeTree(root);
}

export function collectFolderPaths(node: ChangeTreeNode): string[] {
	const paths: string[] = [];
	for (const child of node.children) {
		if (!child.file && child.children.length > 0) {
			paths.push(child.path);
			paths.push(...collectFolderPaths(child));
		}
	}
	return paths;
}

export function flattenTreeRows(
	groupId: ChangeGroupId,
	node: ChangeTreeNode,
	expanded: Set<string>,
	depth = 0,
): Array<TreeFolderRow | TreeFileRow> {
	const rows: Array<TreeFolderRow | TreeFileRow> = [];

	for (const child of node.children) {
		if (!child.file && child.children.length > 0) {
			const isOpen = expanded.has(child.path);
			rows.push({ kind: "tree-folder", groupId, node: child, depth, isOpen });
			if (isOpen) {
				rows.push(...flattenTreeRows(groupId, child, expanded, depth + 1));
			}
			continue;
		}

		if (child.file) {
			rows.push({ kind: "tree-file", groupId, file: child.file, depth });
		}
	}

	return rows;
}

export function changePathSignature(changes: ChangeRow[]): string {
	return changes.map((change) => change.path).join("\n");
}

function freezeTree(node: MutableTreeNode): ChangeTreeNode {
	const children = [...node.children.values()]
		.map(freezeTree)
		.sort((left, right) => {
			const leftIsFolder = left.children.length > 0 && !left.file;
			const rightIsFolder = right.children.length > 0 && !right.file;
			if (leftIsFolder !== rightIsFolder) {
				return leftIsFolder ? -1 : 1;
			}
			return left.name.localeCompare(right.name);
		});

	return {
		name: node.name,
		path: node.path,
		children,
		file: node.file,
	};
}
