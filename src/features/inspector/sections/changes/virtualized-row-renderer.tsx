import { isActiveEditorTarget } from "@/lib/editor-session";
import {
	ChangeFileRow,
	ChangeFolderRow,
	ChangeGroupHeaderRow,
	EmptyChangesRow,
	LoadingChangesRow,
} from "./change-row";
import type {
	ChangeGroupId,
	ChangeListCommonProps,
	ChangeListGroup,
	ChangeRow,
} from "./types";
import type { ChangePanelRow } from "./virtualized-row-model";

export function renderChangePanelRow({
	row,
	groupLookup,
	common,
	toggleFolder,
	animationsEnabled,
	interactionsEnabled,
}: {
	row: ChangePanelRow;
	groupLookup: Map<ChangeGroupId, ChangeListGroup>;
	common: ChangeListCommonProps;
	toggleFolder: (groupId: ChangeGroupId, path: string) => void;
	animationsEnabled: boolean;
	interactionsEnabled: boolean;
}) {
	switch (row.kind) {
		case "group-header":
			return <ChangeGroupHeaderRow group={row.group} />;
		case "loading":
			return <LoadingChangesRow />;
		case "empty":
			return <EmptyChangesRow />;
		case "tree-folder":
			return (
				<ChangeFolderRow
					name={row.node.name}
					path={row.node.path}
					depth={row.depth}
					open={row.isOpen}
					onToggle={(path) => toggleFolder(row.groupId, path)}
					interactionsEnabled={interactionsEnabled}
				/>
			);
		case "tree-file":
			return renderFileRow(
				row.file,
				row.depth,
				true,
				row.groupId,
				groupLookup,
				common,
				animationsEnabled,
				interactionsEnabled,
			);
		case "flat-file":
			return renderFileRow(
				row.file,
				0,
				false,
				row.groupId,
				groupLookup,
				common,
				animationsEnabled,
				interactionsEnabled,
			);
	}
}

function renderFileRow(
	file: ChangeRow,
	depth: number,
	tree: boolean,
	groupId: ChangeGroupId,
	groupLookup: Map<ChangeGroupId, ChangeListGroup>,
	common: ChangeListCommonProps,
	animationsEnabled: boolean,
	interactionsEnabled: boolean,
) {
	const group = groupLookup.get(groupId);
	if (!group) return null;
	const flashing = common.flashingPaths.has(file.path);
	const changeFlashKey = getChangeFlashKey(groupId, file);
	return (
		<ChangeFileRow
			file={file}
			depth={depth}
			tree={tree}
			editorMode={common.editorMode}
			active={isRowActive(file, group, common)}
			onOpen={(selectedFile) => openGroupFile(selectedFile, group, common)}
			onOpenExternalEditor={common.onOpenExternalEditor}
			flashing={flashing}
			flashKey={flashing ? changeFlashKey : undefined}
			lineStatsAnimationKey={getLineStatsAnimationKey(groupId, file)}
			animationsEnabled={animationsEnabled}
			interactionsEnabled={interactionsEnabled}
			action={group.action}
			onStageAction={group.onStageAction}
			onDiscard={group.onDiscard}
			workspaceBranch={common.workspaceBranch}
			workspaceRemoteUrl={common.workspaceRemoteUrl}
		/>
	);
}

function getLineStatsAnimationKey(groupId: ChangeGroupId, file: ChangeRow) {
	return [
		groupId,
		file.path,
		file.status,
		file.insertions,
		file.deletions,
	].join(":");
}

function getChangeFlashKey(groupId: ChangeGroupId, file: ChangeRow) {
	return [
		groupId,
		file.path,
		file.status,
		file.stagedStatus ?? "",
		file.stagedInsertions,
		file.stagedDeletions,
		file.unstagedStatus ?? "",
		file.unstagedInsertions,
		file.unstagedDeletions,
		file.committedStatus ?? "",
		file.committedInsertions,
		file.committedDeletions,
	].join(":");
}

function openGroupFile(
	file: ChangeRow,
	group: ChangeListGroup,
	common: ChangeListCommonProps,
) {
	common.onOpenEditorFile(file.absolutePath, {
		fileStatus: file.status,
		originalRef: group.originalRef,
		modifiedRef: group.modifiedRef,
	});
}

function isRowActive(
	file: ChangeRow,
	group: ChangeListGroup,
	common: ChangeListCommonProps,
) {
	return (
		isActiveEditorTarget(
			common.activeEditor,
			group.originalRef,
			group.modifiedRef,
		) && file.absolutePath === common.activeEditor?.path
	);
}
