import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
	type ShortcutHandler,
	useAppShortcuts,
} from "@/features/shortcuts/use-app-shortcuts";
import { createWorkspaceFile, createWorkspaceFolder } from "@/lib/api";
import { helmorQueryKeys } from "@/lib/query-client";
import { useSettings } from "@/lib/settings";

import { ExplorerHeader } from "./explorer-header";
import { useChangedPaths } from "./hooks/use-changed-paths";
import { useTreeState } from "./hooks/use-tree-state";
import { InlineCreateRow } from "./inline-create-row";
import { Tree } from "./tree";

interface OpenFileInput {
	absolutePath: string;
	relativePath: string;
	fileName: string;
}

interface Props {
	workspaceRootPath: string | null;
	workspaceId: string | null;
	activeAbsolutePath: string | null;
	onOpenFile: (input: OpenFileInput) => void;
}

type PendingCreate = { kind: "file" | "folder" } | null;

export function AllFilesPanel({
	workspaceRootPath,
	workspaceId,
	activeAbsolutePath,
	onOpenFile,
}: Props) {
	const { settings } = useSettings();
	const queryClient = useQueryClient();
	const { collapseAll } = useTreeState(workspaceId);
	const changedPaths = useChangedPaths(workspaceRootPath);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [pendingCreate, setPendingCreate] = useState<PendingCreate>(null);

	const invalidateAll = useCallback(() => {
		if (!workspaceRootPath) return Promise.resolve();
		return Promise.all([
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceChanges(workspaceRootPath),
			}),
			queryClient.invalidateQueries({
				queryKey: helmorQueryKeys.workspaceFiles(workspaceRootPath),
			}),
			queryClient.invalidateQueries({
				queryKey: ["workspaceDirectory", workspaceRootPath],
			}),
		]);
	}, [queryClient, workspaceRootPath]);

	const handleRefresh = useCallback(async () => {
		setIsRefreshing(true);
		try {
			await invalidateAll();
		} finally {
			setIsRefreshing(false);
		}
	}, [invalidateAll]);

	const handleCreateFile = useCallback(() => {
		setPendingCreate({ kind: "file" });
	}, []);
	const handleCreateFolder = useCallback(() => {
		setPendingCreate({ kind: "folder" });
	}, []);

	const handleSubmitCreate = useCallback(
		async (name: string) => {
			if (!workspaceRootPath || !pendingCreate) {
				setPendingCreate(null);
				return;
			}
			const kind = pendingCreate.kind;
			setPendingCreate(null);
			try {
				const result =
					kind === "file"
						? await createWorkspaceFile(workspaceRootPath, name)
						: await createWorkspaceFolder(workspaceRootPath, name);
				await invalidateAll();
				if (kind === "file") {
					const fileName = name.split("/").pop() ?? name;
					onOpenFile({
						absolutePath: result.absolutePath,
						relativePath: name,
						fileName,
					});
				}
			} catch (error) {
				toast.error(
					error instanceof Error ? error.message : `Failed to create ${kind}`,
				);
			}
		},
		[invalidateAll, onOpenFile, pendingCreate, workspaceRootPath],
	);

	const handlers = useMemo<ShortcutHandler[]>(
		() => [{ id: "fileBrowser.collapseAll", callback: collapseAll }],
		[collapseAll],
	);
	useAppShortcuts({ overrides: settings.shortcuts, handlers });

	return (
		<div
			className="flex h-full flex-col px-1 pt-0.5"
			data-focus-scope="fileBrowser"
		>
			<ExplorerHeader
				onCreateFile={handleCreateFile}
				onCreateFolder={handleCreateFolder}
				onRefresh={handleRefresh}
				onCollapseAll={collapseAll}
				isRefreshing={isRefreshing}
			/>
			<ScrollArea className="min-h-0 flex-1">
				{pendingCreate ? (
					<InlineCreateRow
						kind={pendingCreate.kind}
						onSubmit={handleSubmitCreate}
						onCancel={() => setPendingCreate(null)}
					/>
				) : null}
				<Tree
					workspaceRootPath={workspaceRootPath}
					workspaceId={workspaceId}
					onOpenFile={onOpenFile}
					activeAbsolutePath={activeAbsolutePath}
					changedPaths={changedPaths}
				/>
			</ScrollArea>
		</div>
	);
}
