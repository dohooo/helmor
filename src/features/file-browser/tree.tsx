import { useQueryClient } from "@tanstack/react-query";

import { workspaceDirectoryQueryOptions } from "@/lib/query-client";
import type { ChangedPathsIndex } from "./hooks/use-changed-paths";
import { useDirectoryListing } from "./hooks/use-directory-listing";
import { useTreeState } from "./hooks/use-tree-state";
import { TreeRow } from "./tree-row";

interface OpenFileInput {
	absolutePath: string;
	relativePath: string;
	fileName: string;
}

interface Props {
	workspaceRootPath: string | null;
	workspaceId: string | null;
	onOpenFile: (input: OpenFileInput) => void;
	activeAbsolutePath: string | null;
	changedPaths: ChangedPathsIndex;
}

export function Tree({
	workspaceRootPath,
	workspaceId,
	onOpenFile,
	activeAbsolutePath,
	changedPaths,
}: Props) {
	return (
		<div className="flex flex-col">
			<DirectoryNode
				workspaceRootPath={workspaceRootPath}
				workspaceId={workspaceId}
				relativePath=""
				depth={0}
				onOpenFile={onOpenFile}
				activeAbsolutePath={activeAbsolutePath}
				changedPaths={changedPaths}
			/>
		</div>
	);
}

interface NodeProps {
	workspaceRootPath: string | null;
	workspaceId: string | null;
	relativePath: string;
	depth: number;
	onOpenFile: (input: OpenFileInput) => void;
	activeAbsolutePath: string | null;
	changedPaths: ChangedPathsIndex;
}

function DirectoryNode({
	workspaceRootPath,
	workspaceId,
	relativePath,
	depth,
	onOpenFile,
	activeAbsolutePath,
	changedPaths,
}: NodeProps) {
	const queryClient = useQueryClient();
	const { isExpanded, toggle } = useTreeState(workspaceId);
	const { data, isLoading } = useDirectoryListing(
		workspaceRootPath,
		relativePath,
	);

	if (isLoading) {
		return <Skeleton depth={depth} />;
	}
	if (!data) return null;

	return (
		<>
			{data.map((entry) => {
				const expanded = entry.kind === "directory" && isExpanded(entry.path);
				const changeStatus =
					entry.kind === "directory"
						? changedPaths.folders.get(entry.path)
						: changedPaths.files.get(entry.path);
				return (
					<div key={entry.absolutePath}>
						<TreeRow
							name={entry.name}
							kind={entry.kind}
							depth={depth}
							expanded={expanded}
							active={activeAbsolutePath === entry.absolutePath}
							changeStatus={changeStatus}
							onClick={async () => {
								if (entry.kind === "directory") {
									if (workspaceRootPath && !isExpanded(entry.path)) {
										await queryClient.prefetchQuery(
											workspaceDirectoryQueryOptions(
												workspaceRootPath,
												entry.path,
											),
										);
									}
									toggle(entry.path);
								} else {
									onOpenFile({
										absolutePath: entry.absolutePath,
										relativePath: entry.path,
										fileName: entry.name,
									});
								}
							}}
						/>
						{expanded && (
							<DirectoryNode
								workspaceRootPath={workspaceRootPath}
								workspaceId={workspaceId}
								relativePath={entry.path}
								depth={depth + 1}
								onOpenFile={onOpenFile}
								activeAbsolutePath={activeAbsolutePath}
								changedPaths={changedPaths}
							/>
						)}
					</div>
				);
			})}
		</>
	);
}

function Skeleton({ depth }: { depth: number }) {
	return (
		<div className="flex flex-col gap-1 py-1">
			{[0, 1, 2].map((i) => (
				<div
					key={i}
					className="h-3 animate-pulse rounded-sm bg-muted/40"
					style={{
						marginLeft: 6 + depth * 12,
						width: `${50 + ((i * 10) % 30)}%`,
					}}
				/>
			))}
		</div>
	);
}
